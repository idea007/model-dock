import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import OpenAI from 'openai';
import { setup, fixtureUpstream, until } from './helpers.mjs';
import { Store } from '../packages/core/store.mjs';
import { sse } from '../packages/protocol/events.mjs';

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
  // Seed an existing alias; new business aliases are client-owned.
  await app.gateway.saveRoute({ revision: app.store.read().revision, id: 'chat-default', name: '聊天', modelId: `${a}/shared` });
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'demo', models: ['chat-default'] })).data.token;
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key)).data.data.map(item => item.id), ['chat-default']);
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model: `${b}/shared`, messages }, key)).status, 403);
  assert.equal((await app.request('/admin/routes', 'POST', { revision: 0, id: 'bad', modelId: `${b}/shared` })).status, 410);
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
    text += chunk.choices[0]?.delta.content || '';
    if (chunk.choices.length) assert.equal(chunk.usage, null);
    else usage = chunk.usage;
  }
  assert.equal(text, json.choices[0].message.content); assert.equal(usage.total_tokens, 12);
  const call = await client.chat.completions.create({ model, messages, tools });
  assert.equal(call.choices[0].finish_reason, 'tool_calls'); assert.equal(call.choices[0].message.content, null);
  const continued = await client.chat.completions.create({ model, tools, n: 1, messages: [...messages,
    { role: 'assistant', tool_calls: call.choices[0].message.tool_calls },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '22' }, { type: 'text', text: '°C' }] }] });
  assert.match(continued.choices[0].message.content, /22°C/);
  assert.equal(upstream.calls.at(-1).body.n, undefined);
  assert.equal(upstream.calls.at(-1).body.messages.at(-2).content, null);
  assert.equal(upstream.calls.at(-1).body.messages.at(-1).content, '22°C');
  const streamedCalls = [];
  for await (const chunk of await client.chat.completions.create({ model, messages, tools, stream: true })) {
    assert.equal(chunk.usage, undefined);
    if (chunk.choices[0]?.delta.tool_calls) streamedCalls.push(chunk.choices[0].delta.tool_calls);
  }
  assert.deepEqual(streamedCalls, [[{ index: 0, ...call.choices[0].message.tool_calls[0] }]]);
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
  const callsBefore = upstream.calls.length;
  const rejected = await app.request('/v1/chat/completions', 'POST', { model, messages });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.data.error.code, 'connection_busy');
  assert.equal(rejected.response.headers.get('retry-after'), '2');
  assert.equal(upstream.calls.length, callsBefore, 'local capacity rejects before upstream submission');
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
  const result = await app.request('/v1/chat/completions', 'POST', { model, n: 1, max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] }] });
  assert.equal(result.data.choices[0].message.content, '本机回答');
  assert.equal(result.data.usage.total_tokens, 7);
  const sent = upstream.calls.find(call => call.url === '/api/chat').body;
  assert.equal(sent.n, undefined);
  assert.deepEqual(sent.messages, messages);
  assert.equal(sent.options.num_predict, 10); assert.equal(sent.options.num_ctx, undefined);
  assert.equal((await app.request('/v1/chat/completions', 'POST', { model, messages, tools, tool_choice: 'required' })).status, 400);
});

