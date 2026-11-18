"""Pure Unicode input validation and complete token-bounded segmentation."""

MAX_CHARACTERS = 60_000
MAX_SEGMENTS = 256
ENGINE_ID = "greyscope-v2-mlx-q4"


def validate_text(text):
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CHARACTERS:
        raise ValueError("TEXT_DETECTION_INPUT_INVALID")
    if any("\ud800" <= char <= "\udfff" for char in text):
        raise ValueError("TEXT_DETECTION_INPUT_INVALID")


def split_text(text, tokenizer, limit):
    """Ranges use Unicode code points in the original, unmodified input."""
    start = 0
    while start < len(text):
        end = min(start + 2048, len(text))
        if len(tokenizer.encode(text[start:end], add_special_tokens=True)) > limit:
            low, high = start + 1, end
            while low < high:
                middle = (low + high + 1) // 2
                if len(tokenizer.encode(text[start:middle], add_special_tokens=True)) <= limit:
                    low = middle
                else:
                    high = middle - 1
            end = low
        if end < len(text):
            # Prefer a paragraph/sentence boundary within the latter half.
            boundary = max(text.rfind(mark, (start + end) // 2, end) for mark in "\n。！？.!?")
            if boundary >= 0:
                end = boundary + 1
        yield start, end
        start = end
