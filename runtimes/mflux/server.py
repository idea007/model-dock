#!/usr/bin/env python3
"""Loopback-only transport; each inference gets a disposable GPU process."""
import argparse
import asyncio
import base64
import hmac
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

REGISTRY = json.loads(Path(__file__).with_name('models.json').read_text())
MODELS = REGISTRY['models']
MODEL = REGISTRY['defaultModel']
MAX_REQUEST_BYTES = 15 * 1024 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
SIZES = {'1024x576', '1024x1024', '768x960', '768x768'}


def failure(code, status):
    return JSONResponse({'error': {'code': code}}, status_code=status)


class LoopbackAuthMiddleware:
    """Keep the ASGI receive channel intact so inference sees disconnects."""
    def __init__(self, app, token, port):
        self.app, self.token, self.port = app, token, port

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http':
            headers = Request(scope).headers
            if headers.get('host') != f'127.0.0.1:{self.port}' or headers.get('origin'):
                await failure('ORIGIN_FORBIDDEN', 403)(scope, receive, send)
                return
            if not hmac.compare_digest(headers.get('authorization', ''), f'Bearer {self.token}'):
                await failure('AUTH_REQUIRED', 401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def validate_payload(value):
    if not isinstance(value, dict) or set(value) - {
        'model', 'prompt', 'size', 'n', 'response_format', 'reference_images', 'seed'
    }:
        raise ValueError('INVALID_REQUEST')
    if not isinstance(value.get('model'), str) or value['model'] not in MODELS:
        raise ValueError('MODEL_UNSUPPORTED')
    prompt = value.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise ValueError('PROMPT_INVALID')
    if value.get('size') not in SIZES or value.get('n', 1) != 1:
        raise ValueError('SIZE_INVALID')
    if value.get('response_format', 'b64_json') != 'b64_json':
        raise ValueError('FORMAT_INVALID')
    seed = value.get('seed', secrets.randbelow(2**32))
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError('SEED_INVALID')
    refs = value.get('reference_images', [])
    maximum = MODELS[value['model']].get(
        'maxReferenceImages', 1 if 'reference' in MODELS[value['model']]['modes'] else 0)
    if not isinstance(refs, list) or len(refs) > maximum:
        raise ValueError('REFERENCE_INVALID')
    for ref in refs:
        if not isinstance(ref, str) or not ref.startswith((
            'data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,'
        )):
            raise ValueError('REFERENCE_INVALID')
        try:
            raw = base64.b64decode(ref.split(',', 1)[1], validate=True)
        except Exception:
            raise ValueError('REFERENCE_INVALID') from None
        if not raw or len(raw) > 10 * 1024 * 1024:
            raise ValueError('REFERENCE_INVALID')
    return {**value, 'prompt': prompt.strip(), 'seed': seed, 'reference_images': refs}


async def run_inference(payload, root, request):
    with tempfile.TemporaryDirectory(prefix='local-mflux-') as directory:
        target = Path(directory) / 'result.png'
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name('worker.py')),
            '--model-root', str(root), '--output', str(target),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        communication = asyncio.create_task(process.communicate(json.dumps(payload).encode()))
        deadline = time.monotonic() + 540
        try:
            while not communication.done():
                await asyncio.wait({communication}, timeout=0.5)
                if await request.is_disconnected():
                    raise ValueError('CANCELLED')
                if time.monotonic() > deadline:
                    raise ValueError('TIMEOUT')
            stdout, _ = await communication
            if process.returncode != 0:
                raise ValueError('INFERENCE_FAILED')
            metadata = json.loads(stdout)
            if not target.is_file() or not 0 < target.stat().st_size <= MAX_RESULT_BYTES:
                raise ValueError('RESULT_INVALID')
            result = target.read_bytes()
            if not result.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('RESULT_INVALID')
            return {
                'created': int(time.time()), 'model': payload['model'],
                'data': [{'b64_json': base64.b64encode(result).decode()}],
                'usage': {'generated_images': 1},
                'metadata': metadata,
            }
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
            if not communication.done():
                communication.cancel()
            await asyncio.gather(communication, return_exceptions=True)


