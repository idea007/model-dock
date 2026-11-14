import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { DemoStore } from './store.mjs';
import { assertLoopbackRequest } from '../../packages/protocol/loopback.mjs';
import { buildRequest, validateSettings } from './policy.mjs';
import { GatewayError, exact, errorPayload } from '../../packages/protocol/index.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/assets/app.mjs', ['app.mjs', 'text/javascript']], ['/assets/models.mjs', ['models.mjs', 'text/javascript']],
  ['/assets/base.css', ['base.css', 'text/css']], ['/assets/models.css', ['models.css', 'text/css']], ['/assets/demo.css', ['demo.css', 'text/css']],
  ['/assets/events.mjs', ['../../packages/protocol/events.mjs', 'text/javascript']],
  ['/assets/image-options.mjs', ['../../packages/protocol/image-options.mjs', 'text/javascript']],
  ['/assets/api-docs.mjs', ['../console/api-docs.mjs', 'text/javascript']],
  ['/assets/api-docs.css', ['../console/api-docs.css', 'text/css']]
]);
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
const hash = value => createHash('sha256').update(value).digest();
function connection(input) {
  exact(input, ['revision', 'baseUrl', 'apiKey']);
  let url; try { url = new URL(input.baseUrl); } catch { throw new GatewayError('请输入有效的 Model Dock API 地址。'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new GatewayError('远端网关需要 HTTPS，本机可使用 HTTP。');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!/^md_key_[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.length > 1000) throw new GatewayError('请使用 Model Dock 的项目密钥（md_key_），不要使用管理员令牌。');
  return { baseUrl: url.toString().replace(/\/+$/, ''), apiKey };
}
function normalizeCatalog(data) {
  if (!Array.isArray(data?.data)) throw new GatewayError('网关返回了无效的模型目录。', 502, 'invalid_catalog');
  const seen = new Set();
  return data.data.filter(row => row && typeof row === 'object' && !row.legacy_alias
    && !(row.capabilities?.image_generation === true && row.capabilities.text === false)).slice(0, 1000).map(row => {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 512 || seen.has(row.id) || typeof row.source?.id !== 'string' || !row.source.id || row.source.id.length > 100) throw new GatewayError('此网关尚未提供接入端所需的模型元数据。', 502, 'invalid_catalog');
    seen.add(row.id);
    return { id: row.id, nativeId: row.id.split('/').slice(1).join('/') || row.id, name: typeof row.name === 'string' ? row.name.slice(0, 300) : row.id, connectionId: row.source.id,
      source: { id: row.source.id, name: typeof row.source.name === 'string' ? row.source.name.slice(0, 100) : row.source.id, type: ['codex', 'ollama'].includes(row.source.type) ? row.source.type : 'openai' },
      capabilities: Object.fromEntries(['text', 'tools', 'structured', 'thinking'].map(key => [key, typeof row.capabilities?.[key] === 'boolean' ? row.capabilities[key] : null])),
      contextWindow: Number.isSafeInteger(row.context_window) && row.context_window > 0 ? row.context_window : null,
      reasoningEfforts: Array.isArray(row.reasoning_efforts) ? [...new Set(row.reasoning_efforts.filter(level => typeof level === 'string' && level.length <= 30))] : [],
      defaultEffort: typeof row.default_reasoning_effort === 'string' ? row.default_reasoning_effort : null, available: true };
  });
}
async function fetchCatalog(config, signal) {
  const response = await fetch(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new GatewayError(`无法读取授权目录（HTTP ${response.status}），请检查项目密钥和模型权限。`, response.status === 401 || response.status === 403 ? 401 : 502, 'catalog_unavailable');
  return normalizeCatalog(await response.json());
}
function mergeCatalog(state, catalog) {
  const ids = new Set(catalog.map(row => row.id));
  state.catalog = [...catalog, ...state.catalog.filter(row => !ids.has(row.id)).map(row => ({ ...row, available: false }))];
  for (const model of catalog) if (!state.models.some(row => row.id === model.id)) state.models.push({ id: model.id, enabled: false, reasoningPolicy: null, groupPolicies: {} });
  state.catalogError = ''; state.catalogUpdatedAt = new Date().toISOString();
}
export function demoSnapshot(state) {
  const sources = [...new Map(state.catalog.map(model => [model.source.id, model.source])).values()];
  return { revision: state.revision, settingsRevision: state.settingsRevision || 0, version: '0.1.0', mode: 'gateway', connection: { baseUrl: state.connection?.baseUrl || 'http://127.0.0.1:4317/v1', configured: Boolean(state.connection), error: state.catalogError, refreshedAt: state.catalogUpdatedAt || null },
    connections: sources.map(source => ({ ...source, enabled: Boolean(state.connection) && !state.catalogError, status: state.catalogError ? 'error' : 'connected' })),
    models: state.catalog.map(model => ({ ...model, ...state.models.find(row => row.id === model.id), available: model.available && !state.catalogError })), routes: state.routes };
}
export async function startDemo({ directory: dataDirectory, port = 4318 } = {}) {
  const store = await new DemoStore(dataDirectory).open();
  const browserSession = `demo_session_${randomBytes(32).toString('base64url')}`;
  const controllers = new Set(); let origin, closing;
  try {
    // Retired simulated connections must not appear as real authorized models.
    if (store.read().connection?.mock) {
      await store.mutate(store.read().revision, state => {
        state.connection = null; state.catalog = []; state.models = []; state.catalogError = ''; state.catalogUpdatedAt = null;
        state.routes.forEach(feature => { feature.allowedModelIds = []; feature.modelId = ''; feature.reasoningOverrides = {}; });
      });
    }
    if (store.read().connection) {
      const state = store.read();
      try { const catalog = await fetchCatalog(state.connection, new AbortController().signal); await store.mutate(state.revision, next => mergeCatalog(next, catalog)); }
      catch { await store.mutate(state.revision, next => { next.catalogError = '启动时无法读取授权目录，请检查网关并刷新目录。'; }); }
    }
    const server = http.createServer(async (request, response) => {
      response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      const controller = new AbortController(); controllers.add(controller);
      const abort = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', abort);
      try {
        assertLoopbackRequest(request, server.address().port);
        const pathname = new URL(request.url, origin).pathname;
        if (request.method === 'GET' && pathname === '/favicon.ico') { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return; }
        if (request.method === 'GET' && pathname === '/healthz') { json(response, 200, { ok: true, role: 'client-demo' }); return; }
        if (request.method === 'GET' && files.has(pathname)) { const [file, type] = files.get(pathname); response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(await fs.readFile(path.join(directory, file))); return; }
        if (request.method === 'POST' && pathname === '/api/session') {
          // The custom header requires CORS preflight from another origin. Only
          // our own page may bootstrap; no credentials are embedded in assets.
          const site = request.headers['sec-fetch-site'];
          if (request.headers['x-model-dock-client'] !== '1' || site && site !== 'same-origin') throw new GatewayError('请从接入端页面建立本地会话。', 403, 'origin_forbidden');
          json(response, 200, { session: browserSession }); return;
        }
        const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
        if (!timingSafeEqual(hash(token), hash(browserSession)) && !timingSafeEqual(hash(token), hash(store.accessToken))) throw new GatewayError('接入端会话已失效，请刷新页面重试。', 401, 'local_session_required');
        if (request.method === 'GET' && pathname === '/api/state') { json(response, 200, demoSnapshot(store.read())); return; }
        if (request.method !== 'POST' || !['/api/connection', '/api/settings', '/api/refresh', '/api/run'].includes(pathname)) throw new GatewayError('Endpoint not found.', 404, 'not_found');
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new GatewayError('Use application/json.', 415, 'unsupported_media_type');
        let length = 0; const chunks = [];
        for await (const chunk of request) { length += chunk.length; if (length > 2 * 1024 * 1024) throw new GatewayError('Request too large.', 413, 'request_too_large'); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GatewayError('Invalid JSON.'); }
        if (pathname === '/api/connection') {
          const nextConnection = connection(body), catalog = await fetchCatalog(nextConnection, controller.signal);
          await store.mutate(body.revision, state => {
            // Credential changes never silently reactivate choices for another project.
            const changed = state.connection?.baseUrl !== nextConnection.baseUrl || state.connection?.apiKey !== nextConnection.apiKey;
            if (changed) { state.models.forEach(model => { model.enabled = false; }); state.settingsRevision = state.revision + 1; }
            state.connection = nextConnection; mergeCatalog(state, catalog);
          });
        } else if (pathname === '/api/settings') await store.mutate(body.revision, state => { validateSettings(state, body); state.settingsRevision = state.revision + 1; });
        else if (pathname === '/api/refresh') {
          exact(body, ['revision']); const before = store.read();
          if (!before.connection) throw new GatewayError('请先连接 Model Dock。');
          try { const catalog = await fetchCatalog(before.connection, controller.signal); await store.mutate(body.revision, state => mergeCatalog(state, catalog)); }
          catch (error) { if (error.code !== 'revision_conflict' && body.revision === store.read().revision) await store.mutate(body.revision, state => { state.catalogError = '授权目录暂不可用，已有功能选择仍保留。'; }); throw error; }
        } else {
          const state = store.read(); if (!state.connection) throw new GatewayError('请先连接 Model Dock。');
          const input = buildRequest(state, body);
          const upstream = await fetch(`${state.connection.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${state.connection.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
          if (!upstream.ok) { const failure = await upstream.json().catch(() => null); throw new GatewayError(failure?.error?.message || `网关请求失败（${upstream.status}）。`, upstream.status, failure?.error?.code || 'gateway_error'); }
          const type = upstream.headers.get('content-type') || '';
          if (!type.includes(input.stream ? 'text/event-stream' : 'application/json')) { await upstream.body?.cancel(); throw new GatewayError('网关响应格式不正确。', 502, 'invalid_gateway_response'); }
          response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          for await (const chunk of upstream.body) { if (response.destroyed) break; if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal }); }
          response.end(); return;
        }
        json(response, 200, { ok: true, state: demoSnapshot(store.read()) });
      } catch (error) {
        if (!response.destroyed) { const payload = errorPayload(error); if (response.headersSent) response.end(`data: ${JSON.stringify(payload)}\n\n`); else json(response, error instanceof GatewayError ? error.status : 500, payload); }
      } finally { controllers.delete(controller); response.off('close', abort); }
    });
    server.headersTimeout = 15000; server.requestTimeout = 30000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, store, server, close() { return closing ||= (async () => { for (const controller of controllers) controller.abort(); const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; await store.close(); })(); } };
  } catch (error) { await store.close(); throw error; }
}
