import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, newId } from '../../packages/core/store.mjs';
import { Gateway } from '../../packages/core/gateway.mjs';
import { assertLoopbackRequest } from '../../packages/protocol/loopback.mjs';
import { GatewayError, VERSION, errorPayload, exact, object } from '../../packages/protocol/index.mjs';
import { maxImageRequestBytes } from '../../packages/protocol/image-options.mjs';
import { ConsoleSessions } from './console-sessions.mjs';
import { completionState, finalizeCompletion, mergeDelta } from './completion.mjs';
import { beginStream, json, write } from './http.mjs';
import { createResponse } from './responses.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(directory, '../console/index.html'), 'text/html; charset=utf-8']],
  ['/assets/app.mjs', [path.join(directory, '../console/app.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/style.css', [path.join(directory, '../console/style.css'), 'text/css; charset=utf-8']],
  ['/assets/models.css', [path.join(directory, '../console/models.css'), 'text/css; charset=utf-8']],
  ['/openapi.json', [path.join(directory, '../../docs/openapi.json'), 'application/json; charset=utf-8']],
  ['/assets/api-docs.mjs', [path.join(directory, '../console/api-docs.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/api-docs.css', [path.join(directory, '../console/api-docs.css'), 'text/css; charset=utf-8']],
  ['/packages/ui/i18n.mjs', [path.join(directory, '../../packages/ui/i18n.mjs'), 'text/javascript; charset=utf-8']],
  ['/packages/ui/messages.mjs', [path.join(directory, '../../packages/ui/messages.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/i18n.css', [path.join(directory, '../../packages/ui/i18n.css'), 'text/css; charset=utf-8']],
  ['/assets/events.mjs', [path.join(directory, '../../packages/protocol/events.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/image-options.mjs', [path.join(directory, '../../packages/protocol/image-options.mjs'), 'text/javascript; charset=utf-8']]
]);
async function readBody(request, limit = 2 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new GatewayError('Use Content-Type: application/json.', 415, 'unsupported_media_type');
  const tooLarge = () => new GatewayError(`Request exceeds the ${limit / (1024 * 1024)} MiB limit.`, 413, 'request_too_large');
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw tooLarge();
  }
  const chunks = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new GatewayError('Request body must be valid JSON.'); }
  return object(value);
}
async function chat(response, gateway, body, principal, controller, id) {
  const streaming = body?.stream === true;
  const state = completionState();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const emit = value => write(response, `data: ${JSON.stringify(value)}\n\n`, controller.signal);
  let heartbeat, usage;
  try {
    for await (const event of gateway.generate(body, principal, { signal: controller.signal, id })) {
      if (event.type === 'delta') mergeDelta(state, event.delta);
      if (streaming && !response.headersSent) {
        heartbeat = beginStream(response);
        await emit(chunk({ role: 'assistant' }));
      }
      if (event.type === 'delta' && streaming) await emit(chunk(event.delta));
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'done') state.finishReason = event.finishReason;
    }
    const tools = finalizeCompletion(state, body);
    if (streaming) {
      await emit(chunk({}, state.finishReason));
      if (body.stream_options?.include_usage && usage) await emit({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage });
      await write(response, 'data: [DONE]\n\n', controller.signal); response.end();
    } else json(response, 200, { id, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: state.content || (tools.length || state.refusal ? null : ''), ...(tools.length ? { tool_calls: tools } : {}), ...(state.refusal ? { refusal: state.refusal } : {}) }, finish_reason: state.finishReason }],
      ...(usage ? { usage } : {}) });
  } catch (error) {
    gateway.recordResponseFailure(id, error);
    throw error;
  } finally { clearInterval(heartbeat); }
}

export async function startGateway(options) {
  const store = await new Store(options.directory).open();
  const gateway = new Gateway(store, options);
  const sessions = new ConsoleSessions();
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
      assertLoopbackRequest(request, server.address().port);
      const url = new URL(request.url, origin), pathname = url.pathname;
      if (request.method === 'GET' && pathname === '/favicon.ico') { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return; }
      if (request.method === 'GET' && pathname === '/healthz') { json(response, 200, { ok: true, version: VERSION }); return; }
      if (request.method === 'GET' && staticFiles.has(pathname)) {
        const [file, contentType] = staticFiles.get(pathname);
        const bytes = await fs.readFile(file);
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }); response.end(bytes); return;
      }
      const token = String(request.headers.authorization || '').match(/^Bearer ([^\s]+)$/)?.[1];
      if (request.method === 'POST' && pathname === '/admin/console-links') {
        gateway.authenticate(token, true);
        json(response, 200, { url: sessions.link(origin) }); return;
      }
      if (request.method === 'POST' && pathname === '/console/session') {
        const body = await readBody(request);
        exact(body, ['code']);
        const session = sessions.redeem(body.code, token);
        json(response, 200, { session }); return;
      }
      if (request.method === 'DELETE' && pathname === '/console/session') {
        sessions.revoke(token);
        json(response, 200, { ok: true }); return;
      }
      const principal = sessions.authenticate(token)
        ? gateway.authenticate(store.adminToken, true)
        : gateway.authenticate(token, pathname.startsWith('/admin/'));
      if (request.method === 'GET' && pathname === '/v1/models') { json(response, 200, gateway.catalog(principal)); return; }
      if (request.method === 'POST' && pathname === '/v1/chat/completions') {
        await chat(response, gateway, await readBody(request), principal, controller, id); return;
      }
      if (request.method === 'POST' && pathname === '/v1/responses') {
        const responseId = newId('resp');
        response.setHeader('x-request-id', responseId);
        await createResponse(response, gateway, await readBody(request), principal, { signal: controller.signal, id: responseId }); return;
      }
      if (request.method === 'POST' && pathname === '/v1/images/generations') {
        const imageRequestId = newId('img');
        response.setHeader('x-request-id', imageRequestId);
        const result = await gateway.generateImage(await readBody(request, maxImageRequestBytes), principal, { signal: controller.signal, id: imageRequestId });
        json(response, 200, result);
        return;
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
        if (request.method === 'PATCH' && pathname === '/admin/model-settings') result = await gateway.saveModelSettings(body);
        else if (request.method === 'POST' && pathname === '/admin/connections') result = await gateway.saveConnection(body);
        else if (connection && request.method === 'PATCH' && !connection[2]) result = await gateway.saveConnection(body, connection[1]);
        else if (connection && request.method === 'DELETE' && !connection[2]) { exact(body, ['revision']); result = await gateway.deleteConnection(connection[1], body.revision); }
        else if (connection && request.method === 'POST' && connection[2]) { exact(body, ['revision']); result = await gateway.discover(connection[1], body.revision, controller.signal); }
        else if (pathname === '/admin/models' && request.method === 'POST') result = await gateway.addModel(body);
        else if (model && request.method === 'PATCH') result = await gateway.updateModel(decodeURIComponent(model[1]), body);
        else if (pathname === '/admin/routes' && request.method === 'POST') throw new GatewayError('Configure application functions in the client. Existing aliases remain readable for compatibility.', 410, 'client_owned_settings');
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
          if (error instanceof GatewayError && error.status === 429 && error.retryAfter !== undefined) {
            response.setHeader('retry-after', error.retryAfter);
          }
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
    consoleLink: () => sessions.link(origin),
    close() {
      closing ||= (async () => {
        for (const controller of controllers) controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
        const stopped = new Promise(resolve => server.close(resolve));
        await gateway.close(); server.closeAllConnections(); await stopped; await store.close();
      })(); return closing;
    }
  };
}
