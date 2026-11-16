import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { fixtureUpstream, setup, until } from './helpers.mjs';

const endpoint = '/v1/responses';
const tools = [{ type: 'function', name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
const userMessage = content => ({ role: 'user', content });

async function setupResponses(t, providers) {
  const app = await setup(t);
  const upstream = providers.some(provider => provider !== 'codex') ? await fixtureUpstream(t) : null;
  const modelIds = {};
  for (const provider of providers) {
    const origin = provider === 'codex' ? undefined : upstream.origin + (provider === 'openai' ? '/v1' : '');
    const connection = await app.connection(provider, origin);
    modelIds[provider] = `${connection}/${{ openai: 'shared', ollama: 'local:small', codex: 'codex-fixture' }[provider]}`;
    await app.enable(modelIds[provider]);
  }
  const { data } = await app.mutate('/admin/keys', 'POST', { name: 'Responses fixtures', models: Object.values(modelIds) });
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: data.token, maxRetries: 0 });
  return { app, upstream, modelIds, key: data.token, client };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ['response.created', 'response.in_progress']);
  assert.equal(events.filter(event => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)).length, 1);
  assert.equal(events.at(-1).response.id, events[0].response.id);
  return events;
}

test('Responses SDK creates and streams stateless text with the three existing adapters', async t => {
  const { app, upstream, modelIds, client } = await setupResponses(t, ['openai', 'ollama', 'codex']);
  const expected = { openai: '你好，来自测试上游。', ollama: '本机回答', codex: 'Codex 测试回答' };
  for (const [provider, model] of Object.entries(modelIds)) {
    const result = await client.responses.create({ model, input: 'Say hello.', instructions: 'Answer briefly.' });
    assert.match(result.id, /^resp_/);
    assert.equal(result.model, model);
    assert.equal(result.object, 'response');
    assert.equal(result.status, 'completed');
    assert.equal(result.store, false);
    assert.equal(result.output_text, expected[provider]);
    assert.equal(result.output[0].status, 'completed');
    assert.ok(result.usage.input_tokens > 0);
    assert.ok(result.usage.output_tokens > 0);
    const params = { model, store: false, instructions: 'Answer briefly.', input: [
      userMessage('Say hello.'), ...result.output, userMessage([{ type: 'input_text', text: 'Follow ' }, { type: 'input_text', text: 'up.' }])
    ] };
    const events = await collect(await client.responses.create({ ...params, stream: true }));
    assert.deepEqual(events.slice(2, 4).map(event => event.type), ['response.output_item.added', 'response.content_part.added']);
    const output = events.at(-1).response.output[0];
    const text = provider === 'codex' ? '原生角色历史已保留' : expected[provider];
    assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(output.content[0].text, text);
    const deltas = events.filter(event => event.type === 'response.output_text.delta');
    assert.ok(deltas.length > 0);
    assert.equal(deltas.map(event => event.delta).join(''), text);
    assert.ok(deltas.every(event => event.item_id === output.id && event.output_index === 0 && event.content_index === 0));
    assert.deepEqual(events.slice(-4).map(event => event.type), ['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
    assert.equal(events.at(-1).response.usage.total_tokens, result.usage.total_tokens);
    assert.equal(app.gateway.history[0].id, events.at(-1).response.id);
  }
  const httpCalls = upstream.calls.filter(call => call.url.endsWith('/chat') || call.url.endsWith('/chat/completions'));
  assert.deepEqual(httpCalls.map(call => call.url), ['/v1/chat/completions', '/v1/chat/completions', '/api/chat', '/api/chat']);
  for (const { url, body } of httpCalls) {
    assert.deepEqual(body.messages[0], { role: 'system', content: 'Answer briefly.' });
    assert.equal(body.store, url === '/v1/chat/completions' ? false : undefined);
    assert.equal(body.stream_options, undefined);
    if (body.messages.length > 2) assert.deepEqual(body.messages.at(-1), userMessage('Follow up.'));
  }
  const highLevel = client.responses.stream({ model: modelIds.openai, input: 'hello' });
  const completed = await highLevel.finalResponse();
  assert.equal(completed.output_text, expected.openai);
  const replayed = await client.responses.create({ model: modelIds.openai, input: [userMessage('hello'), ...completed.output, userMessage('continue')] });
  assert.equal(replayed.output_text, expected.openai);
  assert.deepEqual(upstream.calls.at(-1).body.messages[1], { role: 'assistant', content: expected.openai });
});

test('Responses requests stream usage from the official OpenAI host', async t => {
  const upstream = await fixtureUpstream(t, undefined, { usageOptIn: true }), app = await setup(t);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    if (typeof input !== 'string' || new URL(input).origin !== 'https://api.openai.com') return fetch(input, options);
    const url = new URL(input);
    return fetch(upstream.origin + url.pathname, options);
  });
  const model = (await app.connection('openai', 'https://api.openai.com/v1')) + '/shared';
  await app.enable(model);
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  const stream = client.responses.stream({ model, input: 'hello' });
  assert.equal((await stream.finalResponse()).usage.total_tokens, 12);
  assert.deepEqual(upstream.calls.at(-1).body.stream_options, { include_usage: true });
  await client.responses.create({ model, input: 'hello' });
  assert.equal(upstream.calls.at(-1).body.stream_options, undefined);
});

