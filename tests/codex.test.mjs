import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import OpenAI, { toFile } from 'openai';
import { sse } from '../packages/protocol/events.mjs';
import { CodexRequestQueue } from '../packages/core/codex-request-queue.mjs';
import { setup, until } from './helpers.mjs';
const imageEndpoint = '/v1/images/generations';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxoAAAAASUVORK5CYII=', 'base64');
const pngData = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
const chatEndpoint = '/v1/chat/completions';

test('Codex sessions resume native turns, replay without spending tokens and isolate project keys', async t => {
  const app = await setup(t);
  const connection = await app.connection('codex'), model = `${connection}/codex-fixture`;
  await app.enable(model);
  const key = async name => (await app.mutate('/admin/keys', 'POST', { name, models: [model] })).data;
  const first = await key('one workspace'), second = await key('another workspace');
  const model_dock_session = { id: '1'.repeat(64) };
  const messages = [{ role: 'user', content: 'original fixture turn' }];
  const body = { model, model_dock_session, messages };
  const original = await app.request(chatEndpoint, 'POST', body, first.token);
  assert.equal(original.status, 200, JSON.stringify(original.data));
  const receipt = original.response.headers.get('location');
  assert.equal((await app.request(receipt, 'GET', undefined, first.token)).data.status, 'succeeded');
  assert.equal((await app.request(receipt, 'GET', undefined, second.token)).status, 404);
  const repeated = await app.request(chatEndpoint, 'POST', body, first.token);
  assert.deepEqual(repeated.data.choices, original.data.choices);
  assert.equal(repeated.data.usage.total_tokens, 0);
  const independent = await app.request(chatEndpoint, 'POST', body, second.token);
  assert.equal(independent.data.usage.total_tokens, 14);
  const turn = [...messages, original.data.choices[0].message, { role: 'user', content: 'fixture-session-continue' }];
  const continued = await app.request(chatEndpoint, 'POST', { ...body, messages: turn }, first.token);
  assert.equal(continued.data.choices[0].message.content, 'native session resumed');
  assert.equal(continued.data.usage.total_tokens, 14);
  const audit = (await app.request(`/admin/usage/analytics?mode=calls&project=${first.id}`)).data;
  assert.equal(audit.summary.replayed, 1);
  assert.equal(audit.summary.calls, 2);
  assert.equal(audit.rows.find(row => row.id === repeated.data.id).kind, 'replay');
  const branch = await app.request(chatEndpoint, 'POST', { ...body, model_dock_session: { id: '2'.repeat(64), parent_id: model_dock_session.id, mode: 'snapshot' },
    messages: [{ role: 'user', content: 'fixture-session-fork' }] }, first.token);
  assert.equal(branch.data.choices[0].message.content, 'native session forked');
  const directory = `${app.directory}/codex-sessions`;
  const receipts = await Promise.all((await fs.readdir(directory)).map(file => fs.readFile(`${directory}/${file}`, 'utf8')));
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(record => !record.includes('original fixture turn') && !record.includes('native session resumed')));
  const large = { model, messages: [{ role: 'user', content: 'a'.repeat(2 * 1024 * 1024) }] };
  assert.equal((await app.request(chatEndpoint, 'POST', large, first.token)).status, 200);
  assert.equal((await app.request(chatEndpoint, 'POST', large)).status, 413);
});

