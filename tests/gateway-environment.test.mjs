import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadGatewayEnvironment } from '../apps/gateway/cli.mjs';

test('gateway environment uses explicit process settings before machine overrides and defaults', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-dock-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.env'), 'MODEL_DOCK_PORT=4320\nMODEL_DOCK_CODEX_QUEUE_WAIT_MS=50\n');
  await writeFile(join(directory, '.env.local'), 'MODEL_DOCK_PORT=4321\nMODEL_DOCK_CODEX_MAX_CONCURRENCY=2\nMODEL_DOCK_USAGE_DEBUG=1\nNODE_OPTIONS=ignored\n');
  const env = await loadGatewayEnvironment({ MODEL_DOCK_CONFIG_DIR: directory, MODEL_DOCK_USAGE_DEBUG: '0' });
  assert.deepEqual(env, {
    MODEL_DOCK_CONFIG_DIR: directory, MODEL_DOCK_USAGE_DEBUG: '0',
    MODEL_DOCK_PORT: '4321', MODEL_DOCK_CODEX_QUEUE_WAIT_MS: '50', MODEL_DOCK_CODEX_MAX_CONCURRENCY: '2'
  });
  assert.equal((await loadGatewayEnvironment({ MODEL_DOCK_CONFIG_DIR: directory, MODEL_DOCK_PORT: '4322' })).MODEL_DOCK_PORT, '4322');
});
