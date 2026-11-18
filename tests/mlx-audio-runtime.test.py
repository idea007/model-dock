import ast
import asyncio
import contextlib
import io
import os
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace


RUNTIME = Path(__file__).resolve().parents[1] / "runtimes" / "mlx-audio"
sys.path.insert(0, str(RUNTIME))

from moss_pool import MossPool, PoolBusy


FAKE_WORKER = """import json, os, sys, time
for line in sys.stdin:
    values = json.loads(line)
    start = time.monotonic()
    time.sleep(values.get("delay", .2))
    if values.get("fail"):
        result = {"error": "failed"}
    else:
        result = {"directory": values["workDirectory"], "pid": os.getpid(),
                  "start": start, "end": time.monotonic()}
    print(json.dumps(result), flush=True)
"""


class SpeechRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_kokoro_warmup_and_optional_model_failure(self):
        source = RUNTIME / "mlx-server.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and node.name in {"supported_model", "lifespan"}]
        startup = compile(ast.Module(body=functions, type_ignores=[]), source.name, "exec")
        default = "mlx-community/Kokoro-82M-8bit"
        for model, fail in [(default, False), (default, True), ("unsupported-model", False)]:
            with self.subTest(model=model, fail=fail):
                events = []

                def load(name):
                    events.append(("loaded", name))
                    if fail:
                        raise FileNotFoundError("fixture-private-path")

                @contextlib.asynccontextmanager
                async def original(_app):
                    events.append("upstream-ready")
                    yield

                async def close():
                    events.append("closed")

                with ThreadPoolExecutor(max_workers=1) as worker:
                    scope = dict(asynccontextmanager=contextlib.asynccontextmanager, asyncio=asyncio,
                                 DEFAULT_MODEL=model, worker=worker, WhisperWordTiming=object,
                                 original_lifespan=original,
                                 upstream=SimpleNamespace(model_provider=SimpleNamespace(load_model=load)),
                                 moss_pool=SimpleNamespace(close=close))
                    exec(startup, scope)
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        async with scope["lifespan"](None):
                            events.append("accepting-requests")
                expected = ["upstream-ready", "accepting-requests", "closed"]
                if model == default:
                    expected.insert(1, ("loaded", model))
                self.assertEqual(events, expected)
                self.assertNotIn("fixture-private-path", output.getvalue())
                self.assertEqual("FileNotFoundError" in output.getvalue(), fail)

    async def test_moss_workers_overlap_with_bounded_queue_and_isolated_cleanup(self):
        pool = MossPool(workers=2, queue=1, idle_seconds=.15, timeout=3,
                        command=[sys.executable, "-u", "-c", FAKE_WORKER])
        try:
            a, b = await asyncio.gather(pool.run({}), pool.run({}))
            self.assertNotEqual(a["pid"], b["pid"])
            self.assertFalse(os.path.exists(a["directory"]) or os.path.exists(b["directory"]))
            self.assertLess(max(a["start"], b["start"]), min(a["end"], b["end"]))
            self.assertEqual(pool.stats()["peakActive"], 2)
            jobs = [asyncio.create_task(pool.run({"delay": .4})) for _ in range(3)]
            await asyncio.sleep(.05)
            self.assertEqual((pool.stats()["active"], pool.stats()["queued"]), (2, 1))
            with self.assertRaises(PoolBusy):
                await pool.run({})
            jobs[2].cancel()
            await asyncio.gather(jobs[2], return_exceptions=True)
            self.assertEqual(pool.stats()["active"], 2)
            await asyncio.gather(*jobs[:2])
            active = asyncio.create_task(pool.run({"delay": 10}))
            await asyncio.sleep(.05)
            active.cancel()
            await asyncio.gather(active, return_exceptions=True)
            self.assertEqual(pool.stats()["active"], 0)
            with self.assertRaises(ValueError):
                await pool.run({"fail": True})
            self.assertTrue((await pool.run({}))["pid"])
            pool.timeout = .05
            with self.assertRaises(TimeoutError):
                await pool.run({"delay": 10})
            pool.timeout = 3
            await pool.run({})
            await asyncio.sleep(.4)
            self.assertEqual((pool.stats()["loaded"], pool.stats()["queued"]), (0, 0))
        finally:
            await pool.close()
        with self.assertRaises(PoolBusy):
            await pool.run({})


if __name__ == "__main__":
    unittest.main()
