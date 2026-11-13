import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import OpenAI from 'openai';
import { setup, fixtureUpstream, until } from './helpers.mjs';
import { Store } from '../packages/core/store.mjs';

const messages = [{ role: 'user', content: '你好' }];
const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

test('credentials are encrypted; admin/API permissions, origin and host boundaries are enforced', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  assert.equal((await app.request('/admin/state', 'GET', undefined, '')).status, 401);
  assert.equal((await app.request('/admin/state', 'GET', undefined, app.admin, { origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${app.origin}/healthz`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const id = await app.connection('openai', `${upstream.origin}/v1`);
  const saved = await fs.readFile(path.join(app.directory, 'state.json'), 'utf8');
  assert.ok(!saved.includes('fixture-upstream'));
  const snapshot = await app.request('/admin/state');
  assert.ok(!JSON.stringify(snapshot.data).includes('fixture-upstream'));
  assert.ok(!JSON.stringify(snapshot.data).includes('"secret"'));
  assert.equal(snapshot.data.connections[0].hasKey, true);
  assert.equal((await app.request('/v1/models')).data.data.length, 0);
  const key = await app.mutate('/admin/keys', 'POST', { name: 'demo', models: [`${id}/shared`] });
  assert.equal((await app.request('/admin/state', 'GET', undefined, key.data.token)).status, 401);
  assert.ok(!(await fs.readFile(path.join(app.directory, 'state.json'), 'utf8')).includes(key.data.token));
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(app.directory, 'state.json'))).mode & 0o777, 0o600);
  await assert.rejects(new Store(app.directory).open(), /in use/);
});

test('same-name models stay isolated; aliases, scoped keys, revision conflicts and revocation fail closed', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const a = await app.connection('openai', `${upstream.origin}/v1`), b = await app.connection('openai', `${upstream.origin}/v1`);
  await app.enable(`${a}/shared`); await app.enable(`${b}/shared`);
  await app.mutate('/admin/routes', 'POST', { id: 'chat-default', name: '聊天', modelId: `${a}/shared` });
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'demo', models: ['chat-default'] })).data.token;
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key)).data.data.map(item => item.id), ['chat-default']);
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model: `${b}/shared`, messages }, key)).status, 403);
  assert.equal((await app.request('/admin/routes', 'POST', { revision: 0, id: 'bad', modelId: `${b}/shared` })).status, 409);
  const result = await app.request('/v1/chat/completions', 'POST', { model: 'chat-default', messages }, key);
  assert.equal(result.status, 200); assert.equal(result.data.model, 'chat-default');
  await app.mutate(`/admin/models/${encodeURIComponent(`${a}/shared`)}`, 'PATCH', { enabled: false });
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model: 'chat-default', messages }, key)).status, 404);
  const keyId = app.store.read().keys[0].id;
  await app.mutate(`/admin/keys/${keyId}`, 'DELETE');
  assert.equal((await app.request('/v1/models', 'GET', undefined, key)).status, 401);
});

test('official OpenAI JS SDK: JSON, fragmented Unicode SSE, usage and function roundtrip', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`), model = `${connection}/shared`;
  await app.enable(model);
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  assert.deepEqual((await client.models.list()).data.map(item => item.id), [model]);
  const json = await client.chat.completions.create({ model, messages });
  assert.equal(json.choices[0].message.content, '你好，来自测试上游。'); assert.equal(json.usage.total_tokens, 12);
  let text = '', usage;
  for await (const chunk of await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } })) {
    text += chunk.choices[0]?.delta.content || ''; if (chunk.usage) usage = chunk.usage;
  }
  assert.equal(text, json.choices[0].message.content); assert.equal(usage.total_tokens, 12);
  const call = await client.chat.completions.create({ model, messages, tools });
  assert.equal(call.choices[0].finish_reason, 'tool_calls'); assert.equal(call.choices[0].message.content, null);
  const continued = await client.chat.completions.create({ model, tools, messages: [...messages, call.choices[0].message, { role: 'tool', tool_call_id: 'call_1', content: '22°C' }] });
  assert.match(continued.choices[0].message.content, /22°C/);
  let argumentsText = '';
  for await (const chunk of await client.chat.completions.create({ model, messages, tools, stream: true })) argumentsText += chunk.choices[0]?.delta.tool_calls?.[0]?.function?.arguments || '';
  assert.deepEqual(JSON.parse(argumentsText), { city: '杭州' });
  assert.equal(upstream.calls.filter(call => call.url === '/v1/chat/completions').at(-1).body.model, 'shared');
  assert.ok(app.gateway.history.every(row => !('messages' in row)));
});

