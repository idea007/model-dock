import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexSessions } from '../packages/core/codex-sessions.mjs';

test('Codex session capacity includes a reservation written and released during an index scan', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-sessions-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = value => value.toString(16).padStart(64, '0');
  const scanning = Promise.withResolvers(), resumeScan = Promise.withResolvers();
  let pauseScan = false;
  class PausedScan extends CodexSessions {
    async read(sessionId) {
      if (pauseScan && sessionId === id(1)) {
        pauseScan = false;
        scanning.resolve();
        await resumeScan.promise;
      }
      return super.read(sessionId);
    }
  }
  const store = new PausedScan(directory);
  const pending = { version: 1, updatedAt: Date.now(), requestHash: id(901), compatibility: id(902),
    instructionsHash: id(903), threadId: 'fixture-thread', turnId: 'fixture-turn', status: 'pending', hashes: [], recent: [] };

  await fs.mkdir(store.directory, { mode: 0o700 });
  await Promise.all(Array.from({ length: 511 }, (_, index) =>
    fs.writeFile(path.join(store.directory, id(index + 1) + '.json'), JSON.stringify(pending), { mode: 0o600 })));
  const first = await store.acquire(id(512));
  pauseScan = true;
  const next = store.acquire(id(513));
  next.catch(() => {});
  try {
    await scanning.promise;
    await first.write(pending);
  } finally {
    first.release();
    resumeScan.resolve();
  }
  await assert.rejects(next, { code: 'session_busy' });
  assert.equal((await fs.readdir(store.directory)).length, 512);
});
