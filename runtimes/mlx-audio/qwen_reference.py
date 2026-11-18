"""Bounded private reference transport; this module never owns voice profiles."""

import asyncio
import base64
import binascii
import math
import re

QWEN_MODELS = {"mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"}


def reference_transport_status(headers):
    if headers.get("origin"):
        return 403
    if headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        return 415
    return 0


def parse_reference_request(values, models=QWEN_MODELS, require_reference_text=True):
    if not isinstance(values, dict) or set(values) != {"model", "modelRevision", "input", "voice", "speed", "referenceAudio", "referenceText"}:
        raise ValueError("invalid_fields")
    if values["model"] not in models:
        raise ValueError("invalid_model")
    if not isinstance(values["modelRevision"], str) or not re.fullmatch(r"[a-f0-9]{40}", values["modelRevision"]):
        raise ValueError("invalid_model_revision")
    for key, maximum in (("input", 3000), ("referenceText", 1000), ("voice", 120)):
        if not isinstance(values[key], str) or (not values[key].strip() and (key != "referenceText" or require_reference_text)) or len(values[key]) > maximum:
            raise ValueError("invalid_text")
    speed = values["speed"]
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not .25 <= speed <= 4:
        raise ValueError("invalid_speed")
    encoded = values["referenceAudio"]
    if not isinstance(encoded, str) or len(encoded) > 28 * 1024 * 1024:
        raise ValueError("invalid_audio")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("invalid_audio") from None
    if not audio or len(audio) > 20 * 1024 * 1024 or base64.b64encode(audio).decode("ascii") != encoded:
        raise ValueError("invalid_audio")
    return values, audio


def tempo_filters(speed):
    factors = []
    while speed < .5:
        factors.append("atempo=0.5")
        speed /= .5
    while speed > 2:
        factors.append("atempo=2")
        speed /= 2
    return ",".join([*factors, f"atempo={speed}"])


def reference_input_options(audio):
    if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        format_name = "wav"
    elif audio[:3] == b"ID3" or len(audio) > 2 and audio[0] == 255 and audio[1] & 224 == 224:
        format_name = "mp3"
    elif audio[4:8] == b"ftyp":
        format_name = "mov"
    else:
        raise ValueError("unsupported_reference_audio")
    # Force an audio container so uploaded bytes cannot become a playlist or URL.
    return ["-protocol_whitelist", "file,pipe", "-f", format_name, *(
        ["-enable_drefs", "0", "-use_absolute_path", "0"] if format_name == "mov" else [])]


async def run_audio_command(arguments, request):
    from fastapi import HTTPException

    process = await asyncio.create_subprocess_exec("ffmpeg", "-y", "-nostdin", "-v", "error", *arguments,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    completed = asyncio.create_task(process.wait())
    try:
        async with asyncio.timeout(30):
            while process.returncode is None:
                if await request.is_disconnected():
                    raise HTTPException(499, "speech_cancelled")
                try:
                    await asyncio.wait_for(asyncio.shield(completed), timeout=.2)
                except TimeoutError:
                    pass
        if process.returncode:
            raise ValueError("audio_conversion_failed")
    finally:
        if process.returncode is None:
            process.kill()
        await completed
