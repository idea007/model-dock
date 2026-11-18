"""Bounded process isolation: one MLX model/codec/aligner per active slot."""

import asyncio
import json
import os
import signal
import tempfile
import sys
import time
from pathlib import Path


class PoolBusy(Exception):
    pass


class MossPool:
    def __init__(self, workers=2, queue=4, idle_seconds=60, timeout=900, command=None):
        if not 1 <= workers <= 4 or not 0 <= queue <= 16 or idle_seconds <= 0 or timeout <= 0:
            raise ValueError("invalid_pool_configuration")
        self.limit, self.queue_limit = workers, queue
        self.idle_seconds, self.timeout = idle_seconds, timeout
        self.command = command or [sys.executable, str(Path(__file__).with_name("moss_worker.py"))]
        self.slots = [{"process": None, "last_used": 0, "busy": False, "peak_memory": 0} for _ in range(workers)]
        self.available = asyncio.Queue()
        for slot in self.slots:
            self.available.put_nowait(slot)
        self.inflight = self.active = self.peak_active = self.completed = 0
        self.closed = False
        self.reaper = None

    def stats(self):
        return {"workers": self.limit, "queueLimit": self.queue_limit, "active": self.active,
                "queued": self.inflight - self.active, "loaded": sum(s["process"] is not None for s in self.slots),
                "peakActive": self.peak_active, "peakMlxBytesPerWorker": [s["peak_memory"] for s in self.slots], "completed": self.completed, "idleSeconds": self.idle_seconds}

    async def stop_slot(self, slot):
        process, slot["process"] = slot["process"], None
        if process is not None:
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await process.wait()

    async def reap(self):
        while True:
            await asyncio.sleep(min(self.idle_seconds, 5))
            for slot in self.slots:
                if not slot["busy"] and slot["process"] and time.monotonic() - slot["last_used"] >= self.idle_seconds:
                    # Do not yield between checking ownership and detaching the process.
                    await self.stop_slot(slot)

    async def close(self):
        self.closed = True
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)
        await asyncio.gather(*(self.stop_slot(slot) for slot in self.slots))

    async def run(self, payload, disconnected=None):
        if self.closed or self.inflight >= self.limit + self.queue_limit:
            raise PoolBusy()
        self.inflight += 1
        if self.reaper is None:
            self.reaper = asyncio.create_task(self.reap())
        job = asyncio.create_task(self.execute(payload))
        deadline = time.monotonic() + self.timeout
        try:
            while not job.done():
                if time.monotonic() >= deadline:
                    raise TimeoutError("moss_timeout")
                if disconnected and await disconnected():
                    raise asyncio.CancelledError()
                await asyncio.wait({job}, timeout=.1)
            return await job
        finally:
            if not job.done():
                job.cancel()
            await asyncio.gather(job, return_exceptions=True)
            self.inflight -= 1

    async def execute(self, payload):
        slot = await self.available.get()
        slot["busy"] = True
        directory = None
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        try:
            directory = tempfile.TemporaryDirectory(prefix="moss-job-")
            if self.closed:
                raise PoolBusy()
            if slot["process"] is None:
                slot["process"] = await asyncio.create_subprocess_exec(*self.command, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=48 * 1024 * 1024)
            process = slot["process"]
            if self.closed:
                raise PoolBusy()
            process.stdin.write(json.dumps({**payload, "workDirectory": directory.name}, ensure_ascii=False).encode() + b"\n")
            await process.stdin.drain()
            line = await process.stdout.readline()
            result = json.loads(line)
            if not isinstance(result, dict) or result.get("error"):
                raise ValueError("moss_worker_failed")
            metrics = result.pop("_runtime", {})
            slot["peak_memory"] = max(slot["peak_memory"], metrics.get("peakMlxBytes", 0))
            self.completed += 1
            return result
        except BaseException:
            await self.stop_slot(slot)
            raise
        finally:
            slot["last_used"] = time.monotonic()
            slot["busy"] = False
            self.active -= 1
            self.available.put_nowait(slot)
            if directory is not None:
                directory.cleanup()
