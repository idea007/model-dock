import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { setup } from './helpers.mjs';
const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];

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
  const result = await app.request('/v1/chat/completions', 'POST', { model, messages, tools, tool_choice: 'required' });
  assert.equal(result.status, 200); const choice = result.data.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls'); assert.equal(choice.message.tool_calls[0].function.name, 'weather');
  const next = await app.request('/v1/chat/completions', 'POST', { model, tools, messages: [...messages, choice.message, { role: 'tool', tool_call_id: 'call_codex', content: '22°C' }] });
  assert.equal(next.status, 200); assert.equal(next.data.choices[0].message.content, '工具结果：22°C');
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
});
