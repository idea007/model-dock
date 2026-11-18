#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from queue import Queue
from pathlib import Path

from private_output import install_private_output

install_private_output()
os.environ["HF_HUB_OFFLINE"] = "1"

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from miniaudio import DecodeError


MAX_UPLOAD_BYTES = 128 * 1024 * 1024
MAX_CONCURRENT_TRANSCRIPTIONS = 3
PCM_SAMPLE_RATE = 16_000
MAX_PCM_BYTES = 4 * 60 * 60 * PCM_SAMPLE_RATE * 2 + 1024
MODEL = "mlx-community/whisper-base-asr-fp16"
MODEL_ALIAS = "faster-whisper-base"
PORTABLE_MODEL_ALIAS = "local-whisper-base"
app = FastAPI()
model_instances = []
model_pool = Queue(maxsize=MAX_CONCURRENT_TRANSCRIPTIONS)


def create_model():
    from mlx_audio.stt.utils import load_model

    return load_model(MODEL)


def load_models():
    global model_instances
    # MLX streams belong to the thread that creates them. Keep each replica on
    # its own worker from startup through inference.
    replicas = []
    for _ in range(MAX_CONCURRENT_TRANSCRIPTIONS):
        worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-asr")
        model = worker.submit(create_model).result()
        replicas.append((model, worker))
    for replica in replicas:
        model_pool.put_nowait(replica)
    model_instances = replicas


@contextmanager
def acquire_model():
    if len(model_instances) != MAX_CONCURRENT_TRANSCRIPTIONS:
        raise HTTPException(status_code=503, detail="Local ASR is not ready")
    replica = model_pool.get()
    try:
        yield replica
    finally:
        model_pool.put_nowait(replica)


@contextmanager
def transcription_audio(source):
    with open(source, "rb") as stream:
        header = stream.read(12)
    if header[4:8] in {b"ftyp", b"moov", b"mdat", b"wide", b"free"}:
        container = ["-f", "mov", "-enable_drefs", "0"]
    elif header.startswith(bytes.fromhex("1a45dfa3")):
        container = ["-f", "matroska"]
    else:
        yield source
        return

    with tempfile.TemporaryDirectory(prefix="model-dock-asr-") as directory:
        audio = Path(directory) / "audio.wav"
        try:
            subprocess.run([
                "ffmpeg", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file",
                *container, "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn",
                "-ac", "1", "-ar", str(PCM_SAMPLE_RATE), "-c:a", "pcm_s16le",
                "-fs", str(MAX_PCM_BYTES), str(audio),
            ], check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            raise HTTPException(status_code=422, detail="Audio track could not be decoded") from None
        except OSError:
            raise HTTPException(status_code=503, detail="Local audio decoding is unavailable") from None
        if audio.stat().st_size >= MAX_PCM_BYTES:
            raise HTTPException(status_code=413, detail="Decoded audio is too long")
        yield str(audio)


@app.get("/health")
def health():
    ready = len(model_instances) == MAX_CONCURRENT_TRANSCRIPTIONS and shutil.which("ffmpeg") is not None
    return {
        "model": MODEL,
        "provider": "mlx-audio",
        "pid": os.getpid(),
        "runtimeId": os.environ.get("MODEL_DOCK_RUNTIME_ID"),
        "status": "ready" if ready else "unavailable",
        "ready": ready,
        "concurrency": MAX_CONCURRENT_TRANSCRIPTIONS,
    }


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...),
    model: str = Form(...),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    timestamp_granularities: list[str] = Form([], alias="timestamp_granularities[]"),
):
    if model not in {MODEL_ALIAS, PORTABLE_MODEL_ALIAS, "whisper-1", MODEL}:
        raise HTTPException(status_code=422, detail="Unsupported local ASR model")
    suffix = Path(file.filename or "audio.mp3").suffix[:12] or ".mp3"
    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as target:
            temporary_path = target.name
            total = 0
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Audio input is too large")
                target.write(chunk)
        if not total:
            raise HTTPException(status_code=422, detail="Audio input is empty")

        word_timestamps = "word" in timestamp_granularities
        with acquire_model() as (worker_model, worker), transcription_audio(temporary_path) as audio_path:
            result = worker.submit(
                worker_model.generate,
                audio_path,
                language=language or None,
                verbose=False,
                temperature=0.0,
                condition_on_previous_text=False,
                word_timestamps=word_timestamps,
                # Whisper can decode a new, empty tail after word alignment.
                # Use its native silence filter rather than inventing times.
                hallucination_silence_threshold=1.0 if word_timestamps else None,
            ).result()
            segments = normalize_mlx_segments(
                getattr(result, "segments", [])
            )
            text = str(getattr(result, "text", "")).strip()
            duration = max(
                [segment["end"] for segment in segments],
                default=0.0,
            )
            detected_language = str(
                getattr(result, "language", language or "") or ""
            )
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "json":
            return JSONResponse({"text": text})
        if response_format != "verbose_json":
            raise HTTPException(status_code=422, detail="Unsupported response format")
        return JSONResponse({
            "duration": duration,
            "language": detected_language,
            "segments": segments,
            "text": text,
            "words": [word for segment in segments for word in segment.get("words", [])],
        })
    except DecodeError:
        raise HTTPException(status_code=422, detail="Unsupported audio format") from None
    finally:
        if temporary_path:
            try:
                os.remove(temporary_path)
            except FileNotFoundError:
                pass


def normalize_mlx_segments(value):
    segments = []
    for segment in value if isinstance(value, list) else []:
        if not isinstance(segment, dict):
            continue
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        segments.append({
            "end": float(segment.get("end", segment.get("end_time", 0)) or 0),
            "start": float(
                segment.get("start", segment.get("start_time", 0)) or 0
            ),
            "text": text,
            "words": [word for word in (segment.get("words") or []) if isinstance(word, dict)],
        })
    return segments


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7732)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    load_models()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
