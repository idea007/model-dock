import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mfluxHealth, mfluxSettings } from '../runtimes/mflux/cli.mjs';

test('MFLUX runtime identity follows its private data directory and rejects unsafe port values', () => {
  const directory = path.join(os.tmpdir(), 'model-dock-fixture');
  const settings = mfluxSettings(directory, {});
  assert.equal(settings.origin, 'http://127.0.0.1:8016');
  assert.equal(settings.root, path.join(directory, 'runtimes', 'mflux'));
  const override = mfluxSettings(directory, { MODEL_DOCK_MFLUX_RUNTIME_DIR: directory, MODEL_DOCK_MFLUX_PORT: '8017' });
  assert.notEqual(override.label, settings.label);
  assert.equal(override.origin, 'http://127.0.0.1:8017');
  assert.throws(() => mfluxSettings(directory, { MODEL_DOCK_MFLUX_PORT: '-1' }), /MFLUX_PORT/);
  assert.throws(() => mfluxSettings(directory, { MODEL_DOCK_MFLUX_RUNTIME_DIR: 'relative/path' }), /absolute path/);
});

test('MFLUX health authenticates the expected managed process and installed model revision', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-dock-mflux-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = mfluxSettings(directory, { MODEL_DOCK_MFLUX_RUNTIME_DIR: directory });
  const fixtureToken = 'test_mflux_' + 'a'.repeat(32);
  await writeFile(settings.tokenFile, fixtureToken, { mode: 0o600 });
  const registry = JSON.parse(await readFile(new URL('../runtimes/mflux/models.json', import.meta.url)));
  const model = registry.defaultModel;
  const ready = {
    provider: 'local-mflux', protocolVersion: registry.protocolVersion, workspaceId: settings.id,
    pid: 12345, status: 'ready', data: [{ id: model, revision: registry.models[model].revision, status: 'ready' }]
  };
  const check = (payload, modelId = model) => mfluxHealth(settings, 12345, {
    modelId,
    fetchImpl: async (url, options) => {
      if (url !== settings.origin + '/health' || options.redirect !== 'error' ||
          options.headers.authorization !== 'Bearer ' + fixtureToken) return new Response(null, { status: 401 });
      return Response.json(payload);
    }
  });
  assert.deepEqual(await check(ready), { pid: 12345, models: [model] });
  assert.equal(await check(ready, 'z-image-turbo'), null);
  assert.equal(await check({ ...ready, pid: 12346 }), null);
  assert.equal(await check({ ...ready, workspaceId: 'another-runtime' }), null);
  assert.equal(await check({ ...ready, data: [{ ...ready.data[0], revision: 'wrong' }] }), null);
  assert.equal(await mfluxHealth(settings, 12345, { fetchImpl: async () => new Response(null, { status: 401 }) }), null);
});