test('Codex image receipts use the owning project store, deduplicate and cancel without losing the operation', async t => {
  const stores = new Map(), rows = new Map();
  const app = await setup(t, { imageStores: stores });
  const connection = await app.connection('codex'), model = `${connection}/codex-imagegen`;
  await app.enable(model);
  const key = async name => (await app.mutate('/admin/keys', 'POST', { name, models: [model] })).data;
  const project = await key('image workspace'), other = await key('other image consumer');
  let submissions = 0;
  stores.set(project.id, async (action, values) => {
    const { id } = values;
    if (action === 'read') return rows.get(id) || null;
    if (action === 'claim') {
      assert.equal(rows.has(id), false);
      submissions++;
      const row = { id, input_hash: values.hash, status: 'running' }; rows.set(id, row);
      return { created: true, row };
    }
    const row = rows.get(id);
    switch (action) {
      case 'recordIdentity': return Object.assign(row, { thread_id: values.identity.threadId, turn_id: values.identity.turnId });
      case 'markUnknown': if (row.status !== 'succeeded') Object.assign(row, { status: 'outcome_unknown', error_code: values.code }); return;
      case 'save': return Object.assign(row, { status: 'succeeded', result: values.result });
      case 'result': return { data: [{ b64_json: row.result.b64Json }], usage: row.result.usage };
      default: assert.fail(`Unexpected image storage action ${action}`);
    }
  });
  const catalog = (await app.request('/v1/models', 'GET', undefined, project.token)).data.data;
  assert.equal(catalog[0].image_operations, true);
  const body = { model, prompt: 'first image fixture', operation_id: 'a'.repeat(64) };
  const pair = await Promise.all([app.request(imageEndpoint, 'POST', body, project.token), app.request(imageEndpoint, 'POST', body, project.token)]);
  assert.deepEqual(pair.map(item => item.status), [202, 202]);
  assert.deepEqual(pair.map(item => item.data.reused).sort(), [false, true]);
  const location = pair[0].response.headers.get('location');
  assert.equal((await app.request(location, 'GET', undefined, other.token)).status, 404);
  assert.equal((await app.request(imageEndpoint, 'POST', { ...body, prompt: 'different input' }, project.token)).status, 409);
  await until(() => rows.get(body.operation_id).status === 'succeeded' && app.gateway.active.size === 0);
  assert.equal((await app.request(`${location}/result`, 'GET', undefined, project.token)).data.data[0].b64_json, png.toString('base64'));
  assert.equal(submissions, 1);
  const recoveryId = 'c'.repeat(64);
  const { thread_id, turn_id } = rows.get(body.operation_id);
  rows.set(recoveryId, { id: recoveryId, status: 'running', thread_id, turn_id });
  assert.equal((await app.request(`/v1/images/operations/${recoveryId}`, 'GET', undefined, project.token)).data.status, 'succeeded');
  assert.equal(submissions, 1);

  const slow = await app.request(imageEndpoint, 'POST', { model, prompt: 'slow-image', operation_id: 'b'.repeat(64) }, project.token);
  assert.equal(slow.status, 202);
  const slowLocation = slow.response.headers.get('location');
  assert.equal((await app.request(`${slowLocation}/cancel`, 'POST', {}, project.token)).data.status, 'outcome_unknown');
  await until(() => app.gateway.active.size === 0);
  assert.equal((await app.request(slowLocation, 'GET', undefined, project.token)).data.status, 'outcome_unknown');
  assert.equal(submissions, 2);
});

test('Codex requests from separate project keys wait for the single slot', async t => {
  const app = await setup(t, { codexQueueWaitMs: 2000 });
  const connectionId = await app.connection('codex');
  const model = `${connectionId}/codex-fixture`;
  await app.enable(model);
  const makeKey = async name => {
    const result = await app.mutate('/admin/keys', 'POST', { name, models: [model] });
    assert.equal(result.status, 200);
    return result.data;
  };
  const first = await makeKey('first workspace');
  const second = await makeKey('second workspace');
  const third = await makeKey('revoked workspace');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const slow = fetch(`${app.origin}${chatEndpoint}`, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'slow' }] })
  });
  const stopped = assert.rejects(slow, { name: 'AbortError' });
  stopped.catch(() => {});
  await until(() => app.gateway.active.size === 1);
  const body = { model, messages: [{ role: 'user', content: 'hello' }] };
  const queued = app.request(chatEndpoint, 'POST', body, second.token);
  const revoked = app.request(chatEndpoint, 'POST', body, third.token);
  await until(() => app.gateway.snapshot().codexWaiting === 2);
  assert.equal(app.gateway.active.size, 1);
  assert.equal((await app.mutate(`/admin/keys/${third.id}`, 'DELETE')).status, 200);
  assert.equal((await revoked).data.error.code, 'key_revoked');
  controller.abort();
  await stopped;
  const result = await queued;
  assert.equal(result.status, 200);
  assert.equal(result.data.usage.total_tokens, 14);
  assert.equal(app.gateway.snapshot().codexWaiting, 0);
  assert.equal(app.gateway.history[0].principalId, second.id);
});

