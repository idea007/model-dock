"""Local MLX speech with private Qwen references and offline acoustic alignment."""

import argparse
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

from private_output import install_private_output

install_private_output()

# Ordinary startup must never install dependencies or download weights.
os.environ["HF_HUB_OFFLINE"] = "1"

import uvicorn
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from mlx_audio import server as upstream
from moss_pool import MossPool, PoolBusy
from word_timing import DEFAULT_ALIGNMENT_MODEL, WhisperWordTiming, narration_chunks

MAX_AUDIO_BYTES = 32 * 1024 * 1024
VOICES = {"zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang"}
app = upstream.app
aligner = None
moss_pool = MossPool(workers=int(os.environ.get("MODEL_DOCK_TTS_MOSS_WORKERS", "2")),
                     queue=int(os.environ.get("MODEL_DOCK_TTS_MOSS_QUEUE", "4")),
                     idle_seconds=float(os.environ.get("MODEL_DOCK_TTS_MOSS_IDLE_SECONDS", "60")))
moss_admitted = 0
MOSS_MODEL = "mlx-community/MOSS-TTS-Nano-100M"
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro-timing")
speech_lock = asyncio.Lock()
original_lifespan = app.router.lifespan_context
QWEN_MODELS = {"mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"}
DEFAULT_MODEL = os.environ.get("MODEL_DOCK_TTS_MODEL", "mlx-community/Kokoro-82M-8bit")


def qwen_snapshot(model):
    if model not in QWEN_MODELS:
        return None
    try:
        from huggingface_hub import snapshot_download
        root = Path(snapshot_download(model, local_files_only=True))
        return root if (root / "config.json").is_file() and any(root.glob("*.safetensors")) and any((root / "speech_tokenizer").glob("*.safetensors")) else None
    except Exception:
        return None


def moss_snapshot(model):
    if model != MOSS_MODEL:
        return None
    try:
        from huggingface_hub import snapshot_download
        roots = [Path(snapshot_download(name, local_files_only=True)) for name in
                 [MOSS_MODEL, "mlx-community/MOSS-Audio-Tokenizer-Nano"]]
        if not all((root / "config.json").is_file() and any(root.glob("*.safetensors")) for root in roots):
            return None
        revision = hashlib.sha1((": ".join(root.name for root in roots) + ":mlx-audio-0.4.6:moss-v1").encode()).hexdigest()
        return {"modelPath": str(roots[0]), "codecPath": str(roots[1]), "modelRevision": revision}
    except Exception:
        return None


def supported_model(model):
    return model in {"mlx-community/Kokoro-82M-8bit", "mlx-community/Kokoro-82M-4bit", "mlx-community/Kokoro-82M-bf16"}


@asynccontextmanager
async def lifespan(application):
    global aligner
    try:
        aligner = await asyncio.get_running_loop().run_in_executor(worker, WhisperWordTiming)
    except Exception:
        # Audio remains usable; capability discovery truthfully disables timing.
        print("Kokoro word alignment unavailable: cached alignment model is required", flush=True)
    async with original_lifespan(application):
        try:
            # The upstream model directory lists loaded models only. Warm the
            # configured Kokoro from the offline cache before serving discovery.
            # A missing optional model must not disable Edge, MOSS or Qwen.
            if supported_model(DEFAULT_MODEL):
                try:
                    await asyncio.get_running_loop().run_in_executor(worker, upstream.model_provider.load_model, DEFAULT_MODEL)
                except Exception as error:
                    print(f"Default Kokoro model unavailable: {type(error).__name__}", flush=True)
            yield
        finally:
            await moss_pool.close()
            worker.shutdown(wait=False, cancel_futures=True)


app.router.lifespan_context = lifespan


@app.get("/health")
async def health():
    ready = DEFAULT_MODEL in await upstream.model_provider.get_available_models()
    return {
        "provider": "mlx-audio",
        "model": DEFAULT_MODEL,
        "pid": os.getpid(),
        "runtimeId": os.environ.get("MODEL_DOCK_RUNTIME_ID"),
        "status": "ready" if ready else "not_loaded",
        "ready": ready,
        "wordTimingReady": aligner is not None,
    }


