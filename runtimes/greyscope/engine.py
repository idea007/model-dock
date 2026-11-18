"""Offline Greyscope MLX inference with the official preprocessing and decoder."""

import hashlib
import json
import os
from pathlib import Path

from text_processing import ENGINE_ID, MAX_SEGMENTS, split_text, validate_text

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


class Detector:
    engine = ENGINE_ID

    def __init__(self, model_dir):
        import mlx.core as mx
        from greyscope.inference import decode_logits
        from greyscope.mlx_inference import _load_mlx
        from greyscope.preprocess import clean_text

        manifest = json.loads(Path(__file__).with_name("greyscope-model.json").read_text())
        directory = Path(model_dir)
        for name, expected in manifest["files"].items():
            with (directory / name).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    raise ValueError("TEXT_DETECTION_MODEL_CHECKSUM_INVALID")
        mx.set_default_device(mx.gpu)
        mx.set_cache_limit(256 * 1024**2)
        self.mx = mx
        self.model, self.tokenizer, self.calibration = _load_mlx(str(directory))
        self.decode = decode_logits
        self.clean_text = clean_text
        self.revision = manifest["revision"]
        self.limit = self.calibration["max_length"]
        self.predict("模型预热。")

    def encode(self, text, add_special_tokens=True):
        body = self.clean_text(text) if self.calibration["lowercase"] else text
        prompt = self.calibration["prompt_template"].format(text=body)
        return self.tokenizer.encode(prompt, add_special_tokens=False)

    def predict(self, text):
        ids = self.encode(text)
        if len(ids) > self.limit:
            raise ValueError("TEXT_DETECTION_TOKEN_LIMIT")
        raw = self.model(self.mx.array([ids]))
        self.mx.eval(raw)
        values = raw[0].tolist()
        result = self.decode(values, self.calibration, mode="ternary")
        binary = self.decode(values, self.calibration, mode="binary")
        return {"tokens": len(ids), "label": result["label"],
                "aiInvolvement": result["ai_involvement"], "bucketProbabilities": result["bucket_probs"],
                "binaryLabel": binary["label"]}

    def detect(self, text, cancelled=lambda: False):
        validate_text(text)
        ranges = list(split_text(text, self, self.limit))
        if len(ranges) > MAX_SEGMENTS:
            raise ValueError("TEXT_DETECTION_TOO_MANY_SEGMENTS")
        segments = []
        for start, end in ranges:
            if cancelled():
                raise ValueError("TEXT_DETECTION_CANCELLED")
            segments.append({"start": start, "end": end, **self.predict(text[start:end])})
        return {"protocol": "text-detection.result.v1", "engine": self.engine,
                "modelRevision": self.revision, "scoreType": "corn-involvement",
                "offsetUnit": "unicode-codepoint", "maxTokens": self.limit,
                "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "characters": len(text), "truncated": False, "segments": segments}