test('Codex waiters are bounded and time out before taking a slot', async () => {
  const queue = new CodexRequestQueue(50);
  const signal = new AbortController().signal;
  const release = queue.acquire('held', signal, 'first', 'codex');
  const expires = Array.from({ length: 8 }, (_, index) =>
    assert.rejects(queue.acquire(String(index), signal, 'next', 'codex'), { code: 'connection_busy' }));
  assert.throws(() => queue.acquire('extra', signal, 'next', 'codex'), { code: 'connection_busy' });
  await Promise.all(expires);
  assert.equal(queue.waitingCount, 0);
  release();
  assert.equal(typeof queue.acquire('fresh', signal, 'next', 'codex'), 'function');
});

test('two Codex requests run in parallel and a third waits for a released slot', async t => {
  const app = await setup(t, { codexMaxConcurrency: 2, codexQueueWaitMs: 4000 });
  const connection = await app.connection('codex'), model = `${connection}/codex-fixture`;
  assert.equal((await app.mutate(`/admin/connections/${connection}`, 'PATCH', { maxConcurrency: 2 })).status, 200);
  await app.enable(model);
  const startSlow = () => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const request = fetch(`${app.origin}${chatEndpoint}`, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${app.store.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'slow' }] })
    });
    const stopped = assert.rejects(request, { name: 'AbortError' });
    stopped.catch(() => {});
    return { controller, stopped };
  };
  const first = startSlow();
  await until(() => app.gateway.active.size === 1);
  const second = startSlow();
  await until(() => app.gateway.active.size === 2);
  const third = app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'hello' }] });
  await until(() => app.gateway.snapshot().codexWaiting === 1);
  assert.equal(app.gateway.active.size, 2);
  first.controller.abort();
  await first.stopped;
  assert.equal((await third).status, 200);
  assert.equal(app.gateway.snapshot().codexWaiting, 0);
  assert.equal(app.gateway.active.size, 1);
  second.controller.abort();
  await second.stopped;
  await until(() => app.gateway.active.size === 0);
});

test('an already full Codex connection queues even if the gateway has a spare slot', async () => {
  const queue = new CodexRequestQueue(4000, 2);
  const signal = new AbortController().signal;
  const release = queue.acquire('active', signal, 'test', 'same-connection', 1);
  const waiting = queue.acquire('queued', signal, 'test', 'same-connection', 1);
  assert.equal(queue.waitingCount, 1);
  release();
  const releaseNext = await waiting;
  assert.equal(queue.waitingCount, 0);
  releaseNext();
});

test('Codex validates structured text before opening the response stream', async t => {
  const app = await setup(t), id = await app.connection('codex'), model = `${id}/codex-fixture`;
  await app.enable(model);
  const response = await app.request(chatEndpoint, 'POST', {
    model, messages: [{ role: 'user', content: 'hello' }], stream: true,
    response_format: { type: 'json_object' }
  });
  assert.equal(response.status, 502);
  assert.equal(response.data.error.code, 'upstream_json_invalid');
});