@app.get("/v1/audio/timing-capabilities")
def timing_capabilities(model: str):
    snapshot = qwen_snapshot(model)
    moss = moss_snapshot(model)
    return {"version": 1, "model": model, "wordTimestamps": aligner is not None and (supported_model(model) or snapshot is not None or moss is not None),
            **({"modelRevision": snapshot.name} if snapshot else {}),
            **({"modelRevision": moss["modelRevision"], "concurrency": moss_pool.stats()} if moss else {}),
            "method": "whisper-cross-attention-dtw", "alignmentModel": DEFAULT_ALIGNMENT_MODEL}


@app.post("/v1/audio/speech-with-timestamps")
async def speech_with_timestamps(payload: upstream.SpeechRequest, request: Request):
    speed = float(payload.speed if payload.speed is not None else 1)
    if not supported_model(payload.model) or payload.voice not in VOICES or payload.lang_code not in {"z", "zh"} or payload.response_format != "mp3" or payload.stream or payload.ref_audio or payload.ref_text:
        raise HTTPException(422, "unsupported_timed_speech")
    if not payload.input.strip() or len(payload.input) > 2000 or not math.isfinite(speed) or not .25 <= speed <= 4:
        raise HTTPException(422, "invalid_timed_speech")
    if aligner is None:
        raise HTTPException(503, "word_alignment_unavailable")
    async with speech_lock:
        try:
            result = await synthesize_aligned(payload, request, speed)
        except HTTPException:
            raise
        except (ValueError, subprocess.SubprocessError):
            raise HTTPException(422, "word_alignment_failed") from None
        except Exception as error:
            print(f"Timed speech failed: {type(error).__name__}", flush=True)
            raise HTTPException(502, "timed_speech_failed") from None
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/v1/audio/reference-speech")
async def reference_speech(request: Request):
    from qwen_reference import parse_reference_request, run_audio_command, reference_transport_status, reference_input_options

    status = reference_transport_status(request.headers)
    if status:
        raise HTTPException(status, "invalid_reference_transport")
    body = bytearray()
    async for part in request.stream():
        if len(body) + len(part) > 29 * 1024 * 1024:
            raise HTTPException(413, "reference_too_large")
        body.extend(part)
    try:
        values, reference = parse_reference_request(json.loads(body))
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, "invalid_reference_speech") from None
    snapshot = qwen_snapshot(values["model"])
    if snapshot is None or aligner is None:
        raise HTTPException(503, "reference_model_not_ready")
    if snapshot.name != values["modelRevision"]:
        raise HTTPException(409, "reference_model_changed")
    async with speech_lock:
        with tempfile.TemporaryDirectory(prefix="qwen-reference-") as directory:
            root = Path(directory)
            sample, normalized = root / "sample", root / "reference.wav"
            sample.write_bytes(reference)
            try:
                await run_audio_command([*reference_input_options(reference), "-i", str(sample), "-map", "0:a:0", "-t", "31", "-ac", "1", "-ar", "24000", str(normalized)], request)
                import soundfile as sf
                info = sf.info(normalized)
                if not 3 <= info.duration <= 30:
                    raise ValueError("invalid_reference_duration")
                payload = upstream.SpeechRequest(model=str(snapshot), input=values["input"],
                    voice=None, speed=values["speed"], lang_code="chinese", ref_audio=str(normalized),
                    ref_text=values["referenceText"], max_tokens=2048, repetition_penalty=1.1, response_format="mp3")
                result = await synthesize_aligned(payload, request, values["speed"])
            except HTTPException as error:
                if error.status_code == 499:
                    raise
                raise HTTPException(error.status_code, "reference_speech_failed") from None
            except Exception as error:
                print(f"Reference speech failed: {type(error).__name__}", flush=True)
                raise HTTPException(422 if isinstance(error, ValueError) else 502, "reference_speech_failed") from None
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.get("/v1/audio/moss-pool")
def moss_pool_status():
    return moss_pool.stats()


