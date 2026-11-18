#!/usr/bin/env python3
"""One durable, offline LTX distilled inference for Apple Silicon."""
import argparse
import fcntl
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time

os.environ.update(
    HF_HUB_OFFLINE="1",
    TRANSFORMERS_OFFLINE="1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN="1",
    HF_HUB_DISABLE_TELEMETRY="1",
    LTX2_DIT_EVAL_EVERY="1",
    LTX2_GEMMA_EVAL_EVERY="1",
)


def deny_network(event, _args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise RuntimeError("NETWORK_DISABLED")


sys.addaudithook(deny_network)


def atomic_write(file, value):
    temporary = file.with_suffix(file.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(file)


def files_ready(root, files):
    return all((root / name).is_file() and (root / name).stat().st_size == size
               for name, size in files.items())


def preflight(model_id, model_dir, gemma_dir, model, runtime):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("PLATFORM_UNSUPPORTED")
    if not files_ready(model_dir, model["requiredFiles"]):
        raise RuntimeError("MODEL_FILES_INVALID")
    if not model["bundledTextEncoder"]:
        gemma_files = {
            "config.json": 1141,
            "model-00001-of-00002.safetensors": 5367455313,
            "model-00002-of-00002.safetensors": 2661219935,
            "model.safetensors.index.json": 108605,
            "tokenizer.json": 33384568,
        }
        if not files_ready(gemma_dir, gemma_files):
            raise RuntimeError("TEXT_ENCODER_FILES_INVALID")
    quant = json.loads((model_dir / "quantize_config.json").read_text())
    if quant.get("quantization", {}).get("bits") != 4:
        raise RuntimeError("MODEL_QUANTIZATION_INVALID")
    embedded = json.loads((model_dir / "embedded_config.json").read_text())
    if model_id == "ltx-2.5-fast-q4" and embedded.get("model_version") != "2.5.0":
        raise RuntimeError("MODEL_VERSION_INVALID")
    installed = {package: version(package) for package in runtime["software"]}
    if installed != runtime["software"]:
        raise RuntimeError("RUNTIME_PACKAGES_INVALID")
    import mlx.core as mx
    import ltx_pipelines_mlx
    repository = next((item for item in Path(ltx_pipelines_mlx.__file__).resolve().parents
                       if (item / ".git").exists()), None)
    if repository is None:
        raise RuntimeError("RUNTIME_SOURCE_INVALID")
    revision = subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True,
        stderr=subprocess.DEVNULL).strip()
    if revision != runtime["runtimeRevision"]:
        raise RuntimeError("RUNTIME_REVISION_INVALID")
    clean = subprocess.run(
        ["git", "-C", str(repository), "diff", "--quiet", "HEAD", "--",
         "packages/ltx-core-mlx", "packages/ltx-pipelines-mlx"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not clean or not mx.metal.is_available():
        raise RuntimeError("RUNTIME_NOT_READY")
    return {"model": model_id, "network": "disabled", "ready": True}


def inspect_video(file, request):
    output = subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(file)
    ], text=True, timeout=60, stderr=subprocess.DEVNULL)
    streams = json.loads(output).get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if (not video or video.get("width") != request["width"] or
            video.get("height") != request["height"] or
            int(video.get("nb_read_frames", 0)) != request["num_frames"] or
            video.get("avg_frame_rate") != f'{request["fps"]}/1' or
            any(stream.get("codec_type") == "audio" for stream in streams)):
        raise RuntimeError("RESULT_INVALID")


def generate(job_file):
    job = json.loads(job_file.read_text())
    run_dir = job_file.parent
    status_file = run_dir / "status.json"
    request = job["request"]
    model = job["model"]
    model_settings = job["modelSettings"]
    started = time.monotonic()
    state = {
        "id": job["id"], "model": model, "phase": "queued",
        "pid": os.getpid(), "status": "queued"
    }

    def save(**changes):
        state.update(changes)
        state["elapsedSeconds"] = round(time.monotonic() - started, 3)
        atomic_write(status_file, state)

    def stop(_signum, _frame):
        raise InterruptedError("CANCELLED")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    save()
    try:
        # Share the device lock with the legacy LTX runtime during cutover.
        lock_name = f"cursorblinking-mlx-generation-{os.getuid()}.lock"
        with open(Path(tempfile.gettempdir()) / lock_name, "a", encoding="utf-8") as device_lock:
            fcntl.flock(device_lock, fcntl.LOCK_EX)
            current = json.loads(status_file.read_text())
            if current.get("status") == "cancelled":
                return 0
            model_dir = Path(job["runtime"]["modelDir"])
            gemma_dir = Path(job["runtime"]["gemmaDir"])
            preflight(model, model_dir, gemma_dir, model_settings, job["runtime"])
            save(phase="inference", status="running")
            import mlx.core as mx
            from ltx_pipelines_mlx.distilled import DistilledPipeline
            from ltx_pipelines_mlx.utils.args import ImageConditioningInput
            if model == "ltx-2.5-fast-q4":
                from local_video_memory import install
                install()
            mx.set_memory_limit(25 * 2**30)
            mx.set_cache_limit(512 * 2**20)
            mx.reset_peak_memory()
            arguments = {
                "model_dir": str(model_dir),
                "low_memory": True,
                "low_ram_streaming": False,
            }
            if not model_settings["bundledTextEncoder"]:
                arguments["gemma_model_id"] = str(gemma_dir)
            pipeline = DistilledPipeline(**arguments)
            pipeline.verbose = False
            pipeline.generate_audio = False
            images = [ImageConditioningInput(
                path=str(Path(item)), frame_idx=0, strength=1.0, crf=33
            ) for item in request.get("reference_images", [])]
            output = run_dir / "result.mp4"
            pipeline.generate_and_save(
                prompt=request["prompt"], output_path=str(output),
                width=request["width"], height=request["height"],
                num_frames=request["num_frames"], frame_rate=request["fps"],
                seed=request["seed"], stage1_steps=8, stage2_steps=3,
                images=images or None,
            )
            mx.synchronize()
            inspect_video(output, request)
            save(phase="complete", status="succeeded")
    except InterruptedError:
        save(errorCode="CANCELLED", phase="cancelled", status="cancelled")
        return 0
    except MemoryError:
        save(errorCode="OUT_OF_MEMORY", phase="failed", status="failed")
        return 1
    except BaseException as error:
        code = str(error)
        allowed = {
            "MODEL_FILES_INVALID", "MODEL_QUANTIZATION_INVALID", "MODEL_VERSION_INVALID",
            "NETWORK_DISABLED", "RESULT_INVALID", "RUNTIME_NOT_READY",
            "RUNTIME_PACKAGES_INVALID", "RUNTIME_REVISION_INVALID",
            "RUNTIME_SOURCE_INVALID", "TEXT_ENCODER_FILES_INVALID"
        }
        save(errorCode=code if code in allowed else "INFERENCE_FAILED",
             phase="failed", status="failed")
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--doctor", action="store_true")
    mode.add_argument("--job", type=Path)
    parser.add_argument("--model-id")
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--gemma-dir", type=Path)
    args = parser.parse_args()
    if args.doctor:
        registry_file = Path(__file__).with_name("models.json")
        registry = json.loads(registry_file.read_text())
        try:
            result = preflight(args.model_id, args.model_dir, args.gemma_dir,
                               registry["models"][args.model_id], {
                                   "runtimeRevision": registry["runtimeRevision"],
                                   "software": registry["software"],
                               })
            print(json.dumps(result, ensure_ascii=False))
        except Exception:
            print(json.dumps({"model": args.model_id, "ready": False}))
            sys.exit(1)
    else:
        job = json.loads(args.job.read_text())
        registry_file = Path(__file__).with_name("models.json")
        try:
            registry = json.loads(registry_file.read_text())
        except OSError:
            # The server snapshots executable Python, while the immutable model
            # contract needed by the job is embedded before process creation.
            registry = None
        job["modelSettings"] = (registry or {"models": {}}).get("models", {}).get(job["model"], job.get("modelSettings"))
        atomic_write(args.job, job)
        sys.exit(generate(args.job.resolve()))