test('Codex JSON-RPC bridge isolates host tools, preserves native history, filters commentary and tracks usage', async t => {
  const app = await setup(t), id = await app.connection('codex'), model = `${id}/codex-fixture`;
  await app.enable(model);
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  const result = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'low' });
  assert.equal(result.choices[0].message.content, 'Codex 测试回答'); assert.equal(result.usage.total_tokens, 14);
  const history = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'prior answer' }, { role: 'user', content: 'continue' }] });
  assert.equal(history.choices[0].message.content, '原生角色历史已保留');
  let text = '';
  for await (const chunk of await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello' }], stream: true })) text += chunk.choices[0]?.delta.content || '';
  assert.equal(text, 'Codex 测试回答');
});

test('Codex hands function execution to the caller and reconstructs tool results at tool authority', async t => {
  const app = await setup(t), id = await app.connection('codex'), model = `${id}/codex-fixture`;
  await app.enable(model);
  const messages = [{ role: 'user', content: 'tools' }];
  const result = await app.request(chatEndpoint, 'POST', { model, messages, tools, tool_choice: 'required' });
  assert.equal(result.status, 200); const choice = result.data.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls'); assert.equal(choice.message.tool_calls[0].function.name, 'weather');
  const { tool_calls } = choice.message;
  assert.deepEqual(tool_calls.map(call => call.id), ['call_codex']);
  const next = await app.request(chatEndpoint, 'POST', { model, tools, messages: [...messages,
    { role: 'assistant', tool_calls }, { role: 'tool', tool_call_id: 'call_codex', content: [{ type: 'text', text: '22°C' }] }] });
  assert.equal(next.status, 200); assert.equal(next.data.choices[0].message.content, '工具结果：22°C');
  const client = new OpenAI({ baseURL: app.origin + '/v1', apiKey: app.admin, maxRetries: 0 });
  const namedTools = [...tools, { type: 'function', function: { name: 'clock', parameters: { type: 'object' } } }];
  const stream = await client.chat.completions.create({ model, n: 1, stream: true, parallel_tool_calls: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'too' }, { type: 'text', text: 'ls' }] }],
    tools: namedTools, tool_choice: { type: 'function', function: { name: 'weather' } } });
  const calls = [], reasons = [];
  for await (const chunk of stream) {
    const first = chunk.choices[0];
    if (first?.delta.tool_calls) calls.push(...first.delta.tool_calls);
    if (first?.finish_reason) reasons.push(first.finish_reason);
  }
  assert.deepEqual(reasons, ['tool_calls']);
  assert.deepEqual(calls, [{ index: 0, id: 'call_codex', type: 'function',
    function: { name: 'weather', arguments: '{"city":"杭州"}' } }]);
  assert.equal(app.gateway.active.size, 0);
});

test('Codex rejects unenforceable token limits and unknown efforts; native errors are sanitized', async t => {
  const app = await setup(t), id = await app.connection('codex'), model = `${id}/codex-fixture`;
  await app.enable(model);
  const messages = [{ role: 'user', content: 'hello' }];
  for (const extra of [{ max_tokens: 10 }, { temperature: 0.2 }, { reasoning_effort: 'ultra' }, { parallel_tool_calls: true }]) {
    const result = await app.request('/v1/chat/completions', 'POST', { model, messages, ...extra });
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'unsupported_parameter');
  }
  const failed = await app.request('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'failure' }] });
  assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed.data).includes('/private/secret'));
  const network = await app.request('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'network_failure' }] });
  assert.equal(network.status, 502); assert.equal(network.data.error.code, 'codex_connection_failed');
  const limited = await app.request('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'usage_limit' }] });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'codex_rate_limited');
  assert.equal(limited.response.headers.get('retry-after'), null);
  for (const [prompt, status, code] of [
    ['context_limit', 400, 'context_length_exceeded'], ['bad_request', 400, 'codex_bad_request'],
    ['rate_limit', 429, 'codex_rate_limited'], ['http_rate_limit', 429, 'codex_rate_limited']
  ]) {
    const result = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: prompt }] });
    assert.equal(result.status, status);
    assert.equal(result.data.error.code, code);
    assert.equal(result.response.headers.get('retry-after'), null);
    assert.doesNotMatch(JSON.stringify(result.data), /private\/secret/);
  }
  const retried = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'retryable-native-error' }] });
  assert.equal(retried.status, 200);
});

