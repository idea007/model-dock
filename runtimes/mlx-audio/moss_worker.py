"""Private line protocol. Never serves HTTP or owns business voice profiles."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
protocol_output = sys.stdout
# Library progress output must never corrupt the private result protocol.
sys.stdout = sys.stderr


def audio_command(arguments):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-nostdin", *arguments], check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


class Engine:
    def __init__(self):
        self.revision = None

    def synthesize(self, values):
        import mlx.core as mx
        import numpy as np
        import soundfile as sf
        from mlx_audio.tts.utils import load_model
        from mlx_audio.codec import MossAudioTokenizer
        from qwen_reference import reference_input_options, tempo_filters
        from word_timing import DEFAULT_ALIGNMENT_MODEL, WhisperWordTiming, narration_chunks

        mx.set_cache_limit(128 * 1024 * 1024)
        if self.revision != values["modelRevision"]:
            self.model = load_model(values["modelPath"])
            self.model.audio_tokenizer = MossAudioTokenizer.from_pretrained(values["codecPath"])
            self.aligner = WhisperWordTiming()
            self.revision = values["modelRevision"]
        audio = base64.b64decode(values["referenceAudio"], validate=True)
        # The gateway removes these files even when this process is cancelled.
        root = Path(values["workDirectory"])
        sample, reference = root / "sample", root / "reference.wav"
        sample.write_bytes(audio)
        audio_command([*reference_input_options(audio), "-i", str(sample), "-map", "0:a:0", "-t", "31", "-ac", "1", "-ar", "48000", str(reference)])
        if not 3 <= sf.info(reference).duration <= 30:
            raise ValueError("invalid_reference_duration")
        # Encode the reference once for all chunks of this request.
        prompt = self.model.encode_reference_audio(str(reference))
        clips, words, offset = [], [], 0.0
        for index, text in enumerate(narration_chunks(values["input"], values["speed"] * .55)):
            generated = list(self.model.generate(text=text, prompt_audio_codes=prompt, mode="voice_clone", max_tokens=375))
            clip = np.asarray(generated[0].audio)
            if clip.ndim == 2 and clip.shape[0] <= 2:
                clip = clip.T
            raw, normalized = root / f"{index}-raw.wav", root / f"{index}.wav"
            sf.write(raw, clip, self.model.sample_rate)
            audio_command(["-i", str(raw), "-ac", "1", "-ar", "24000", "-af", tempo_filters(values["speed"]), str(normalized)])
            data, rate = sf.read(normalized, dtype="float32")
            aligned = self.aligner.align(normalized, text)
            words.extend({**word, "startSeconds": round(word["startSeconds"] + offset, 6),
                          "endSeconds": round(word["endSeconds"] + offset, 6)} for word in aligned)
            clips.append(data)
            offset += len(data) / rate
            if offset * 24000 * 2 > 32 * 1024 * 1024:
                raise ValueError("speech_too_large")
        combined, output = root / "combined.wav", root / "speech.mp3"
        sf.write(combined, np.concatenate(clips), 24000)
        audio_command(["-i", str(combined), "-c:a", "libmp3lame", "-q:a", "2", str(output)])
        result = output.read_bytes()
        return {"version": 1, "audio": base64.b64encode(result).decode("ascii"), "mimeType": "audio/mpeg",
                "audioSha256": hashlib.sha256(result).hexdigest(), "sourceText": values["input"],
                "durationSeconds": offset, "words": words, "timingMethod": "whisper-cross-attention-dtw",
                "alignmentModel": DEFAULT_ALIGNMENT_MODEL, "_runtime": {"peakMlxBytes": mx.get_peak_memory()}}


if __name__ == "__main__":
    engine = Engine()
    for line in sys.stdin:
        try:
            result = engine.synthesize(json.loads(line))
        except Exception:
            result = {"error": "moss_synthesis_failed"}
        protocol_output.write(json.dumps(result, ensure_ascii=False) + "\n")
        protocol_output.flush()
