#!/usr/bin/env python3
"""One offline inference. Process exit releases all unified GPU memory."""
import argparse
import base64
import contextlib
import fcntl
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

MODELS = json.loads(Path(__file__).with_name('models.json').read_text())['models']


def generate_unlocked(args, payload):
    import mlx.core as mx
    from PIL import Image, ImageOps
    from mflux.models.common.config import ModelConfig
    from mflux.callbacks.instances.memory_saver import MemorySaver

    mx.set_memory_limit(24 * 1024**3)
    mx.set_cache_limit(512 * 1024**2)
    started = time.monotonic()
    width, height = map(int, payload['size'].split('x'))
    model_id = payload['model']
    settings = MODELS[model_id]
    if payload['reference_images'] and 'reference' not in settings['modes']:
        raise ValueError('REFERENCE_INVALID')
    references = []
    Image.MAX_IMAGE_PIXELS = 25_000_000
    for index, ref in enumerate(payload['reference_images']):
        raw = base64.b64decode(ref.split(',', 1)[1], validate=True)
        with Image.open(io.BytesIO(raw)) as original:
            if original.width * original.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError('REFERENCE_INVALID')
            image = ImageOps.exif_transpose(original).convert('RGB')
            image.thumbnail((768, 768))
            destination = Path(args.output).with_name(f'reference-{index}.png')
            image.save(destination)
            references.append(str(destination))
    if model_id == 'z-image-turbo':
        from mflux.models.z_image import ZImageTurbo
        model = ZImageTurbo(model_path=args.model_root, model_config=ModelConfig.z_image_turbo())
    else:
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
        model_type = Flux2KleinEdit if references else Flux2Klein
        model = model_type(model_path=args.model_root, model_config=ModelConfig.flux2_klein_4b())
    model.callbacks.register(MemorySaver(model, keep_transformer=False, cache_limit_bytes=512 * 1024**2))
    image = model.generate_image(
        seed=payload['seed'], prompt=payload['prompt'], width=width, height=height,
        num_inference_steps=settings['steps'], guidance=settings['guidance'],
        **({'image_paths': references} if references else {}),
    )
    # Save pixels only: private prompts and machine metadata do not enter the PNG.
    image.image.save(args.output, format='PNG')
    return {'width': width, 'height': height, 'steps': settings['steps'], 'seed': payload['seed'],
            'seconds': round(time.monotonic() - started, 2),
            'peakMemoryBytes': mx.get_peak_memory()}


def generate(args, payload):
    lock_name = f"cursorblinking-mlx-generation-{os.getuid()}.lock"
    with open(Path(tempfile.gettempdir()) / lock_name, 'a', encoding='utf-8') as device_lock:
        fcntl.flock(device_lock, fcntl.LOCK_EX)
        return generate_unlocked(args, payload)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    try:
        payload = json.load(sys.stdin)
        with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            metadata = generate(args, payload)
        print(json.dumps(metadata))
    except Exception:
        print('LOCAL_IMAGE_INFERENCE_FAILED', file=sys.stderr)
        sys.exit(1)
