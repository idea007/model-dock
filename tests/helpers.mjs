import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startGateway } from '../apps/gateway/server.mjs';

export async function fixtureUpstream(t, models = [{ id: 'shared' }, { id: 'slow' }, { id: 'broken' }]) {
  const calls = []; let disconnects = 0;
  const server = http.createServer(async (request, response) => {
    const send = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/v1/models') return send({ data: models });
    if (request.url === '/api/tags') return send({ models: [{ name: 'local:small', size: 1024, details: { parameter_size: '1B', quantization_level: 'Q4' } }, { name: 'embed:small' }] });
    let body = ''; for await (const chunk of request) body += chunk;
    let value; try { value = JSON.parse(body || '{}'); } catch { response.writeHead(400); response.end(); return; }
    calls.push({ url: request.url, body: value, authorization: request.headers.authorization });
    if (request.url === '/api/show') return send({ capabilities: value.model.startsWith('embed') ? ['embedding'] : ['completion', 'tools', 'thinking'], model_info: { 'llama.context_length': 8192 }, parameters: 'num_ctx 2048' });
    if (request.url === '/api/chat') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ message: { content: '本机' }, done: false }) + '\n');
      response.end(JSON.stringify({ message: { content: '回答' }, done: true, prompt_eval_count: 5, eval_count: 2, done_reason: 'stop' }) + '\n'); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    if (request.headers.authorization !== 'Bearer fixture-upstream') { response.writeHead(401); response.end('private secret should never be reflected'); return; }
    const prompt = value.messages.at(-1).content;
    const rateLimit = { 'rate-limit-seconds': '90', 'rate-limit-date': 'Thu, 01 Jan 2099 00:00:00 GMT',
      'rate-limit-invalid': '1.5', 'rate-limit-missing': null };
    if (Object.hasOwn(rateLimit, prompt)) {
      const delay = rateLimit[prompt];
      response.writeHead(429, { 'content-type': 'application/json', ...(delay ? { 'retry-after': delay } : {}) });
      response.end(JSON.stringify({ error: { message: 'private provider error body' } }));
      return;
    }
    const refuse = prompt === 'refuse-structured' || prompt === 'refuse-invalid';
    const refusal = prompt === 'refuse-invalid' ? { invalid: true } : 'Fixture refusal.';
    const tool = value.tools?.length && value.messages.at(-1).role !== 'tool';
    let content = '你好，来自测试上游。';
    if (value.messages.at(-1).role === 'tool') content = `工具结果：${prompt}`;
    if (prompt === 'Return a JSON object with a greeting.') content = '{"greeting":"Hello!"}';
    const toolName = value.tool_choice?.function?.name || value.tools?.[0]?.function?.name || 'weather';
    const toolCalls = [{ id: 'call_1', type: 'function', function: {
      name: prompt === 'invalid-tool-name' ? 'unregistered' : toolName,
      arguments: ['invalid-tool-arguments', 'length-limit'].includes(prompt) ? '{"city":' : '{"city":"杭州"}'
    } }];
    if (prompt === 'multiple-tool-calls') toolCalls.push({ ...toolCalls[0], id: 'call_2' });
    const finishReason = prompt === 'length-limit' ? 'length' : prompt === 'content-filter' ? 'content_filter' : tool && !refuse ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
    if (!value.stream) {
      const message = { role: 'assistant', content: refuse || tool ? null : content,
        ...(refuse ? { refusal } : tool ? { tool_calls: toolCalls } : {}) };
      return send({ choices: [{ index: 0, message, finish_reason: finishReason }], usage });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\r\n\r\n`;
    if (value.model === 'slow') {
      response.write(event({ content: '开始' }));
      const timer = setInterval(() => response.write(': heartbeat\n\n'), 30);
      response.on('close', () => { clearInterval(timer); disconnects++; }); return;
    }
    if (value.model === 'broken') { response.end(event({ content: '未完成' })); return; }
    let text;
    if (refuse) text = typeof refusal === 'string' ? event({ refusal: 'Fixture ' }) + event({ refusal: 'refusal.' }) : event({ refusal });
    else if (tool) text = toolCalls.map((call, index) => {
      const { arguments: args, name } = call.function;
      return event({ tool_calls: [{ index, ...call, function: { name, arguments: args.slice(0, 8) } }] })
        + event({ tool_calls: [{ index, function: { arguments: args.slice(8) } }] });
    }).join('');
    else if (value.response_format) text = event({ content });
    else text = event({ role: 'assistant', content: '你好，' }) + event({ content: '来自测试上游。' });
    text += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\r\n\r\n`;
    text += `data: ${JSON.stringify({ choices: [], usage })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length && !response.destroyed; i += 17) { response.write(bytes.subarray(i, i + 17)); await delay(1); }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, get disconnects() { return disconnects; } };
}
export async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-test-'));
  const fixture = fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url));
  const app = await startGateway({ directory, port: 0, codex: { rpcTimeout: 1500,
    spawnImpl: (binary, args, config) => spawn(process.execPath, [fixture, ...args], config) }, ...options });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const admin = app.store.adminToken;
  const request = async (url, method = 'GET', body, key = admin, headers = {}) => {
    const response = await fetch(`${app.origin}${url}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { response, status: response.status, data: await response.json() };
  };
  const mutate = (url, method, body = {}) => request(url, method, { ...body, revision: app.store.read().revision });
  const connection = async (type, baseUrl) => {
    const result = await mutate('/admin/connections', 'POST', { name: `${type} connection`, type, ...(baseUrl ? { baseUrl } : {}), ...(type === 'openai' ? { apiKey: 'fixture-upstream' } : {}) });
    if (result.status !== 200) throw new Error(JSON.stringify(result.data));
    const id = result.data.id;
    const discovered = await mutate(`/admin/connections/${id}/discover`, 'POST');
    if (discovered.status !== 200) throw new Error(JSON.stringify(discovered.data));
    return id;
  };
  const enable = async model => { const result = await mutate(`/admin/models/${encodeURIComponent(model)}`, 'PATCH', { enabled: true }); if (result.status !== 200) throw new Error(JSON.stringify(result.data)); };
  return { ...app, directory, admin, request, mutate, connection, enable };
}
export async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(10); }
}
