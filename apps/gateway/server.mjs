import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Store, newId } from '../../packages/core/store.mjs';
import { Gateway } from '../../packages/core/gateway.mjs';
import { GatewayError, VERSION, errorPayload, exact, object } from '../../packages/protocol/index.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(directory, '../console/index.html'), 'text/html; charset=utf-8']],
  ['/assets/app.mjs', [path.join(directory, '../console/app.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/style.css', [path.join(directory, '../console/style.css'), 'text/css; charset=utf-8']],
  ['/assets/events.mjs', [path.join(directory, '../../packages/protocol/events.mjs'), 'text/javascript; charset=utf-8']]
]);
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function readBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new GatewayError('Use Content-Type: application/json.', 415, 'unsupported_media_type');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new GatewayError('Request exceeds the 2 MiB limit.', 413, 'request_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError('Request body must be valid JSON.'); }
  return object(value);
}
async function write(response, data, signal) {
  signal.throwIfAborted();
  if (!response.write(data)) await once(response, 'drain', { signal });
}
function mergeDelta(state, delta) {
  if (delta.content != null) {
    if (typeof delta.content !== 'string') throw new GatewayError('Invalid provider text delta.', 502, 'upstream_protocol_error');
    state.content += delta.content;
  }
  if (delta.refusal) state.refusal = (state.refusal || '') + delta.refusal;
  if (delta.tool_calls) {
    if (!Array.isArray(delta.tool_calls)) throw new GatewayError('Invalid function delta.', 502, 'upstream_protocol_error');
    for (const call of delta.tool_calls) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index > 127) throw new GatewayError('Invalid function index.', 502, 'upstream_protocol_error');
      const current = state.tools.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) current.id += call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      state.tools.set(call.index, current);
    }
  }
}
async function chat(response, gateway, body, principal, controller, id) {
  const streaming = body?.stream === true;
  const state = { content: '', tools: new Map(), usage: null, finishReason: null };
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const emit = value => write(response, `data: ${JSON.stringify(value)}\n\n`, controller.signal);
  let heartbeat;
  try {
    for await (const event of gateway.generate(body, principal, { signal: controller.signal, id })) {
      if (event.type === 'delta') mergeDelta(state, event.delta);
      if (streaming && !response.headersSent) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        await emit(chunk({ role: 'assistant' }));
        heartbeat = setInterval(() => { if (!response.destroyed && response.writableLength < 65536) response.write(': keep-alive\n\n'); }, 15_000);
      }
      if (event.type === 'delta' && streaming) await emit(chunk(event.delta));
      if (event.type === 'usage') state.usage = event.usage;
      if (event.type === 'done') state.finishReason = event.finishReason;
    }
    const tools = [...state.tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    for (const tool of tools) {
      if (!tool.id || !body.tools?.some(item => item.function.name === tool.function.name)) throw new GatewayError('Provider requested an unknown application function.', 502, 'upstream_protocol_error');
      try { const args = JSON.parse(tool.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
      catch { throw new GatewayError('Provider returned invalid function arguments.', 502, 'upstream_protocol_error'); }
    }
    if (!['stop', 'length', 'tool_calls', 'content_filter'].includes(state.finishReason) || (state.finishReason === 'tool_calls') !== Boolean(tools.length)) throw new GatewayError('Invalid provider finish reason.', 502, 'upstream_protocol_error');
    if ((body.tool_choice === 'none' && tools.length) || (body.tool_choice === 'required' && !tools.length) || (typeof body.tool_choice === 'object' && (!tools.length || tools.some(tool => tool.function.name !== body.tool_choice.function.name))) || (body.parallel_tool_calls === false && tools.length > 1)) throw new GatewayError('Provider did not honor the requested tool selection.', 502, 'upstream_tool_choice_failed');
    if (!tools.length && ['json_object', 'json_schema'].includes(body.response_format?.type) && state.finishReason === 'stop') {
      try {
        const parsed = JSON.parse(state.content);
        if (body.response_format.type === 'json_object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
      } catch { throw new GatewayError('Provider did not return valid JSON for the requested format.', 502, 'upstream_json_invalid'); }
    }
    if (streaming) {
      await emit(chunk({}, state.finishReason));
      if (body.stream_options?.include_usage && state.usage) await emit({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: state.usage });
      await write(response, 'data: [DONE]\n\n', controller.signal); response.end();
    } else json(response, 200, { id, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: state.content || (tools.length ? null : ''), ...(tools.length ? { tool_calls: tools } : {}), ...(state.refusal ? { refusal: state.refusal } : {}) }, finish_reason: state.finishReason }],
      ...(state.usage ? { usage: state.usage } : {}) });
  } catch (error) {
    gateway.recordResponseFailure(id, error);
    throw error;
  } finally { clearInterval(heartbeat); }
}