def create_app(token, models_root, port, runner=run_inference, workspace_id=''):
    if not token or len(token) < 32:
        raise ValueError('LOCAL_IMAGE_TOKEN_REQUIRED')
    root = Path(models_root)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LoopbackAuthMiddleware, token=token, port=port)
    lock = asyncio.Lock()
    pending = 0

    def model_path(model):
        return root / MODELS[model]['directory']

    def ready(model):
        location = model_path(model)
        try:
            return (location / '.ready').read_text().strip() == MODELS[model]['revision'] and all(
                (location / name).is_file() for name in REGISTRY['requiredFiles']
            )
        except OSError:
            return False

    @app.get('/health')
    @app.get('/v1/models')
    async def health():
        models = [{'id': model, 'revision': value['revision'], 'status': 'ready', 'modes': value['modes'],
                   'maxReferenceImages': value.get('maxReferenceImages', 0), 'sizes': sorted(SIZES)}
                  for model, value in MODELS.items() if ready(model)]
        if not models:
            return failure('MODEL_NOT_READY', 503)
        return {'provider': 'local-mflux', 'protocolVersion': REGISTRY['protocolVersion'],
                'status': 'ready', 'busy': lock.locked(), 'pending': pending,
                'workspaceId': workspace_id, 'pid': os.getpid(), 'data': models}

    @app.get('/v1/manifest')
    async def manifest():
        return {
            'protocol': 'cursorblinking-provider',
            'protocolVersion': 1,
            'service': {
                'id': 'cursorblinking.mflux',
                'name': 'Cursor Blinking MFLUX',
                'version': '1.0.0',
            },
            'capabilities': [{
                'id': 'image.generate',
                'models': [{
                    'id': model,
                    'label': value['label'],
                    'inputModes': [
                        'reference_image' if mode == 'reference' else mode
                        for mode in value['modes']
                    ],
                    'maxReferenceImages': value.get('maxReferenceImages', 0),
                    'outputMimeTypes': ['image/png'],
                    'promptMaxLength': 4000,
                    'sizes': sorted(SIZES),
                } for model, value in MODELS.items()],
            }],
        }

    @app.post('/v1/images/generations')
    async def generate(request: Request):
        nonlocal pending
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            return failure('CONTENT_TYPE_INVALID', 415)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_REQUEST_BYTES:
                return failure('REQUEST_TOO_LARGE', 413)
        try:
            payload = validate_payload(json.loads(raw))
        except (ValueError, TypeError, UnicodeDecodeError):
            return failure('REQUEST_INVALID', 422)
        if not ready(payload['model']):
            return failure('MODEL_NOT_READY', 503)
        # Durable jobs remain in the application; at most four active calls may
        # wait here for the one GPU slot. Disconnected calls never start a worker.
        if pending >= 4:
            return failure('BUSY', 429)
        pending += 1
        deadline = time.monotonic() + 540
        try:
            while lock.locked():
                if await request.is_disconnected():
                    return failure('CANCELLED', 499)
                if time.monotonic() > deadline:
                    return failure('BUSY', 429)
                await asyncio.sleep(0.25)
            async with lock:
                try:
                    return await runner(payload, model_path(payload['model']), request)
                except ValueError as error:
                    code = str(error) if str(error) in {'CANCELLED', 'TIMEOUT', 'RESULT_INVALID'} else 'INFERENCE_FAILED'
                    return failure(code, 504 if code == 'TIMEOUT' else 502)
                except Exception:
                    return failure('INFERENCE_FAILED', 502)
        finally:
            pending -= 1

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--workspace-id', required=True)
    args = parser.parse_args()
    os.environ.update({
        'HF_HOME': str(args.runtime_dir / 'huggingface'),
        'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
        'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1',
        'TOKENIZERS_PARALLELISM': 'false',
    })
    token = (args.runtime_dir / 'service-token').read_text().strip()
    application = create_app(token, args.runtime_dir / 'models', args.port, workspace_id=args.workspace_id)
    uvicorn.run(application, host='127.0.0.1', port=args.port, access_log=False, log_level='warning',
                timeout_graceful_shutdown=20)
