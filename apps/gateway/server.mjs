import http from 'node:http';
import { openCodexImageStores } from '../../packages/core/codex-image-operations.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, newId } from '../../packages/core/store.mjs';
import { Gateway } from '../../packages/core/gateway.mjs';
import { UsageLedger, usageQuery } from '../../packages/core/usage.mjs';
import { findUsageCall, usageAnalytics, usageAnalyticsQuery, usageCallsCsv } from '../../packages/core/usage-analytics.mjs';
import { usageTags } from '../../packages/core/provider-usage.mjs';
import { UsageDevelopment } from '../../packages/core/usage-development.mjs';
import { UsageBilling, usageStatementTemplate } from '../../packages/core/usage-billing.mjs';
import { getAiUsagePriceCatalog } from '../../packages/core/usage-price-book.mjs';
import { assertLoopbackRequest } from '../../packages/protocol/loopback.mjs';
import { GatewayError, VERSION, errorPayload, exact, object } from '../../packages/protocol/index.mjs';
import { maxCodexChatRequestBytes, maxImageRequestBytes, maxInferenceRequestBytes } from '../../packages/protocol/image-options.mjs';
import { ConsoleSessions } from './console-sessions.mjs';
import { completionState, finalizeCompletion, mergeDelta } from './completion.mjs';
import { beginStream, json, write } from './http.mjs';
import { createResponse } from './responses.mjs';
import { forwardServiceResponse, serveStandardMedia, standardMediaRoute } from './service-media.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', [path.join(directory, '../console/index.html'), 'text/html; charset=utf-8']],
  ['/assets/app.mjs', [path.join(directory, '../console/app.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/playground-media.mjs', [path.join(directory, '../console/playground-media.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/usage.mjs', [path.join(directory, '../console/usage.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/usage-view.mjs', [path.join(directory, '../console/usage-view.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/usage-charts.mjs', [path.join(directory, '../console/usage-charts.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/usage-billing.mjs', [path.join(directory, '../console/usage-billing.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/usage.css', [path.join(directory, '../console/usage.css'), 'text/css; charset=utf-8']],
  ['/assets/style.css', [path.join(directory, '../console/style.css'), 'text/css; charset=utf-8']],
  ['/assets/models.css', [path.join(directory, '../console/models.css'), 'text/css; charset=utf-8']],
  ['/openapi.json', [path.join(directory, '../../docs/openapi.json'), 'application/json; charset=utf-8']],
  ['/assets/api-docs.mjs', [path.join(directory, '../console/api-docs.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/api-docs.css', [path.join(directory, '../console/api-docs.css'), 'text/css; charset=utf-8']],
  ['/packages/ui/i18n.mjs', [path.join(directory, '../../packages/ui/i18n.mjs'), 'text/javascript; charset=utf-8']],
  ['/packages/ui/messages.mjs', [path.join(directory, '../../packages/ui/messages.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/i18n.css', [path.join(directory, '../../packages/ui/i18n.css'), 'text/css; charset=utf-8']],
  ['/assets/events.mjs', [path.join(directory, '../../packages/protocol/events.mjs'), 'text/javascript; charset=utf-8']],
  ['/assets/image-options.mjs', [path.join(directory, '../../packages/protocol/image-options.mjs'), 'text/javascript; charset=utf-8']],
  ['/packages/protocol/media-options.mjs', [path.join(directory, '../../packages/protocol/media-options.mjs'), 'text/javascript; charset=utf-8']]
]);

const inferenceEndpoints = new Map([
  ['/v1/chat/completions', 'chat'], ['/v1/responses', 'responses'], ['/v1/images/generations', 'images']
]);
const providerServiceEndpoints = new Set([
  '/v1/chat/completions', '/v1/images/generations', '/v1/embeddings', '/v1/audio/speech', '/v1/audio/transcriptions'
]);
const maxTranscriptionRequestBytes = 129 * 1024 * 1024;

function bodyReservations({ maxRequests = 32, maxBytes = 160 * 1024 * 1024 } = {}) {
  let requests = 0, bytes = 0;
  return length => {
    if (requests >= maxRequests || bytes + length > maxBytes) {
      throw new GatewayError('The gateway is processing too many request bodies.', 429, 'request_body_capacity', null, { retryAfter: '1' });
    }
    requests++;
    bytes += length;
    return () => { requests--; bytes -= length; };
  };
}

async function readPayload(request, limit, reserve, signal) {
  const tooLarge = () => new GatewayError(`Request exceeds the ${limit / (1024 * 1024)} MiB limit.`, 413, 'request_too_large');
  const declared = request.headers['content-length'];
  if (Number(declared) > limit) throw tooLarge();
  // Chunked requests reserve their endpoint maximum. Keep the reservation
  // until the handler releases the parsed body and any decoded images.
  reserve(declared === undefined ? (request.headers['transfer-encoding'] ? limit : 0) : Number(declared));
  const chunks = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, size);
}
async function readBody(request, limit, reserve, signal) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new GatewayError('Use Content-Type: application/json.', 415, 'unsupported_media_type');
  const payload = await readPayload(request, limit, reserve, signal);
  let value;
  try { value = JSON.parse(payload.toString('utf8')); }
  catch { throw new GatewayError('Request body must be valid JSON.'); }
  return object(value);
}
async function chat(response, gateway, body, principal, context) {
  const { id, signal } = context;
  const streaming = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;
  const state = completionState();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }], ...(includeUsage ? { usage: null } : {}) });
  const emit = value => write(response, `data: ${JSON.stringify(value)}\n\n`, signal);
  let heartbeat, usage;
  try {
    for await (const event of gateway.generate(body, principal, context)) {
      if (event.type === 'delta') mergeDelta(state, event.delta);
      if (streaming && !response.headersSent) {
        heartbeat = beginStream(response);
        await emit(chunk({ role: 'assistant' }));
      }
      if (event.type === 'delta' && streaming) {
        const { tool_calls, ...delta } = event.delta;
        if (!tool_calls?.length || Object.keys(delta).length) await emit(chunk(delta));
      }
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'done') state.finishReason = event.finishReason;
    }
    const tools = finalizeCompletion(state, body);
    if (streaming) {
      if (tools.length) await emit(chunk({ tool_calls: tools.map((tool, index) => ({ index, ...tool })) }));
      await emit(chunk({}, state.finishReason));
      if (includeUsage && usage) await emit({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage });
      await write(response, 'data: [DONE]\n\n', signal); response.end();
    } else json(response, 200, { id, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: state.content || (tools.length || state.refusal ? null : ''), ...(tools.length ? { tool_calls: tools } : {}), ...(state.refusal ? { refusal: state.refusal } : {}) }, finish_reason: state.finishReason }],
      ...(usage ? { usage } : {}) });
  } finally { clearInterval(heartbeat); }
}

export async function startGateway(options) {
  const imageStores = options.imageStores || await openCodexImageStores(options.directory);
  const store = await new Store(options.directory).open();
  const gateway = new Gateway(store, { ...options, imageStores });
  const ledger = new UsageLedger(options.directory);
  const billing = new UsageBilling(options.directory);
  const development = new UsageDevelopment(options.directory, options.developmentDetails ?? process.env.MODEL_DOCK_USAGE_DEBUG === '1');
  const recordUsage = async (row, capture) => {
    if (capture) row.audit.development = await development.record(row, capture);
    await ledger.record(row);
  };
  await Promise.all([ledger.open(), gateway.budgets.open(), billing.open(), development.prepare().catch(() => {})]);
  const sessions = new ConsoleSessions();
  const reserveBody = bodyReservations(options.bodyBudget);
  let origin;
  const controllers = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src blob:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const id = newId('chatcmpl'); response.setHeader('x-request-id', id);
    const controller = new AbortController(), finished = Promise.withResolvers();
    controllers.set(controller, finished.promise);
    let releaseBody, releaseProject, execution, sendingCsv = false;
    const input = (limit = maxInferenceRequestBytes) => readBody(request, limit, bytes => {
      releaseBody = reserveBody(bytes);
    }, controller.signal);
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
        const body = await input();
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
      const auditContext = () => ({ usageTags: usageTags(request.headers, token),
        ...(development.enabled && { developmentSecrets: [token, store.adminToken] }) });
      if (request.method === 'GET' && pathname === '/v1/models') { json(response, 200, await gateway.availableCatalog(principal, controller.signal)); return; }
      if (request.method === 'GET' && pathname === '/v1/project') {
        json(response, 200, { id: principal.id, name: principal.name }); return;
      }
      const providerService = pathname.match(/^\/v1\/services\/(conn_[a-f0-9]{16}%2[fF][a-z0-9-]+)(\/[^%]*)$/);
      const serviceHeader = request.headers['x-model-dock-service'];
      const mediaRoute = standardMediaRoute(request.method, pathname);
      const standardService = request.method === 'POST' && providerServiceEndpoints.has(pathname) &&
        typeof serviceHeader === 'string' && /^conn_[a-f0-9]{16}\/[a-z0-9-]+$/.test(serviceHeader);
      if (providerService || standardService) {
        const deployment = providerService ? decodeURIComponent(providerService[1]) : serviceHeader;
        const servicePath = providerService ? providerService[2] : pathname.slice(3);
        releaseProject = gateway.admitProjectRequest(principal);
        execution = { id, endpoint: 'service', signal: controller.signal, ...auditContext() };
        const limit = servicePath === '/audio/transcriptions' ? maxTranscriptionRequestBytes : maxImageRequestBytes;
        const body = await readPayload(request, limit, bytes => { releaseBody = reserveBody(bytes); }, controller.signal);
        await gateway.callService(deployment, {
          method: request.method, pathname: servicePath, search: url.search, headers: request.headers, body
        }, principal, execution, (upstream, signal, observer) => forwardServiceResponse(response, upstream, signal, observer));
        return;
      }
      if (mediaRoute) {
        if (serviceHeader !== undefined) {
          throw new GatewayError('Use the published model ID for this request.', 400, 'invalid_request', 'X-Model-Dock-Service');
        }
        releaseProject = gateway.admitProjectRequest(principal);
        execution = { id, endpoint: 'service', signal: controller.signal, ...auditContext() };
        const read = (limit, multiplier = 1) => readPayload(request, limit, bytes => {
          releaseBody = reserveBody(bytes * multiplier);
        }, controller.signal);
        await serveStandardMedia({ route: mediaRoute, gateway, response, principal, context: execution,
          headers: request.headers, read, query: url.searchParams });
        return;
      }
      const receipt = pathname.match(/^\/v1\/requests\/((?:chatcmpl|resp|img)_[a-f0-9]{16})$/);
      if (request.method === 'GET' && receipt) { json(response, 200, gateway.requestStatus(principal, receipt[1])); return; }
      const imageOperation = pathname.match(/^\/v1\/images\/operations\/([a-f0-9]{64})(?:\/(result|cancel))?$/);
      if (imageOperation) {
        const [, operationId, action] = imageOperation;
        if (request.method === 'GET' && action !== 'cancel') {
          const operation = action === 'result'
            ? await gateway.imageOperations.result(principal, operationId) : await gateway.imageOperations.inspect(principal, operationId);
          json(response, 200, operation); return;
        }
        if (request.method === 'POST' && action === 'cancel') {
          exact(await input(), []);
          json(response, 200, await gateway.imageOperations.cancel(principal, operationId)); return;
        }
      }
      const endpoint = inferenceEndpoints.get(pathname);
      if (request.method === 'POST' && endpoint) {
        const requestId = endpoint === 'chat' ? id : newId(endpoint === 'responses' ? 'resp' : 'img');
        response.setHeader('x-request-id', requestId);
        if (endpoint !== 'images') response.setHeader('location', `/v1/requests/${requestId}`);
        execution = { id: requestId, endpoint, signal: controller.signal, ...auditContext() };
        if (endpoint !== 'images') releaseProject = gateway.admitProjectRequest(principal);
        const bodyLimit = endpoint === 'images' ? maxImageRequestBytes
          : endpoint === 'chat' && gateway.hasDedicatedCodexCatalog(principal) ? maxCodexChatRequestBytes : maxInferenceRequestBytes;
        const body = await input(bodyLimit);
        if (endpoint === 'images' && Object.hasOwn(body, 'operation_id')) {
          const submitted = await gateway.submitImageOperation(body, principal, execution, () => {
            const release = releaseBody;
            releaseBody = undefined;
            return release;
          }, recordUsage);
          response.setHeader('location', `/v1/images/operations/${submitted.id}`);
          json(response, 202, submitted); return;
        }
        if (endpoint === 'images') releaseProject = gateway.admitProjectRequest(principal);
        if (endpoint === 'chat') await chat(response, gateway, body, principal, execution);
        else if (endpoint === 'responses') await createResponse(response, gateway, body, principal, execution);
        else json(response, 200, await gateway.generateImage(body, principal, execution));
        return;
      }
      if (request.method === 'GET' && pathname === '/admin/state') { json(response, 200, { ...gateway.snapshot(), version: VERSION, baseUrl: `${origin}/v1` }); return; }
      if (request.method === 'GET' && pathname === '/admin/usage/analytics') {
        const analytics = await usageAnalytics(ledger, usageAnalyticsQuery(url.searchParams), controller.signal, billing.latest());
        json(response, 200, { ...analytics, developmentEnabled: development.enabled, billingUnavailable: Boolean(billing.writeFailed) });
        return;
      }
      const developmentCall = pathname.match(/^\/admin\/usage\/development\/((?:chatcmpl|resp|img)_[a-f0-9]{16})$/);
      if (request.method === 'GET' && developmentCall) {
        const row = await findUsageCall(ledger, developmentCall[1], controller.signal);
        json(response, 200, { data: await development.get(row) });
        return;
      }
      if (request.method === 'GET' && pathname === '/admin/usage/calls.csv') {
        const query = usageAnalyticsQuery(url.searchParams);
        sendingCsv = true;
        response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="model-dock-ai-calls.csv"' });
        for await (const line of usageCallsCsv(ledger, query, controller.signal, billing.latest())) await write(response, line, controller.signal);
        response.end();
        return;
      }
      if (request.method === 'GET' && pathname === '/admin/usage/billing') {
        json(response, 200, { catalog: getAiUsagePriceCatalog(), imports: billing.imports() });
        return;
      }
      if (request.method === 'GET' && pathname === '/admin/usage/billing/template.csv') {
        response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="model-dock-provider-statement.csv"' });
        response.end(usageStatementTemplate);
        return;
      }
      const statementBatch = pathname.match(/^\/admin\/usage\/billing\/imports\/(statement_[a-f0-9]{16})$/);
      if (request.method === 'GET' && statementBatch) {
        json(response, 200, { batch: billing.batch(statementBatch[1]) });
        return;
      }
      const reconciliationHistory = pathname.match(/^\/admin\/usage\/billing\/calls\/((?:chatcmpl|resp|img)_[a-f0-9]{16})$/);
      if (request.method === 'GET' && reconciliationHistory) {
        json(response, 200, { entries: billing.callHistory(reconciliationHistory[1]) });
        return;
      }
      if (request.method === 'POST' && pathname === '/admin/usage/billing/reconcile') {
        json(response, 200, { entry: await billing.reconcile(ledger, await input(), controller.signal) });
        return;
      }
      if (request.method === 'POST' && ['/admin/usage/billing/preview', '/admin/usage/billing/import'].includes(pathname)) {
        const body = await input(2 * 1024 * 1024 + 4096);
        const result = pathname.endsWith('/preview') ? await billing.preview(ledger, body, controller.signal)
          : await billing.import(ledger, body, controller.signal);
        json(response, 200, result);
        return;
      }
      if (request.method === 'GET' && pathname === '/admin/usage') {
        const query = usageQuery(url.searchParams);
        if (url.searchParams.get('format') === 'csv') {
          sendingCsv = true;
          response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
            'content-disposition': 'attachment; filename="model-dock-usage.csv"' });
          for await (const line of ledger.csv(query, controller.signal)) await write(response, line, controller.signal);
          response.end();
        } else json(response, 200, await ledger.report(query, controller.signal));
        return;
      }
      let result;
      if (pathname.startsWith('/admin/')) {
        const body = await input();
        const connection = pathname.match(/^\/admin\/connections\/([^/]+)(\/discover)?$/);
        const credential = pathname.match(/^\/admin\/api-credentials\/([^/]+)$/);
        const model = pathname.match(/^\/admin\/models\/(.+)$/);
        const pool = pathname.match(/^\/admin\/pools\/([^/]+)$/);
        const route = pathname.match(/^\/admin\/routes\/([^/]+)$/);
        const key = pathname.match(/^\/admin\/keys\/([^/]+)$/);
        const cancel = pathname.match(/^\/admin\/requests\/([^/]+)\/cancel$/);
        if (request.method === 'PATCH' && pathname === '/admin/model-settings') result = await gateway.saveModelSettings(body);
        else if (request.method === 'PATCH' && pathname === '/admin/usage/prices') result = await gateway.setUsagePrice(body);
        else if (request.method === 'POST' && pathname === '/admin/api-credentials') result = await gateway.saveApiCredential(body);
        else if (credential && request.method === 'PATCH') result = await gateway.saveApiCredential(body, credential[1]);
        else if (credential && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deleteApiCredential(credential[1], body.revision); }
        else if (request.method === 'POST' && pathname === '/admin/connections') result = await gateway.saveConnection(body);
        else if (connection && request.method === 'PATCH' && !connection[2]) result = await gateway.saveConnection(body, connection[1]);
        else if (connection && request.method === 'DELETE' && !connection[2]) { exact(body, ['revision']); result = await gateway.deleteConnection(connection[1], body.revision); }
        else if (connection && request.method === 'POST' && connection[2]) { exact(body, ['revision']); result = await gateway.discover(connection[1], body.revision, controller.signal); }
        else if (pathname === '/admin/models' && request.method === 'POST') result = await gateway.addModel(body);
        else if (model && request.method === 'PATCH') result = await gateway.updateModel(decodeURIComponent(model[1]), body);
        else if (pathname === '/admin/pools' && request.method === 'POST') result = await gateway.savePool(body);
        else if (pool && request.method === 'PATCH') result = await gateway.savePool(body, pool[1]);
        else if (pool && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deletePool(pool[1], body.revision); }
        else if (pathname === '/admin/routes' && request.method === 'POST') throw new GatewayError('Configure application functions in the client. Existing aliases remain readable for compatibility.', 410, 'client_owned_settings');
        else if (route && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deleteRoute(route[1], body.revision); }
        else if (pathname === '/admin/keys' && request.method === 'POST') result = await gateway.createKey(body);
        else if (key && request.method === 'PATCH') result = await gateway.updateKey(key[1], body);
        else if (key && request.method === 'DELETE') { exact(body, ['revision']); result = await gateway.deleteKey(key[1], body.revision); }
        else if (cancel && request.method === 'POST') { exact(body, []); result = gateway.cancel(cancel[1]); }
        else throw new GatewayError('Endpoint not found.', 404, 'not_found');
        json(response, 200, { ok: true, ...result, state: { ...gateway.snapshot(), version: VERSION, baseUrl: `${origin}/v1` } }); return;
      }
      throw new GatewayError('Endpoint not found.', 404, 'not_found');
    } catch (error) {
      gateway.recordResponseFailure(execution, error);
      if (!response.destroyed) {
        const payload = errorPayload(error);
        if (response.headersSent) {
          if (sendingCsv || execution?.endpoint === 'service') response.destroy();
          else response.end(`data: ${JSON.stringify(payload)}\n\n`);
        }
        else {
          if (!request.complete) request.resume();
          if (error instanceof GatewayError && [429, 503].includes(error.status) && error.retryAfter !== undefined) {
            response.setHeader('retry-after', error.retryAfter);
          }
          json(response, error instanceof GatewayError ? error.status : 500, payload);
        }
      }
    } finally {
      releaseBody?.();
      releaseProject?.();
      if (execution?.budgetHold) await gateway.settleBudget(execution);
      if (execution?.completed) await recordUsage(execution.completed, execution.development);
      controllers.delete(controller);
      finished.resolve();
      request.off('aborted', abort);
    }
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
        const processing = [...controllers.values()];
        for (const controller of controllers.keys()) controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
        const stopped = new Promise(resolve => server.close(resolve));
        await gateway.close(); server.closeAllConnections(); await stopped;
        await Promise.all(processing); await Promise.all([ledger.close(), billing.queue]); await store.close();
      })(); return closing;
    }
  };
}
