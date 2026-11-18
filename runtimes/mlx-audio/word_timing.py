"""Acoustic forced alignment of known narration; never distribute time by text length."""

import math
import re
import unicodedata

DEFAULT_ALIGNMENT_MODEL = "mlx-community/whisper-base-asr-fp16"


def compact(text):
    return "".join(char for char in unicodedata.normalize("NFC", text)
                   if not char.isspace() and unicodedata.category(char)[0] not in "PZ")


def narration_chunks(text, speed):
    # Bound each actual synthesis/alignment window, including slower voices.
    limit = max(16, int(72 * min(speed, 1)))
    pieces = re.findall(r"[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+", text)
    chunks = []
    current = ""
    for piece in pieces:
        while len(piece) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(piece[:limit])
            piece = piece[limit:]
        if len(current) + len(piece) > limit:
            chunks.append(current)
            current = ""
        current += piece
    if current:
        chunks.append(current)
    if "".join(chunks) != text or not chunks:
        raise ValueError("invalid_alignment_text")
    return chunks


def normalize_timings(alignment, text, duration):
    words = []
    pending = ""
    previous_end = 0.0
    for token in alignment:
        value = str(token.word)
        if not compact(value):
            # Punctuation has no independent acoustic word boundary.
            if words:
                words[-1]["text"] += value
            else:
                pending += value
            continue
        start, end = float(token.start), float(token.end)
        if not math.isfinite(start) or not math.isfinite(end) or start < previous_end - .001 or end > duration + .05 or end < start:
            raise ValueError("invalid_alignment_times")
        if end == start:
            # DTW may place adjacent subwords on the same frame. Keep them in
            # one token with an observed boundary, without inventing a duration.
            pending += value
            continue
        words.append({"text": pending + value, "startSeconds": start, "endSeconds": end})
        pending = ""
        previous_end = end
    if pending and words:
        words[-1]["text"] += pending
    if not words or compact("".join(word["text"] for word in words)) != compact(text):
        raise ValueError("alignment_text_mismatch")
    return words


class WhisperWordTiming:
    def __init__(self, model_id=DEFAULT_ALIGNMENT_MODEL):
        from mlx_audio.stt.utils import load_model

        self.model = load_model(model_id)
        self.model_id = model_id

    def align(self, wav_path, text):
        import numpy as np
        from mlx_audio.stt.utils import load_audio
        from mlx_audio.stt.models.whisper.audio import log_mel_spectrogram, pad_or_trim
        from mlx_audio.stt.models.whisper.timing import find_alignment

        audio = load_audio(str(wav_path), sr=16000)
        duration = len(audio) / 16000
        if not .1 <= duration <= 29 or not np.isfinite(np.asarray(audio)).all() or float(np.max(np.abs(np.asarray(audio)))) < .001:
            raise ValueError("alignment_audio_invalid")
        tokenizer = self.model.get_tokenizer(language="zh", task="transcribe")
        tokens = tokenizer.encode(text)
        if len(tokens) + len(tokenizer.sot_sequence) + 2 > self.model.dims.n_text_ctx:
            raise ValueError("alignment_text_too_long")
        mel = log_mel_spectrogram(pad_or_trim(audio), n_mels=self.model.dims.n_mels)
        alignment = find_alignment(self.model, tokenizer, tokens, mel, int(duration * 100))
        return normalize_timings(alignment, text, duration)