test('Codex emits each answer item once and reports empty or inconsistent output as a protocol error', async t => {
  const app = await setup(t), model = (await app.connection('codex')) + '/codex-fixture';
  await app.enable(model);
  const body = { model, messages: [{ role: 'user', content: 'complete-message-items' }] };
  const json = await app.request(chatEndpoint, 'POST', body);
  assert.equal(json.status, 200);
  assert.equal(json.data.choices[0].message.content, 'First. Last.');
  for (const [prompt, expected, failed] of [
    ['complete-message-items', 'First. Last.', false], ['inconsistent-message-items', 'First', true]
  ]) {
    const response = await fetch(app.origin + chatEndpoint, { method: 'POST',
      headers: { authorization: 'Bearer ' + app.admin, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }) });
    assert.equal(response.status, 200);
    let text = '', terminal;
    for await (const frame of sse(response.body)) {
      if (frame === '[DONE]') terminal = frame;
      else {
        const chunk = JSON.parse(frame);
        if (chunk.error) terminal = chunk.error.code;
        text += chunk.choices?.[0]?.delta?.content || '';
      }
    }
    assert.equal(text, expected);
    assert.equal(terminal, failed ? 'codex_protocol_error' : '[DONE]');
  }
  const empty = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'empty-completion' }], stream: true });
  assert.equal(empty.status, 502);
  assert.equal(empty.data.error.code, 'codex_protocol_error');
});

test('Codex restarts a cancelled turn whose start reply is unavailable', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url));
  const children = [];
  let startRequested = false;
  const app = await setup(t, { codex: { rpcTimeout: 1500, spawnImpl(_binary, args, config) {
    const child = spawn(process.execPath, [fixture, ...args], config);
    if (!args.includes('--enable')) {
      children.push(child);
      readline.createInterface({ input: child.stdout }).on('line', line => {
        if (JSON.parse(line).method === 'fixture/turnAccepted') startRequested = true;
      });
    }
    return child;
  } } });
  const model = (await app.connection('codex')) + '/codex-fixture';
  await app.enable(model);
  const pending = app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'cancel-before-start-ack' }] });
  await until(() => startRequested);
  const exited = once(children[0], 'exit');
  const id = [...app.gateway.active.keys()][0];
  assert.equal((await app.request('/admin/requests/' + id + '/cancel', 'POST', {})).status, 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.data.error.code, 'request_cancelled');
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  await exited;
  assert.equal(app.gateway.active.size, 0);
  const result = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.status, 200);
  assert.equal(children.length, 2);
});

test('Codex keeps its slot after the interrupt ACK and recovers from a missing native terminal event', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url));
  const children = [];
  let interruptedThread;
  const app = await setup(t, { codex: { rpcTimeout: 1500, interruptTimeout: 1000, spawnImpl(_binary, args, config) {
    const child = spawn(process.execPath, [fixture, ...args], config);
    if (!args.includes('--enable')) {
      children.push(child);
      readline.createInterface({ input: child.stdout }).on('line', line => {
        const event = JSON.parse(line);
        if (event.method === 'fixture/interruptAccepted') interruptedThread = event.params.threadId;
      });
    }
    return child;
  } } });
  const model = (await app.connection('codex')) + '/codex-fixture';
  await app.enable(model);
  for (const prompt of ['await-interrupt-terminal', 'no-interrupt-terminal']) {
    interruptedThread = undefined;
    const abort = new AbortController();
    const response = await fetch(app.origin + chatEndpoint, { method: 'POST', signal: abort.signal,
      headers: { authorization: 'Bearer ' + app.admin, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }) });
    assert.equal(response.status, 200);
    const frames = sse(response.body);
    assert.match((await frames.next()).value, /"role":"assistant"/);
    assert.match((await frames.next()).value, /Partial/);
    abort.abort();
    await frames.return();
    await until(() => interruptedThread);
    assert.equal(app.gateway.active.size, 1, 'an interrupt ACK alone does not release capacity');
    const busy = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(busy.status, 429);
    if (prompt === 'await-interrupt-terminal') {
      children[0].stdin.write(JSON.stringify({ method: 'fixture/finishInterrupt', params: { threadId: interruptedThread } }) + '\n');
    }
    await until(() => app.gateway.active.size === 0);
    assert.equal(app.gateway.history.find(row => row.id === response.headers.get('x-request-id')).errorCode, 'request_cancelled');
    const result = await app.request(chatEndpoint, 'POST', { model, messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.status, 200);
    assert.equal(children.length, prompt === 'await-interrupt-terminal' ? 1 : 2);
  }
});