test('Responses SDK replays completed application functions and preserves item and call identity', async t => {
  const { upstream, modelIds, client } = await setupResponses(t, ['openai', 'codex']);
  const choice = { type: 'function', name: 'weather' };
  for (const model of Object.values(modelIds)) {
    const input = [userMessage('tools')];
    const params = { model, input, tools, tool_choice: choice };
    const result = await client.responses.create(params);
    const [func] = result.output;
    assert.equal(result.status, 'completed');
    assert.equal(result.output.length, 1);
    assert.equal(result.parallel_tool_calls, false);
    assert.equal(result.tools[0].strict, false);
    assert.deepEqual(result.tool_choice, choice);
    assert.equal(func.type, 'function_call');
    assert.notEqual(func.id, func.call_id);
    assert.equal(func.name, 'weather');
    assert.deepEqual(JSON.parse(func.arguments), { city: '杭州' });
    const stream = client.responses.stream({ ...params, parallel_tool_calls: false });
    const events = await collect(stream);
    const [streamed] = events.at(-1).response.output;
    assert.deepEqual(events.slice(2).map(event => event.type), ['response.output_item.added', 'response.function_call_arguments.delta',
      'response.function_call_arguments.done', 'response.output_item.done', 'response.completed']);
    assert.equal(events[3].item_id, streamed.id);
    assert.equal(events[3].delta, streamed.arguments);
    assert.equal(events[4].arguments, streamed.arguments);
    assert.equal(events[5].item.call_id, streamed.call_id);
    const completed = await stream.finalResponse();
    const next = await client.responses.create({ model, tools, input: [
      ...input, ...completed.output, { type: 'function_call_output', call_id: streamed.call_id, output: '22°C' }
    ] });
    assert.equal(next.output_text, '工具结果：22°C');
    await assert.rejects(client.responses.create({ model, input: [
      ...input, streamed, { type: 'function_call_output', call_id: streamed.id, output: '22°C' }
    ] }), error => error.status === 400 && error.code === 'invalid_request');
  }
  const calls = upstream.calls.filter(call => call.url === '/v1/chat/completions');
  assert.equal(calls[0].body.parallel_tool_calls, false);
  assert.deepEqual(calls[0].body.tool_choice, { type: 'function', function: { name: 'weather' } });
  assert.equal(calls[0].body.tools[0].function.strict, false);
  assert.equal(calls[2].body.messages.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(calls[2].body.messages.at(-1).tool_call_id, 'call_1');
});

test('Ollama Responses SDK streams a single function and replays each completed result without state', async t => {
  const { upstream, modelIds, client } = await setupResponses(t, ['ollama']);
  const model = modelIds.ollama;
  const input = [userMessage('native-tool')];
  const params = { model, input, tools, tool_choice: 'auto' };
  const initial = await client.responses.create(params);
  assert.equal(initial.status, 'completed');
  assert.equal(initial.store, false);
  assert.equal(initial.parallel_tool_calls, false);
  assert.equal(initial.output_text, '我会查询。');
  assert.deepEqual(initial.output.map(item => item.type), ['message', 'function_call']);
  const originalCall = initial.output[1];
  assert.equal(originalCall.call_id, 'call_native_ollama');
  assert.equal(originalCall.arguments, '{}');
  assert.notEqual(originalCall.id, originalCall.call_id);
  const firstResult = { type: 'function_call_output', call_id: originalCall.call_id, output: '{"temp":22}' };

  const nextInput = [...input, ...initial.output, firstResult, userMessage('native-tool-no-id')];
  const stream = client.responses.stream({ ...params, input: nextInput, parallel_tool_calls: false });
  const events = await collect(stream);
  const completed = await stream.finalResponse();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.usage.total_tokens, 7);
  const streamed = completed.output[1];
  assert.match(streamed.call_id, /^call_[0-9a-f-]+$/);
  assert.equal(streamed.arguments, '{}');
  const itemEvents = events.slice(-5);
  assert.deepEqual(itemEvents.map(event => event.type), ['response.output_item.added', 'response.function_call_arguments.delta',
    'response.function_call_arguments.done', 'response.output_item.done', 'response.completed']);
  assert.ok(itemEvents.slice(0, -1).every(event => event.output_index === 1));
  assert.equal(itemEvents[1].item_id, streamed.id);
  assert.equal(itemEvents[1].delta, '{}');

  const finalInput = [...nextInput, ...completed.output,
    { type: 'function_call_output', call_id: streamed.call_id, output: '22°C' }];
  const final = await client.responses.create({ model, input: finalInput });
  assert.equal(final.output_text, '工具结果：22°C');
  const calls = upstream.calls.filter(call => call.url === '/api/chat');
  assert.equal(calls[0].body.parallel_tool_calls, undefined);
  assert.equal(calls[0].body.tool_choice, undefined);
  assert.equal(calls[0].body.tools[0].function.strict, undefined);
  const toolHistory = calls[2].body.messages.filter(message => message.tool_calls || message.role === 'tool');
  assert.deepEqual(toolHistory, [originalCall, streamed].flatMap(({ call_id }, index) => [
    { role: 'assistant', content: '我会查询。', tool_calls: [{ id: call_id, function: { index: 0, name: 'weather', arguments: {} } }] },
    { role: 'tool', tool_name: 'weather', tool_call_id: call_id, content: index === 0 ? firstResult.output : '22°C' }
  ]));
  const count = upstream.calls.length;
  for (const broken of [[...input, ...initial.output], [...input, ...initial.output, firstResult, firstResult]]) {
    await assert.rejects(client.responses.create({ model, input: broken }), error => error.status === 400 && error.code === 'invalid_request');
  }
  assert.equal(upstream.calls.length, count);
  const disabled = await client.responses.create({ ...params, tool_choice: 'none' });
  assert.deepEqual(disabled.output.map(item => item.type), ['message']);
  assert.equal(upstream.calls.at(-1).body.tools, undefined);

  for (const [prompt, terminal, code] of [
    ['native-tool-multiple', 'response.failed', 'upstream_tool_choice_failed'],
    ['native-tool-length', 'response.incomplete', undefined]
  ]) {
    const events = await collect(await client.responses.create({ ...params, input: prompt, stream: true }));
    assert.equal(events.at(-1).type, terminal);
    assert.equal(events.at(-1).response.error?.code, code);
    assert.ok(events.every(event => event.item?.type !== 'function_call' && !event.type.startsWith('response.function_call_arguments.')));
  }
});

