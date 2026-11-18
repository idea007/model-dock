"""Bound Gemma-4 lazy graphs in the pinned MLX runtime without changing math."""


def install():
    import mlx.core as mx
    from ltx_core_mlx.text_encoders.gemma.gemma4 import Gemma4DecoderLayer

    original = Gemma4DecoderLayer.__call__
    if getattr(original, "_cursorblinking_evaluates_each_layer", False):
        return

    def evaluate_each_layer(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        mx.eval(result)
        return result

    evaluate_each_layer._cursorblinking_evaluates_each_layer = True
    Gemma4DecoderLayer.__call__ = evaluate_each_layer