test('Codex publishes an independent image model and enforces project access and media type', async t => {
  const app = await setup(t), connection = await app.connection('codex');
  const model = `${connection}/codex-imagegen`, textModel = `${connection}/codex-fixture`;
  const endpoint = '/v1/images/generations';
  const request = { model, prompt: 'blue cup' };
  const imageKey = (await app.mutate('/admin/keys', 'POST', { name: 'images', models: [model] })).data.token;
  const textKey = (await app.mutate('/admin/keys', 'POST', { name: 'text', models: [textModel] })).data.token;
  assert.equal((await app.request(endpoint, 'POST', request, '')).status, 401);
  assert.equal((await app.request(endpoint, 'POST', request, textKey)).status, 403);
  assert.equal((await app.request(endpoint, 'POST', request, imageKey)).status, 404);
  await app.enable(model);
  await app.enable(textModel);
  const sdk = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: imageKey, maxRetries: 0 });
  const catalog = (await sdk.models.list()).data;
  assert.deepEqual(catalog.map(item => item.id), [model]);
  assert.equal(catalog[0].capabilities.image_generation, true);
  assert.equal(catalog[0].capabilities.text, false);
  const wrongEndpoint = await app.request('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'hello' }] }, imageKey);
  assert.equal(wrongEndpoint.data.error.code, 'unsupported_model_capability');
  assert.equal((await app.request(endpoint, 'POST', { ...request, model: textModel }, textKey)).data.error.code, 'unsupported_model_capability');
  for (const extra of [{ n: 2 }, { response_format: 'url' }, { prompt: ' ' }, { reference_images: ['unused'] }]) {
    assert.equal((await app.request(endpoint, 'POST', { ...request, ...extra }, imageKey)).status, 400);
  }
  assert.equal(app.gateway.history.length, 0);
  assert.equal((await app.mutate('/admin/usage/prices', 'PATCH', { modelId: model, price: { currency: 'USD', perImage: 0.25 } })).status, 200);
  const image = await sdk.images.generate({ ...request, n: 1, response_format: 'b64_json' });
  assert.equal(image.output_format, 'png');
  assert.equal(image.data.length, 1);
  assert.equal(image.data[0].width, 1);
  assert.equal(image.data[0].height, 1);
  assert.equal(Buffer.from(image.data[0].b64_json, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const attachment = await toFile(png, 'reference.png', { type: 'image/png' });
  await assert.rejects(sdk.images.edit({ model, prompt: 'Edit the reference', image: attachment }), { status: 404, code: 'not_found' });
  const edited = await app.request(endpoint, 'POST', { ...request, reference_images: [pngData(png)] }, imageKey);
  assert.equal(edited.status, 200);
  assert.equal(edited.data.data[0].b64_json, image.data[0].b64_json);
  const invalid = await app.request(endpoint, 'POST', { ...request, prompt: 'invalid-image' }, imageKey);
  assert.equal(invalid.data.error.code, 'codex_image_result_invalid');
  assert.doesNotMatch(JSON.stringify(invalid.data), /private\/secret/);
  assert.doesNotMatch(JSON.stringify(app.gateway.history), /b64_json|blue cup|private\/secret/);
  const report = (await app.request('/admin/usage')).data;
  assert.equal(report.total.images, 2);
  assert.deepEqual(report.total.estimates, { USD: 0.5 });
});

test('Codex accepts ordered image references larger than the chat body limit and cleans up the files', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url));
  let imageDirectory;
  const app = await setup(t, { codex: { rpcTimeout: 1500, spawnImpl(_binary, args, config) {
    if (args.includes('--enable') && args[args.indexOf('--enable') + 1] === 'image_generation') imageDirectory = config.cwd;
    return spawn(process.execPath, [fixture, ...args], config);
  } } });
  const connection = await app.connection('codex'), model = `${connection}/codex-imagegen`;
  await app.enable(model);
  const first = Buffer.alloc(1024 * 1024, 'A'), second = Buffer.alloc(1024 * 1024, 'B');
  png.copy(first); png.copy(second);
  const reference_images = [pngData(first), pngData(second)];
  const result = await app.request(imageEndpoint, 'POST', { model, prompt: 'fixture-edit', aspect_ratio: '9:16', background: 'transparent', reference_images });
  assert.equal(result.status, 200);
  assert.equal(result.data.data[0].b64_json, png.toString('base64'));
  assert.ok(imageDirectory);
  assert.deepEqual(await fs.readdir(imageDirectory), []);
  const chat = await app.request('/v1/chat/completions', 'POST', { model: `${connection}/codex-fixture`, messages: [{ role: 'user', content: reference_images.join('') }] });
  assert.equal(chat.status, 413);
  const attempts = [
    [{ reference_images: Array(6).fill(pngData(png)) }, 'reference_images'],
    [{ reference_images: [pngData(png).replace('png;', 'jpeg;')] }, 'reference_images[0]'],
    [{ reference_images: ['file:///tmp/reference.png'] }, 'reference_images[0]'],
    [{ reference_images: ['data:image/png;base64,h!!!'] }, 'reference_images[0]'],
    [{ aspect_ratio: '3:1' }, 'aspect_ratio'],
    [{ background: 'opaque' }, 'background'],
    [{ mask: 'unused' }, 'mask']
  ];
  for (const [extra, param] of attempts) {
    const response = await app.request(imageEndpoint, 'POST', { model, prompt: 'blue cup', ...extra });
    assert.equal(response.status, 400);
    assert.equal(response.data.error.param, param);
  }
  assert.equal(app.gateway.history.length, 1);
  assert.doesNotMatch(JSON.stringify(app.gateway.history), /reference_images|base64|reference-1/);
});

test('Codex images share the text concurrency limit and stop when the project key is revoked', async t => {
  const app = await setup(t), connection = await app.connection('codex');
  const model = `${connection}/codex-imagegen`, textModel = `${connection}/codex-fixture`;
  await app.enable(model);
  await app.enable(textModel);
  const { id, token } = (await app.mutate('/admin/keys', 'POST', { name: 'images', models: [model] })).data;
  const pending = app.request(imageEndpoint, 'POST', { model, prompt: 'slow-image', reference_images: [pngData(png)] }, token);
  await until(() => app.gateway.active.size === 1);
  const text = await app.request('/v1/chat/completions', 'POST', { model: textModel, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(text.status, 429);
  assert.equal(text.data.error.code, 'connection_busy');
  assert.equal((await app.mutate(`/admin/keys/${id}`, 'DELETE')).status, 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, 401);
  assert.equal(cancelled.data.error.code, 'key_revoked');
  assert.equal(app.gateway.active.size, 0);
  assert.equal(app.gateway.history[0].status, 'cancelled');
  assert.equal((await app.request('/v1/images/generations', 'POST', { model, prompt: 'blue cup' })).status, 200);
});
