import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGateway } from '../apps/gateway/server.mjs';
import { fixtureUpstream, setup, until } from './helpers.mjs';

const chat = (model, content = 'private fixture prompt') => ({ model, messages: [{ role: 'user', content }] });
async function startStream(app, body, token = app.admin) {
  const controller = new AbortController();
  const response = await fetch(`${app.origin}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }), signal: controller.signal
  });
  assert.equal(response.status, 200);
  await response.body.getReader().read();
  return { id: response.headers.get('x-request-id'), stop: () => controller.abort() };
}

test('usage reports and CSV preserve attributed outcomes and estimates across restart', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`);
  const shared = `${connection}/shared`, slow = `${connection}/slow`;
  await app.enable(shared); await app.enable(slow);
  const price = { currency: 'USD', inputPerMillion: 1_000_000, outputPerMillion: 2_000_000 };
  assert.equal((await app.mutate('/admin/usage/prices', 'PATCH', { modelId: shared, price })).status, 200);
  const key = (await app.mutate('/admin/keys', 'POST', { name: '=Fixture project', models: [shared, slow] })).data;
  const before = app.store.read().revision;
  const succeeded = await app.request('/v1/responses', 'POST', { model: shared, input: 'private fixture prompt' }, key.token);
  assert.equal(succeeded.status, 200);
  const failed = await app.request('/v1/chat/completions', 'POST', {
    ...chat(shared, 'invalid-tool-arguments'), tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
  }, key.token);
  assert.equal(failed.status, 502);
  const stream = await startStream(app, chat(slow), key.token);
  stream.stop();
  await until(() => app.gateway.history.some(row => row.id === stream.id && row.status === 'cancelled'));
  assert.equal(app.store.read().revision, before, 'call accounting does not change configuration revisions');
  assert.equal((await app.request('/admin/usage', 'GET', undefined, key.token)).status, 401);
  const { data } = await app.request(`/admin/usage?days=30&project=${key.id}`);
  assert.equal(data.total.requests, 3);
  assert.deepEqual([data.total.succeeded, data.total.failed, data.total.cancelled], [1, 1, 1]);
  assert.equal(data.total.unreported, 1);
  assert.equal(data.total.inputTokens, 10); assert.equal(data.total.outputTokens, 14);
  assert.deepEqual(data.total.estimates, { USD: 38 });
  const cancelled = data.recent.find(row => row.id === stream.id);
  assert.equal(cancelled.usage, null); assert.equal(cancelled.estimate, null);
  assert.equal(data.recent.find(row => row.id === failed.response.headers.get('x-request-id')).status, 'failed');
  assert.equal(data.recent.find(row => row.id === succeeded.data.id).endpoint, 'responses');

  await app.mutate(`/admin/keys/${key.id}`, 'DELETE');
  await app.mutate('/admin/usage/prices', 'PATCH', { modelId: shared, price: null });
  await app.close();
  const expired = path.join(app.directory, 'usage', '2000-01-01.jsonl');
  await fs.writeFile(expired, 'expired entry\n', { mode: 0o600 });
  const resumed = await startGateway({ directory: app.directory, port: 0 });
  try {
    await assert.rejects(fs.access(expired), { code: 'ENOENT' });
    const headers = { authorization: `Bearer ${app.admin}` };
    const query = `days=30&project=${key.id}&model=${encodeURIComponent(shared)}`;
    const report = await (await fetch(`${resumed.origin}/admin/usage?${query}`, { headers })).json();
    assert.equal(report.total.requests, 2);
    assert.deepEqual(report.total.estimates, { USD: 38 }, 'price changes are not retroactive');
    assert.equal(report.projects[0].name, '=Fixture project');
    assert.equal(report.models[0].id, shared);
    assert.equal(report.daily[0].requests, 2);
    const response = await fetch(`${resumed.origin}/admin/usage?${query}&format=csv`, { headers });
    assert.match(response.headers.get('content-type'), /^text\/csv/);
    const csv = await response.text();
    assert.equal(csv.trim().split('\r\n').length, 3);
    assert.ok(csv.includes("'\u003dFixture project"), 'spreadsheet formulas are escaped on export');
    assert.ok(!csv.includes(stream.id));
    const directory = path.join(app.directory, 'usage');
    const [filename] = await fs.readdir(directory);
    const stored = await fs.readFile(path.join(directory, filename), 'utf8');
    for (const text of ['private fixture prompt', 'invalid-tool-arguments', '你好，来自测试上游', key.token, app.admin, 'fixture-upstream']) {
      assert.ok(!stored.includes(text));
    }
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, filename))).mode & 0o777, 0o600);
  } finally { await resumed.close(); }
});