test('Responses errors stay on the HTTP boundary until streaming starts', async t => {
  const { app, upstream, modelIds, key, client } = await setupResponses(t, ['openai', 'ollama', 'codex']);
  const params = { model: modelIds.openai, input: 'hello', stream: true };
  const longInput = Array.from({ length: 2048 }, () => userMessage('test'));
  const attempts = [
    [{ store: true }, 'store'], [{ previous_response_id: 'resp_old' }, 'previous_response_id'],
    [{ conversation: 'conv_1' }, 'conversation'], [{ background: true }, 'background'],
    [{ parallel_tool_calls: true }, 'parallel_tool_calls'], [{ max_output_tokens: 0 }, 'max_output_tokens'],
    [{ model: modelIds.codex, max_output_tokens: 50 }, 'max_output_tokens'],
    [{ input: [{ type: 'reasoning', encrypted_content: 'ignored' }] }, 'input'],
    [{ input: [userMessage([{ type: 'input_image', image_url: 'https://example.com/image.png' }])] }, 'input'],
    [{ tools: [{ type: 'web_search' }] }, 'tools'],
    [{ model: modelIds.ollama, tools, tool_choice: 'required' }, 'tool_choice'],
    [{ model: modelIds.ollama, tools, tool_choice: { type: 'function', name: 'weather' } }, 'tool_choice'],
    [{ model: modelIds.ollama, tools: [{ ...tools[0], strict: true }] }, 'tools.function.strict'],
    [{ input: longInput, instructions: 'Answer briefly.' }, 'input']
  ];
  const count = upstream.calls.length;
  for (const [extra, field] of attempts) {
    await assert.rejects(client.responses.create({ ...params, ...extra }), error => error.status === 400 && error.param === field);
  }
  await assert.rejects(client.responses.create({ ...params, model: modelIds.codex, tools: [{ ...tools[0], strict: true }] }),
    error => error.status === 400 && error.param === 'tools.function.strict');
  const unauthorized = await app.request(endpoint, 'POST', params, '');
  assert.equal(unauthorized.status, 401);
  const forbidden = await app.request(endpoint, 'POST', { ...params, model: modelIds.openai.replace(/shared$/, 'slow') }, key);
  assert.equal(forbidden.status, 403);
  assert.equal(upstream.calls.length, count);
  const limited = await app.request(endpoint, 'POST', { ...params, input: 'rate-limit-seconds' }, key);
  assert.equal(limited.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '90');
  assert.equal(limited.data.error.code, 'upstream_rate_limited');
  assert.equal((await app.request(`${endpoint}/resp_example`, 'GET', undefined, key)).status, 404);
});