test('truncated SSE is an error, and client cancellation stops upstream and frees capacity', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`);
  await app.enable(`${connection}/broken`); await app.enable(`${connection}/slow`);
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  await assert.rejects(async () => {
    for await (const chunk of await client.chat.completions.create({ model: `${connection}/broken`, messages, stream: true })) void chunk;
  }, /incomplete|invalid/);
  const controller = new AbortController();
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${app.admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `${connection}/slow`, messages, stream: true }) });
  await response.body.getReader().read(); controller.abort();
  await until(() => upstream.disconnects > 0 && app.gateway.active.size === 0);
  assert.equal(app.gateway.history[0].status, 'cancelled');
});

test('concurrency is bounded and revoked credentials abort in-flight inference', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const id = await app.connection('openai', `${upstream.origin}/v1`), model = `${id}/slow`;
  await app.enable(model); await app.mutate(`/admin/connections/${id}`, 'PATCH', { maxConcurrency: 1 });
  const created = await app.mutate('/admin/keys', 'POST', { name: 'short-lived', models: [model] });
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${created.data.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true }) });
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model, messages })).status, 429);
  await app.mutate(`/admin/keys/${created.data.id}`, 'DELETE');
  while (!(await reader.read()).done) {}
  await until(() => app.gateway.active.size === 0 && upstream.disconnects > 0);
});

test('Ollama uses native capability discovery and respects configured context', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const id = await app.connection('ollama', upstream.origin), model = `${id}/local:small`;
  assert.equal(app.store.read().models.length, 1);
  assert.equal(app.store.read().models[0].contextWindow, 2048);
  await app.enable(model);
  const result = await app.request('/v1/chat/completions', 'POST', { model, messages, max_tokens: 10 });
  assert.equal(result.data.choices[0].message.content, '本机回答');
  assert.equal(result.data.usage.total_tokens, 7);
  const sent = upstream.calls.find(call => call.url === '/api/chat').body;
  assert.equal(sent.options.num_predict, 10); assert.equal(sent.options.num_ctx, undefined);
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model, messages, tools, tool_choice: 'required' })).status, 400);
});

test('malformed inputs, unsupported modalities, HTTP destinations and broken histories are rejected', async t => {
  const app = await setup(t);
  const bad = await app.mutate('/admin/connections', 'POST', { name: 'unsafe', type: 'openai', baseUrl: 'http://example.com/v1' });
  assert.equal(bad.status, 400);
  const history = await app.request('/v1/chat/completions', 'POST', { model: 'unknown', messages: [{ role: 'tool', content: 'bad', tool_call_id: 'missing' }] });
  assert.equal(history.status, 400);
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model: 'unknown', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] })).status, 400);
  assert.equal((await app.request('/v1/chat/completions', 'POST', null)).status, 400);
});

test('persisted credentials and choices survive a restart without creating a new identity', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const id = await app.connection('openai', `${upstream.origin}/v1`);
  const revision = app.store.read().revision, admin = app.admin;
  await app.close(); const reopened = await new Store(app.directory).open();
  t.after(() => reopened.close());
  assert.equal(reopened.read().revision, revision); assert.equal(reopened.adminToken, admin);
  assert.equal(reopened.read().connections[0].id, id);
  assert.equal(reopened.decrypt(reopened.read().connections[0].secret), 'fixture-upstream');
});

test('missing private identity files fail closed without regenerating credentials or changing state', async t => {
  for (const name of ['master.key', 'admin.token']) {
    const app = await setup(t);
    const saved = await fs.readFile(path.join(app.directory, 'state.json'), 'utf8');
    await app.close();
    await fs.unlink(path.join(app.directory, name));
    await assert.rejects(new Store(app.directory).open(), /credentials will not be regenerated/);
    await assert.rejects(fs.stat(path.join(app.directory, name)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(app.directory, 'server.lock')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(app.directory, 'state.json'), 'utf8'), saved);
  }
});

test('upstream violations of JSON format or tool selection are reported as errors', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const connection = await app.connection('openai', `${upstream.origin}/v1`), model = `${connection}/shared`;
  await app.enable(model);
  const invalidJson = await app.request('/v1/chat/completions', 'POST', { model, messages, response_format: { type: 'json_object' } });
  assert.equal(invalidJson.status, 502);
  assert.equal(invalidJson.data.error.code, 'upstream_json_invalid');
  assert.equal(app.gateway.history[0].status, 'failed');
  assert.equal(app.gateway.history[0].errorCode, 'upstream_json_invalid');
  const forbiddenTool = await app.request('/v1/chat/completions', 'POST', { model, messages, tools, tool_choice: 'none' });
  assert.equal(forbiddenTool.status, 502);
  assert.equal(forbiddenTool.data.error.code, 'upstream_tool_choice_failed');
  assert.equal(app.gateway.history[0].status, 'failed');
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  await assert.rejects(async () => {
    for await (const chunk of await client.chat.completions.create({ model, messages, stream: true, response_format: { type: 'json_object' } })) void chunk;
  }, /valid JSON/);
});
