import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ltxHealth, ltxSettings } from '../runtimes/ltx/cli.mjs';
import { registry } from '../runtimes/ltx/installation.mjs';
import { cancelVideoJob, createJob, createLocalVideoServer, validateVideoPayload } from '../runtimes/ltx/server.mjs';
import { serviceToken } from '../runtimes/service-settings.mjs';

const payload = { model: registry.defaultModel, prompt: 'test', width: 512, height: 320,
  num_frames: 97, fps: 24, seed: 1, reference_images: [] };

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'model-dock-ltx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('LTX keeps the validated 97-frame fixed profiles', () => {
  assert.deepEqual(validateVideoPayload(payload), payload);
  for (const patch of [{ num_frames: 96 }, { fps: 25 }, { width: 1920 }, { model: 'missing' }]) {
    assert.throws(() => validateVideoPayload({ ...payload, ...patch }), TypeError);
  }
});

test('LTX only confirms cancellation after the worker exits and can retry pending cancellation', async t => {
  const root = fixture(t);
  const status = path.join(root, 'status.json');
  writeFileSync(status, JSON.stringify({ id: 'test', pid: 42, status: 'running' }));
  let alive = true, signals = 0;
  const ports = { alive: () => alive, signal: () => { signals++; }, wait: async () => {} };
  assert.equal((await cancelVideoJob(root, ports)).status, 'running');
  assert.equal(JSON.parse(readFileSync(status)).phase, 'cancelling');
  assert.equal((await cancelVideoJob(root, { ...ports, wait: async () => { alive = false; } })).status, 'cancelled');
  assert.equal((await cancelVideoJob(root, ports)).status, 'cancelled');
  assert.equal(signals, 2);
});

test('LTX recovers completed operations and content after HTTP server recreation', async t => {
  const root = fixture(t);
  let starts = 0;
  const operation = 'fixture-operation';
  const settings = { port: 0, token: 'test-only', jobsRoot: root, modelsRoot: root,
    modelIds: [registry.defaultModel], pythonExecutable: 'unused',
    spawnProcess: () => { starts++; return { pid: process.pid, once() {}, unref() {} }; } };
  const created = createJob(payload, settings, operation);
  const start = async () => {
    const server = createLocalVideoServer(settings);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    settings.port = server.address().port;
    return server;
  };
  const close = server => new Promise(resolve => server.close(resolve));
  const initial = await start();
  const status = path.join(root, created.id, 'status.json');
  const result = Buffer.from('fixture video');
  writeFileSync(path.join(root, created.id, 'result.mp4'), result);
  writeFileSync(status, JSON.stringify({ ...created, status: 'succeeded' }));
  await close(initial);

  const restarted = await start();
  t.after(() => close(restarted));
  const base = `http://127.0.0.1:${settings.port}/v1/video`;
  const url = `${base}/operations/${operation}`;
  const auth = { authorization: `Bearer ${settings.token}` };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { ...auth, origin: 'https://example.com' } })).status, 403);
  const recovered = await fetch(url, { headers: auth });
  assert.equal(recovered.status, 200);
  const body = await recovered.json();
  assert.equal(body.id, created.id);
  assert.equal(body.status, 'succeeded');
  const downloaded = await fetch(`${base}/generations/${created.id}/content`, { headers: auth });
  assert.equal(downloaded.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), result);
  const retry = value => fetch(`${base}/generations`, { method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': operation }, body: JSON.stringify(value) });
  const repeated = await retry(payload);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).id, created.id);
  assert.equal((await retry({ ...payload, prompt: 'changed' })).status, 409);
  unlinkSync(status);
  assert.equal((await retry(payload)).status, 409);
  assert.equal(starts, 1);
});

test('LTX health checks the registered job and model revisions', async t => {
  const root = fixture(t);
  const settings = ltxSettings(root, {});
  serviceToken(settings.root, { create: true });
  const id = registry.defaultModel;
  const body = { provider: registry.provider, protocolVersion: registry.protocolVersion, workspaceId: settings.id,
    pid: 123, status: 'ready', data: [{ id, revision: registry.models[id].revision, status: 'ready' }] };
  const probe = (received, pid = body.pid) => ltxHealth(settings, pid, [id], { fetchImpl: async () => Response.json(received) });
  assert.deepEqual(await probe(body), { pid: 123, models: [id] });
  assert.equal(await probe(body, 124), null);
  assert.equal(await probe({ ...body, data: [{ ...body.data[0], revision: 'other' }] }), null);
});