test('Responses distinguishes refusal, incomplete output and upstream failure and buffers invalid calls', async t => {
  const { app, modelIds, client } = await setupResponses(t, ['openai']);
  const model = modelIds.openai;
  const refusal = await client.responses.create({ model, input: 'refuse-structured', tools, tool_choice: 'required' });
  assert.equal(refusal.status, 'completed');
  assert.equal(refusal.output_text, '');
  assert.deepEqual(refusal.output[0].content, [{ type: 'refusal', refusal: 'Fixture refusal.' }]);
  const events = await collect(client.responses.stream({ model, input: 'refuse-structured' }));
  assert.equal(events.filter(event => event.type === 'response.refusal.delta').map(event => event.delta).join(''), 'Fixture refusal.');
  assert.equal(events.at(-1).type, 'response.completed');
  const history = await client.responses.create({ model, input: [userMessage('initial'), ...refusal.output, userMessage('follow up')] });
  assert.equal(history.status, 'completed');
  for (const [input, reason] of [['length-limit', 'max_output_tokens'], ['content-filter', 'content_filter']]) {
    const partial = await client.responses.create({ model, input });
    assert.deepEqual(partial.incomplete_details, { reason });
    assert.equal(partial.status, 'incomplete');
    assert.equal(partial.output[0].status, 'incomplete');
    const incomplete = await collect(await client.responses.create({ model, input, stream: true }));
    assert.equal(incomplete.at(-1).type, 'response.incomplete');
  }
  const partialTool = await collect(client.responses.stream({ model, input: 'length-limit', tools, tool_choice: 'required' }));
  assert.equal(partialTool.at(-1).type, 'response.incomplete');
  assert.deepEqual(partialTool.at(-1).response.output, []);
  for (const [input, code] of [
    ['invalid-tool-name', 'upstream_protocol_error'], ['invalid-tool-arguments', 'upstream_protocol_error'],
    ['duplicate-tool-id', 'upstream_protocol_error'], ['truncated-tool-stream', 'upstream_protocol_error'],
    ['multiple-tool-calls', 'upstream_tool_choice_failed']
  ]) {
    if (input !== 'truncated-tool-stream') {
      await assert.rejects(client.responses.create({ model, input, tools }), error => error.status === 502 && error.code === code);
    }
    const failed = await collect(client.responses.stream({ model, input, tools }));
    assert.deepEqual(failed.map(event => event.type), ['response.created', 'response.in_progress', 'response.failed']);
    assert.equal(failed.at(-1).response.error.code, code);
    assert.deepEqual(failed.at(-1).response.output, []);
    assert.equal(app.gateway.history[0].errorCode, code);
  }
  const brokenModel = model.replace(/shared$/, 'broken');
  await app.enable(brokenModel);
  const adminClient = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: app.admin, maxRetries: 0 });
  const broken = await collect(adminClient.responses.stream({ model: brokenModel, input: 'hello' }));
  assert.equal(broken.at(-1).type, 'response.failed');
  assert.equal(broken.at(-1).response.error.code, 'upstream_protocol_error');
  assert.equal(broken.at(-1).response.output[0].content[0].text, '未完成');
  assert.equal(broken.at(-1).response.output[0].status, 'incomplete');
});