test('Chat streams only completed, validated tool batches and retains OpenAI-compatible parallel calls', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const model = (await app.connection('openai', upstream.origin + '/v1')) + '/shared';
  await app.enable(model);
  const endpoint = '/v1/chat/completions';
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  const params = content => ({ model, messages: [{ role: 'user', content }], tools });

  const streamedCalls = [], reasons = [];
  const parallel = { ...params('multiple-tool-calls'), parallel_tool_calls: true };
  for await (const { choices: [choice] } of await client.chat.completions.create({ ...parallel, stream: true })) {
    if (choice?.delta.tool_calls) streamedCalls.push(choice.delta.tool_calls);
    if (choice?.finish_reason) reasons.push(choice.finish_reason);
  }
  assert.deepEqual(reasons, ['tool_calls']);
  assert.equal(streamedCalls.length, 1);
  assert.deepEqual(streamedCalls[0].map(({ index, id, function: fn }) => [index, id, JSON.parse(fn.arguments)]),
    [[0, 'call_1', { city: '杭州' }], [1, 'call_2', { city: '杭州' }]]);
  const [choice] = (await client.chat.completions.create(parallel)).choices;
  assert.deepEqual(choice.message.tool_calls, streamedCalls[0].map(({ index, ...call }) => call));
  const replay = [...parallel.messages, choice.message, ...choice.message.tool_calls.map(({ id }) => ({
    role: 'tool', tool_call_id: id, content: '22°C'
  }))];
  assert.match((await client.chat.completions.create({ model, messages: replay })).choices[0].message.content, /22°C/);
  assert.deepEqual(upstream.calls.at(-1).body.messages, replay);

  for (const [prompt, code] of [
    ['invalid-tool-name', 'upstream_protocol_error'], ['invalid-tool-arguments', 'upstream_protocol_error'],
    ['duplicate-tool-id', 'upstream_protocol_error'], ['truncated-tool-stream', 'upstream_protocol_error'],
    ['multiple-tool-calls', 'upstream_tool_choice_failed']
  ]) {
    const response = await fetch(app.origin + endpoint, { method: 'POST',
      headers: { authorization: `Bearer ${app.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...params(prompt), stream: true, parallel_tool_calls: false })
    });
    const frames = [];
    for await (const data of sse(response.body)) {
      assert.notEqual(data, '[DONE]');
      frames.push(JSON.parse(data));
    }
    assert.equal(frames.at(-1).error.code, code);
    assert.ok(frames.every(frame => !frame.choices?.[0]?.delta.tool_calls));
    assert.equal(app.gateway.history[0].errorCode, code);
  }
  for (const [prompt, finishReason] of [['length-limit', 'length'], ['content-filter', 'content_filter']]) {
    const request = { ...params(prompt), tool_choice: 'required' };
    const [incomplete] = (await client.chat.completions.create(request)).choices;
    assert.equal(incomplete.finish_reason, finishReason);
    assert.equal(incomplete.message.tool_calls, undefined);
    let reason;
    for await (const { choices: [chunk] } of await client.chat.completions.create({ ...request, stream: true })) {
      assert.equal(chunk?.delta.tool_calls, undefined);
      if (chunk?.finish_reason) reason = chunk.finish_reason;
    }
    assert.equal(reason, finishReason);
  }
});

test('Ollama Chat accepts a single tool limit and replays a generated call ID through the SDK', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const model = (await app.connection('ollama', upstream.origin)) + '/local:small';
  await app.enable(model);
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'native-tool-no-id' }];
  const params = { model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false };
  const [choice] = (await client.chat.completions.create(params)).choices;
  const [call] = choice.message.tool_calls;
  assert.match(call.id, /^call_[0-9a-f-]+$/);
  assert.equal(call.function.arguments, '{}');
  assert.equal(choice.message.content, '我会查询。');
  assert.equal(choice.finish_reason, 'tool_calls');
  const replay = [...messages, choice.message, { role: 'tool', tool_call_id: call.id, content: '22°C' }];
  const answer = await client.chat.completions.create({ model, messages: replay });
  assert.equal(answer.choices[0].message.content, '工具结果：22°C');
  assert.deepEqual(upstream.calls.at(-1).body.messages.slice(-2), [
    { role: 'assistant', content: '我会查询。', tool_calls: [{ id: call.id, function: { index: 0, name: 'weather', arguments: {} } }] },
    { role: 'tool', content: '22°C', tool_name: 'weather', tool_call_id: call.id }
  ]);

  const disabled = await client.chat.completions.create({ ...params, tool_choice: 'none' });
  assert.equal(disabled.choices[0].finish_reason, 'stop');
  assert.equal(upstream.calls.at(-1).body.tools, undefined);
  const count = upstream.calls.length;
  await assert.rejects(client.chat.completions.create({ ...params, parallel_tool_calls: true }),
    error => error.status === 400 && error.param === 'parallel_tool_calls');
  assert.equal(upstream.calls.length, count);
});

test('malformed inputs, unsupported modalities, HTTP destinations and broken histories are rejected', async t => {
  const app = await setup(t);
  const bad = await app.mutate('/admin/connections', 'POST', { name: 'unsafe', type: 'openai', baseUrl: 'http://example.com/v1' });
  assert.equal(bad.status, 400);
  const history = await app.request('/v1/chat/completions', 'POST', { model: 'unknown', messages: [{ role: 'tool', content: 'bad', tool_call_id: 'missing' }] });
  assert.equal(history.status, 400);
  for (const [body, code] of [
    [{ messages, n: 2 }, 'unsupported_parameter'],
    [{ messages: [{ role: 'user' }] }, 'unsupported_content'],
    [{ messages: [{ role: 'assistant' }] }, 'unsupported_content'],
    [{ messages: [{ role: 'user', content: [] }] }, 'invalid_request'],
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 12 }] }] }, 'invalid_request'],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] }, 'unsupported_content']
  ]) {
    const result = await app.request('/v1/chat/completions', 'POST', { model: 'unknown', ...body });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, code);
  }
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
  assert.equal(reopened.decrypt(reopened.connectionKey(reopened.read().connections[0])), 'fixture-upstream');
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

test('structured refusals complete as JSON and SSE and can be replayed in assistant history', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const model = (await app.connection('openai', `${upstream.origin}/v1`)) + '/shared';
  await app.enable(model);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'Refusal test', models: [model] })).data;
  const endpoint = '/v1/chat/completions';
  const prompt = [{ role: 'user', content: 'refuse-structured' }];
  const formats = [{ type: 'json_object' }, { type: 'json_schema', json_schema: {
    name: 'answer', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'], additionalProperties: false }
  } }];
  const sdk = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: token, maxRetries: 0 });
  for (const response_format of formats) {
    const body = { model, messages: prompt, response_format, tools, tool_choice: 'required' };
    const completion = await sdk.chat.completions.create(body);
    const { message, finish_reason: finishReason } = completion.choices[0];
    assert.deepEqual(message, { role: 'assistant', content: null, refusal: 'Fixture refusal.' });
    assert.equal(finishReason, 'stop');
    assert.equal(completion.usage.total_tokens, 12);
    assert.equal(app.gateway.history[0].status, 'succeeded');

    const response = await fetch(app.origin + endpoint, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.ok(response.headers.get('x-request-id'));
    const frames = [];
    for await (const frame of sse(response.body)) frames.push(frame);
    assert.equal(frames.pop(), '[DONE]');
    const chunks = frames.map(frame => JSON.parse(frame));
    assert.ok(chunks.every(chunk => !chunk.error));
    assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.refusal ?? '').join(''), message.refusal);
    assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
    assert.equal(chunks.at(-1).usage.total_tokens, 12);
    assert.equal(app.gateway.history[0].status, 'succeeded');

    const history = [...prompt, message, { role: 'user', content: 'Continue with a new question.' }];
    const next = await app.request(endpoint, 'POST', { model, messages: history }, token);
    assert.equal(next.status, 200);
    assert.deepEqual(upstream.calls.at(-1).body.messages, history);
  }

  const malformedRefusal = await app.request(endpoint, 'POST', { model,
    messages: [{ role: 'user', content: 'refuse-invalid' }], response_format: formats[0] }, token);
  assert.equal(malformedRefusal.status, 502);
  assert.equal(malformedRefusal.data.error.code, 'upstream_protocol_error');
});

test('upstream 429 preserves only supported Retry-After values before streaming starts', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
  const model = (await app.connection('openai', `${upstream.origin}/v1`)) + '/shared';
  await app.enable(model);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'Rate limit test', models: [model] })).data;
  for (const [variant, expected] of Object.entries({ seconds: '90', date: 'Thu, 01 Jan 2099 00:00:00 GMT', invalid: null, missing: null })) {
    const result = await app.request('/v1/chat/completions', 'POST', {
      model, messages: [{ role: 'user', content: `rate-limit-${variant}` }], stream: true
    }, token);
    assert.equal(result.status, 429);
    assert.equal(result.data.error.code, 'upstream_rate_limited');
    assert.equal(result.response.headers.get('retry-after'), expected);
    assert.equal(result.response.headers.get('x-request-id'), app.gateway.history[0].id);
    assert.doesNotMatch(JSON.stringify(result.data), /private provider error/);
  }
  assert.equal(upstream.calls.length, 4, 'the gateway submits each request once');
});