export async function startGateway(options) {
  const store = await new Store(options.directory).open();
  const gateway = new Gateway(store, options);
  let origin;
  const controllers = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const id = newId('chatcmpl'); response.setHeader('x-request-id', id);
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { if (!response.writableEnded) controller.abort(new GatewayError('Client disconnected.', 499, 'request_cancelled')); };
    request.once('aborted', abort); response.once('close', abort);
    try {
      const host = request.headers.host;
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(host)) throw new GatewayError('This gateway accepts loopback hosts only.', 403, 'host_forbidden');
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new GatewayError('Cross-origin requests are not allowed.', 403, 'origin_forbidden');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new GatewayError('Cross-site requests are not allowed.', 403, 'origin_forbidden');
      const url = new URL(request.url, origin), pathname = url.pathname;
      if (request.method === 'GET' && pathname === '/healthz') { json(response, 200, { ok: true, version: VERSION }); return; }
      if (request.method === 'GET' && staticFiles.has(pathname)) {
        const [file, contentType] = staticFiles.get(pathname);
        const bytes = await fs.readFile(file);
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }); response.end(bytes); return;
      }
      const token = String(request.headers.authorization || '').match(/^Bearer ([^\s]+)$/)?.[1];
      const principal = gateway.authenticate(token, pathname.startsWith('/admin/'));
      if (request.method === 'GET' && pathname === '/v1/models') { json(response, 200, gateway.catalog(principal)); return; }
      if (request.method === 'POST' && pathname === '/v1/chat/completions') {
        await chat(response, gateway, await readBody(request), principal, controller, id); return;
      }
      if (request.method === 'GET' && pathname === '/admin/state') { json(response, 200, { ...gateway.snapshot(), version: VERSION, baseUrl: `${origin}/v1` }); return; }
      let result;
      if (pathname.startsWith('/admin/')) {
        const body = await readBody(request);
        const connection = pathname.match(/^\/admin\/connections\/([^/]+)(\/discover)?$/);
        const model = pathname.match(/^\/admin\/models\/(.+)$/);
        const route = pathname.match(/^\/admin\/routes\/([^/]+)$/);
        const key = pathname.match(/^\/admin\/keys\/([^/]+)$/);
        const cancel = pathname.match(/^\/admin\/requests\/([^/]+)\/cancel$/);
        if (request.method === 'POST' && pathname === '/admin/connections') result = await gateway.saveConnection(body);
        else if (connection && request.method === 'PATCH' && !connection[2]) result = await gateway.saveConnection(body, connection[1]);
        else if (connection && request.method === 'DELETE' && !connection[2]) { exact(body, ['revision']); result = await gateway.deleteConnection(connection[1], body.revision); }
        else if (connection && request.method === 'POST' && connection[2]) { exact(body, ['revision']); result = await gateway.discover(connection[1], body.revision, controller.signal); }
        else if (pathname === '/admin/models' && request.method === 'POST') result = await gateway.addModel(body);
        else if (model && request.method === 'PATCH') result = await gateway.updateModel(decodeURIComponent(model[1]), body);
        else if (pathname === '/admin/routes' && request.method === 'POST') result = await gateway.saveRoute(body);
        else if (route && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deleteRoute(route[1], body.revision); }
        else if (pathname === '/admin/keys' && request.method === 'POST') result = await gateway.createKey(body);
        else if (key && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deleteKey(key[1], body.revision); }
        else if (cancel && request.method === 'POST') { exact(body, []); result = gateway.cancel(cancel[1]); }
        else throw new GatewayError('Endpoint not found.', 404, 'not_found');
        json(response, 200, { ok: true, ...result, state: { ...gateway.snapshot(), version: VERSION, baseUrl: `${origin}/v1` } }); return;
      }
      throw new GatewayError('Endpoint not found.', 404, 'not_found');
    } catch (error) {
      if (!response.destroyed) {
        const payload = errorPayload(error);
        if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}\n\n`);
        else {
          if (error.status === 429) response.setHeader('retry-after', '2');
          json(response, error instanceof GatewayError ? error.status : 500, payload);
        }
      }
    } finally { controllers.delete(controller); request.off('aborted', abort); }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, '127.0.0.1', resolve); });
  } catch (error) { await gateway.close(); await store.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return { origin, server, store, gateway,
    close() {
      closing ||= (async () => {
        for (const controller of controllers) controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
        const stopped = new Promise(resolve => server.close(resolve));
        await gateway.close(); server.closeAllConnections(); await stopped; await store.close();
      })(); return closing;
    }
  };
}