@app.post("/v1/audio/moss-reference-speech")
async def moss_reference_speech(request: Request):
    from qwen_reference import parse_reference_request, reference_transport_status
    global moss_admitted
    status = reference_transport_status(request.headers)
    if status:
        raise HTTPException(status, "invalid_reference_transport")
    if moss_admitted >= moss_pool.limit + moss_pool.queue_limit:
        raise HTTPException(429, "moss_queue_full", headers={"Retry-After": "5"})
    moss_admitted += 1
    try:
        body = bytearray()
        async for part in request.stream():
            if len(body) + len(part) > 29 * 1024 * 1024:
                raise HTTPException(413, "reference_too_large")
            body.extend(part)
        try:
            values, _reference = parse_reference_request(json.loads(body), models={MOSS_MODEL}, require_reference_text=False)
        except (ValueError, TypeError, KeyError):
            raise HTTPException(422, "invalid_reference_speech") from None
        snapshot = moss_snapshot(values["model"])
        if snapshot is None or aligner is None:
            raise HTTPException(503, "reference_model_not_ready")
        if snapshot["modelRevision"] != values["modelRevision"]:
            raise HTTPException(409, "reference_model_changed")
        try:
            result = await moss_pool.run({**values, **snapshot}, request.is_disconnected)
        except PoolBusy:
            raise HTTPException(429, "moss_queue_full", headers={"Retry-After": "5"}) from None
        except asyncio.CancelledError:
            raise HTTPException(499, "speech_cancelled") from None
        except TimeoutError:
            raise HTTPException(504, "moss_timeout") from None
        except Exception:
            raise HTTPException(502, "moss_synthesis_failed") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    finally:
        moss_admitted -= 1


async def synthesize_aligned(payload, request, speed):
    import numpy as np
    import soundfile as sf

    words, clips = [], []
    offset, total_bytes, sample_rate = 0.0, 0, None
    loop = asyncio.get_running_loop()
    with tempfile.TemporaryDirectory(prefix="kokoro-timing-") as directory:
        root = Path(directory)
        is_qwen = payload.ref_audio is not None and payload.ref_text is not None
        for index, text in enumerate(narration_chunks(payload.input, speed * .55 if is_qwen else speed)):
            if await request.is_disconnected():
                raise HTTPException(499, "speech_cancelled")
            source = payload.model_copy(update={"input": text, "response_format": "wav", "stream": False,
                                               **({"speed": 1.0} if is_qwen else {})})
            response = await upstream.tts_speech(source, request)
            data = bytearray()
            async for part in response.body_iterator:
                data.extend(part)
                total_bytes += len(part)
                if total_bytes > MAX_AUDIO_BYTES:
                    raise HTTPException(413, "speech_too_large")
            wav_path = root / f"{index}.wav"
            wav_path.write_bytes(data)
            if is_qwen and speed != 1:
                from qwen_reference import run_audio_command, tempo_filters
                adjusted = root / f"{index}-speed.wav"
                await run_audio_command(["-i", str(wav_path), "-af", tempo_filters(speed), str(adjusted)], request)
                wav_path = adjusted
            chunk_words = await loop.run_in_executor(worker, aligner.align, wav_path, text)
            audio, rate = sf.read(wav_path, dtype="float32")
            if sample_rate is not None and rate != sample_rate:
                raise ValueError("sample_rate_changed")
            sample_rate = rate
            clips.append(audio)
            words.extend({**word, "startSeconds": round(word["startSeconds"] + offset, 6),
                          "endSeconds": round(word["endSeconds"] + offset, 6)} for word in chunk_words)
            offset += len(audio) / sample_rate
        if await request.is_disconnected():
            raise HTTPException(499, "speech_cancelled")
        wav_path, mp3_path = root / "combined.wav", root / "combined.mp3"
        sf.write(wav_path, np.concatenate(clips), sample_rate)
        process = await asyncio.create_subprocess_exec("ffmpeg", "-y", "-v", "error", "-i", str(wav_path), "-c:a", "libmp3lame", "-q:a", "2", str(mp3_path), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(process.wait(), timeout=30)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode != 0:
            raise ValueError("encoding_failed")
        audio = mp3_path.read_bytes()
        if not audio or len(audio) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "speech_too_large")
        return {"version": 1, "audio": base64.b64encode(audio).decode("ascii"), "mimeType": "audio/mpeg", "words": words,
                "audioSha256": hashlib.sha256(audio).hexdigest(), "sourceText": payload.input, "durationSeconds": offset,
                "timingMethod": "whisper-cross-attention-dtw", "alignmentModel": aligner.model_id}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1", "localhost"])
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    uvicorn.run(app, host=args.host, port=args.port)