test('project limits apply before parsing across inference endpoints and can be edited on the same key', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`);
  const shared = `${connection}/shared`, slow = `${connection}/slow`;
  await app.enable(shared); await app.enable(slow);
  const scopedKey = async (name, limits) => (await app.mutate('/admin/keys', 'POST', { name, models: [shared, slow], limits })).data;
  const minute = await scopedKey('minute', { requestsPerMinute: 1 });
  const concurrent = await scopedKey('concurrent', { maxConcurrentRequests: 1 });
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat(shared), minute.token)).status, 200);
  const limited = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${minute.token}`, 'content-type': 'application/json' }, body: 'not JSON'
  });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'project_rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const revision = app.store.read().revision;
  assert.equal((await app.mutate(`/admin/keys/${minute.id}`, 'PATCH', { limits: { requestsPerMinute: 0 } })).status, 400);
  assert.equal(app.store.read().revision, revision);
  assert.equal((await app.mutate(`/admin/keys/${minute.id}`, 'PATCH', { limits: null })).status, 200);
  assert.equal((await app.request('/v1/responses', 'POST', { model: shared, input: 'ready' }, minute.token)).status, 200);

  const running = await startStream(app, chat(slow), concurrent.token);
  try {
    const full = await app.request('/v1/images/generations', 'POST', {}, concurrent.token);
    assert.equal(full.status, 429);
    assert.equal(full.data.error.code, 'project_at_capacity');
    assert.equal(full.response.headers.get('retry-after'), '1');
    assert.equal((await app.request('/v1/chat/completions', 'POST', chat(shared), minute.token)).status, 200);
  } finally { running.stop(); }
  await until(() => app.gateway.history.some(row => row.id === running.id && row.status === 'cancelled'));
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat(shared), concurrent.token)).status, 200);
});

for (const [reason, bodyBudget] of [['request count', { maxRequests: 1 }], ['byte count', { maxBytes: 1000 }]]) {
  test(`request body protection bounds aggregate ${reason} and releases the reservation after cancellation`, async t => {
    const upstream = await fixtureUpstream(t), app = await setup(t, { bodyBudget });
    const connection = await app.connection('openai', `${upstream.origin}/v1`);
    const shared = `${connection}/shared`, slow = `${connection}/slow`;
    await app.enable(shared); await app.enable(slow);
    const running = await startStream(app, chat(slow, 'x'.repeat(820)));
    try {
      const full = await app.request('/v1/chat/completions', 'POST', chat(shared, 'x'.repeat(120)));
      assert.equal(full.status, 429);
      assert.equal(full.data.error.code, 'request_body_capacity');
      assert.equal(full.response.headers.get('retry-after'), '1');
      assert.equal(upstream.calls.length, 1);
    } finally { running.stop(); }
    await until(() => app.gateway.history.some(row => row.id === running.id && row.status === 'cancelled'));
    assert.equal((await app.request('/v1/chat/completions', 'POST', chat(shared))).status, 200);
  });
}

test('changing an upstream origin requires explicit replacement or removal of its saved key', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`);
  const address = `/admin/connections/${connection}`;
  assert.equal((await app.mutate(address, 'PATCH', { baseUrl: `${upstream.origin}/api/v1` })).status, 200);
  const before = app.store.read();
  const refused = await app.mutate(address, 'PATCH', { baseUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(refused.status, 400); assert.equal(refused.data.error.code, 'credential_origin_changed');
  assert.deepEqual(app.store.read(), before);
  const replaced = await app.mutate(address, 'PATCH', { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'replacement-fixture' });
  assert.equal(replaced.status, 200);
  assert.equal(app.store.decrypt(app.store.connectionKey(app.store.read().connections[0])), 'replacement-fixture');
  const removed = await app.mutate(address, 'PATCH', { baseUrl: `${upstream.origin}/v1`, apiKey: '' });
  assert.equal(removed.status, 200); assert.equal(removed.data.state.connections[0].hasKey, false);
});