test('Responses shares Chat Completions capacity and stops on disconnect or key revocation', async t => {
  const { app, upstream, modelIds } = await setupResponses(t, ['openai']);
  const model = modelIds.openai.replace(/shared$/, 'slow');
  const id = model.split('/')[0];
  await app.enable(model);
  await app.mutate(`/admin/connections/${id}`, 'PATCH', { maxConcurrency: 1 });
  const { data: { token, id: keyId } } = await app.mutate('/admin/keys', 'POST', { name: 'Cancellation', models: [model, modelIds.openai] });
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: token, maxRetries: 0 });
  const stream = await client.responses.create({ model, input: 'wait', stream: true });
  for await (const event of stream) {
    if (event.type !== 'response.output_text.delta') continue;
    assert.equal(app.gateway.active.size, 1);
    const busy = await app.request('/v1/chat/completions', 'POST', { model, messages: [userMessage('hi')] }, token);
    assert.equal(busy.status, 429);
    assert.equal(busy.response.headers.get('retry-after'), '2');
    break;
  }
  await until(() => upstream.disconnects === 1 && app.gateway.active.size === 0);
  assert.equal(app.gateway.history[0].status, 'cancelled');
  assert.equal((await client.responses.create({ model: modelIds.openai, input: 'hello' })).status, 'completed');
  const revoked = [];
  for await (const event of client.responses.stream({ model, input: 'wait' })) {
    revoked.push(event);
    if (event.type === 'response.output_text.delta') assert.equal((await app.mutate(`/admin/keys/${keyId}`, 'DELETE')).status, 200);
  }
  assert.equal(revoked.at(-1).type, 'response.failed');
  assert.equal(revoked.at(-1).response.error.code, 'key_revoked');
  await until(() => upstream.disconnects === 2 && app.gateway.active.size === 0);
});
