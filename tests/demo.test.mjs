import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { startDemo } from '../apps/demo/server.mjs';
import { startMockGateway } from './fixtures/demo-gateway.mjs';
import { DemoStore } from '../apps/demo/store.mjs';
import { ModelManager } from '../apps/demo/models.mjs';
import { until } from './helpers.mjs';
const settings = state => ({ revision: state.revision, models: state.models.map(({ id, enabled, reasoningPolicy, groupPolicies }) => ({ id, enabled, reasoningPolicy, groupPolicies })), routes: structuredClone(state.routes) });
async function fixture(t, configured = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-client-test-')), mock = await startMockGateway();
  let app = await startDemo({ directory, port: 0 });
  t.after(async () => { await app.close(); await mock.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const request = async (url, body, options = {}) => {
    const response = await fetch(app.origin + url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${app.store.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal });
    return { status: response.status, data: await response.json() };
  };
  const api = async (url, options = {}) => { const result = await request(url, options.body); if (result.status !== 200) throw new Error(result.data.error.message); return result.data; };
  if (configured) {
    const { state } = await api('/api/connection', { body: { revision: 0, ...mock.connection } });
    const draft = settings(state);
    draft.models.forEach(model => { model.enabled = true; });
    draft.routes.forEach(feature => {
      const ids = state.models.filter(model => feature.kind !== 'extract' || model.capabilities.structured !== false).map(model => model.id);
      feature.allowedModelIds = feature.selection === 'single' ? ids.slice(0, 1) : ids; feature.modelId = ids[0] || '';
    });
    await api('/api/settings', { body: draft });
  }
  return { get app() { return app; }, directory, mock, request, api, async restart() { const token = app.store.accessToken; await app.close(); app = await startDemo({ directory, port: 0 }); assert.equal(app.store.accessToken, token); return app; } };
}

test('direct client entry bootstraps a local session, keeps an empty catalog, and rejects foreign origins', async t => {
  const f = await fixture(t, false);
  const bootstrap = headers => fetch(f.app.origin + '/api/session', { method: 'POST', headers });
  const clientHeaders = { 'x-model-dock-client': '1', origin: f.app.origin, 'sec-fetch-site': 'same-origin' };
  assert.equal((await fetch(f.app.origin + '/api/state')).status, 401);
  assert.equal((await bootstrap({})).status, 403);
  for (const headers of [
    { ...clientHeaders, origin: 'https://foreign.example' },
    { ...clientHeaders, origin: 'http://127.0.0.1:9999' },
    { ...clientHeaders, origin: 'null' },
    { ...clientHeaders, 'sec-fetch-site': 'same-site' },
    { ...clientHeaders, 'sec-fetch-site': 'cross-site' }
  ]) assert.equal((await bootstrap(headers)).status, 403, JSON.stringify(headers));
  const preflight = await fetch(f.app.origin + '/api/session', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:9999', 'access-control-request-headers': 'x-model-dock-client' } });
  assert.equal(preflight.status, 403); assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const response = await bootstrap(clientHeaders), { session } = await response.json();
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.notEqual(session, f.app.store.accessToken);
  const state = await (await fetch(f.app.origin + '/api/state', { headers: { authorization: `Bearer ${session}` } })).json();
  assert.equal(state.mode, 'gateway'); assert.equal(state.connection.configured, false);
  assert.deepEqual(state.models, []); assert.deepEqual(state.connections, []);
  assert.ok(state.routes.every(route => !route.modelId && route.allowedModelIds.length === 0));
  const html = await (await fetch(f.app.origin + '/')).text();
  assert.ok(!html.includes(session)); assert.ok(!html.includes(f.app.store.accessToken));
  const connected = await f.request('/api/connection', { revision: state.revision, baseUrl: f.mock.connection.baseUrl, apiKey: `  ${f.mock.connection.apiKey}\n` }, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(connected.status, 200); assert.equal(connected.data.state.connection.configured, true);
  assert.ok(!JSON.stringify(connected.data).includes(f.mock.connection.apiKey));
  await f.restart();
  assert.equal((await fetch(f.app.origin + '/api/state', { headers: { authorization: `Bearer ${session}` } })).status, 401);
  const refreshed = await bootstrap({ 'x-model-dock-client': '1' });
  assert.equal(refreshed.status, 200); assert.notEqual((await refreshed.json()).session, session);
});

test('retired mock data is cleared before exposing the client catalog', async t => {
  const f = await fixture(t);
  await f.app.store.mutate(f.app.store.read().revision, state => { state.connection.mock = true; });
  await f.restart();
  const state = await f.api('/api/state');
  assert.equal(state.connection.configured, false); assert.equal(state.mode, 'gateway');
  assert.deepEqual(state.models, []); assert.deepEqual(state.connections, []);
  assert.ok(state.routes.every(route => !route.modelId && route.allowedModelIds.length === 0 && Object.keys(route.reasoningOverrides).length === 0));
});

for (const entry of ['', '?view=models', '?view=settings']) test(`client page ${entry || '/'} opens without a token and connects using a server-created project key`, async t => {
  const f = await fixture(t, false), model = f.mock.app.store.read().models[0];
  const key = await f.mock.app.gateway.createKey({ revision: f.mock.app.store.read().revision, name: 'Browser client', models: [model.id] });
  const html = await fs.readFile(new URL('../apps/demo/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: f.app.origin + '/' + entry }), win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; queueMicrotask(() => this.dispatchEvent(new win.Event('close'))); };
  win.sessionStorage.setItem('model-dock-demo-token', 'retired-session');
  const retired = { ...await f.api('/api/state'), models: [{ ...model, name: 'retired-simulated-model', reasoningPolicy: null, groupPolicies: {} }], connections: [{ id: model.connectionId, name: 'Retired', type: 'openai', enabled: true, status: 'connected' }] };
  win.sessionStorage.setItem('model-dock-demo-draft-v1', JSON.stringify({ snapshot: retired, base: settings(retired), draft: settings(retired) }));
  const descriptors = new Map(), nativeFetch = globalThis.fetch, requests = [];
  const globals = { window: win, document: win.document, location: win.location, history: win.history, sessionStorage: win.sessionStorage, FormData: win.FormData,
    fetch: (url, options = {}) => {
      if (!url.startsWith('/')) return nativeFetch(url, options);
      requests.push(url); return nativeFetch(new URL(url, f.app.origin), { ...options, headers: { ...options.headers, origin: f.app.origin, 'sec-fetch-site': 'same-origin' } });
    } };
  for (const [name, value] of Object.entries(globals)) { descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
  let module;
  t.after(() => { module?.dispose(); win.close(); for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const source = (await fs.readFile(new URL('../apps/demo/app.mjs', import.meta.url), 'utf8'))
    .replace("'./models.mjs'", JSON.stringify(new URL('../apps/demo/models.mjs', import.meta.url).href))
    .replace("'./events.mjs'", JSON.stringify(new URL('../packages/protocol/events.mjs', import.meta.url).href));
  const open = async () => { module = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${entry}:${requests.length}`).toString('base64')}`); };
  const document = win.document;
  const click = selector => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); };
  const fill = (name, value) => { document.querySelector(`[name="${name}"]`).value = value; };
  const submit = selector => { const form = document.querySelector(selector); form.dispatchEvent(new win.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button[type="submit"]') })); };
  await open();
  assert.equal(document.querySelector('#login-form'), null); assert.ok(document.querySelector('.shell'));
  assert.equal(document.querySelector('h1').textContent, entry === '?view=settings' ? '接入设置' : entry ? '功能与模型' : '你的功能，选择你的模型。');
  assert.deepEqual([...document.querySelectorAll('.nav [data-view]')].map(node => node.dataset.view), ['experience', 'models', 'settings']);
  assert.equal(document.querySelectorAll('.demo-heading [data-action="connection"]').length, 0);
  assert.match(document.querySelector('.mode-badge').textContent, /未连接/);
  if (entry === '?view=models') assert.match(document.querySelector('#model-list').textContent, /尚无授权模型/);
  if (entry !== '?view=settings') { assert.equal(document.querySelector('#connection-form'), null); click('.nav [data-view="settings"]'); }
  assert.ok(document.querySelector('#connection-form')); assert.equal(win.location.search, '?view=settings');
  assert.equal(document.querySelector('.nav [aria-current="page"]').dataset.view, 'settings');
  assert.ok(!document.body.textContent.includes('retired-simulated-model'));
  assert.equal(win.sessionStorage.getItem('model-dock-demo-token'), null);
  fill('baseUrl', f.mock.connection.baseUrl); fill('apiKey', 'md_key_invalid'); submit('#connection-form');
  await until(() => document.querySelector('#connection-form .form-error')?.textContent.includes('HTTP 401'));
  assert.equal(f.app.store.read().connection, null);
  assert.equal(document.querySelector('#connection-form button').disabled, false);
  fill('apiKey', `  ${key.token}  `); submit('#connection-form');
  await until(() => document.querySelector('.mode-badge').textContent === '已连接服务端' && !document.querySelector('[name="apiKey"]').value);
  assert.match(document.querySelector('.mode-badge').textContent, /已连接服务端/);
  assert.equal(f.app.store.read().connection.apiKey, key.token);
  assert.ok(!document.body.textContent.includes('retired-simulated-model'));
  assert.equal(win.sessionStorage.getItem('model-dock-demo-draft-v1'), null);
  assert.ok(!document.body.innerHTML.includes(key.token)); assert.ok(!JSON.stringify(win.sessionStorage).includes(key.token));
  assert.equal(document.querySelector('#dialog').open, false); assert.equal(document.querySelector('[name="apiKey"]').value, '');
  assert.match(document.querySelector('#catalog-summary').textContent, /1 个/);
  click('.nav [data-view="models"]');
  assert.equal(document.querySelectorAll('[data-mm="toggle-model"]').length, 1); assert.equal(document.querySelector('#connection-form'), null);
  click('.nav [data-view="settings"]');
  await f.mock.app.gateway.updateModel(model.id, { revision: f.mock.app.store.read().revision, enabled: false });
  click('[data-action="refresh-models"]');
  await until(() => document.querySelector('#catalog-summary').textContent.includes('0 个') && !document.querySelector('[data-action="refresh-models"]').disabled);
  assert.equal(f.app.store.read().catalog[0].available, false);
  await f.mock.app.gateway.updateModel(model.id, { revision: f.mock.app.store.read().revision, enabled: true });
  module.dispose(); await open();
  assert.ok(document.querySelector('#connection-form')); assert.ok(document.querySelector('.shell'));
  assert.equal(document.querySelector('.nav [aria-current="page"]').dataset.view, 'settings');
  assert.match(document.querySelector('#catalog-summary').textContent, /1 个/);
  assert.ok(f.app.store.read().catalog[0].available, 'reloading the client requests the current server catalog');
  assert.equal(requests.filter(url => url === '/api/session').length, 2);
  assert.ok(requests.every(url => url.startsWith('/api/')), 'the browser only calls its own client backend');
});

test('client settings stay independent, enforce single/multiple defaults and reasoning inheritance during real gateway requests', async t => {
  const f = await fixture(t), initialServer = f.mock.app.store.read();
  const state = await f.api('/api/state'), first = state.models[0].id, second = state.models[1].id;
  const draft = settings(state), summary = draft.routes.find(row => row.id === 'summarize');
  summary.modelId = second;
  draft.models[1].reasoningPolicy = { allowedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
  draft.models[1].groupPolicies['内容处理'] = { allowedEfforts: ['low', 'high'], defaultEffort: 'low' };
  summary.reasoningOverrides[second] = { allowedEfforts: ['low', 'high'], defaultEffort: 'high' };
  const saved = await f.request('/api/settings', draft); assert.equal(saved.status, 200);
  assert.deepEqual(f.mock.app.store.read(), initialServer, 'client configuration cannot alter model publication, aliases or project rights');
  const response = await f.request('/api/run', { featureId: 'summarize', prompt: 'line one\nline two', stream: false });
  assert.equal(response.status, 200); assert.match(response.data.choices[0].message.content, /demo-reasoner/);
  assert.equal(f.mock.calls.at(-1).model, 'demo-reasoner'); assert.equal(f.mock.calls.at(-1).reasoning_effort, 'high');
  assert.equal(f.mock.calls.at(-1).messages[0].role, 'system');
  assert.equal((await f.request('/api/run', { featureId: 'summarize', prompt: 'test', reasoningEffort: 'medium', stream: false })).data.error.code, 'reasoning_effort_disabled');
  assert.equal((await f.request('/api/run', { featureId: 'rewrite', prompt: 'test', modelId: second, stream: false })).status, 200);
  assert.equal(f.mock.calls.at(-1).reasoning_effort, 'low', 'subfeatures inherit the group policy');
  assert.equal((await f.request('/api/run', { featureId: 'chat', prompt: 'test', modelId: second, stream: false })).status, 409, 'single-model feature cannot request another model');
  const extraction = await f.request('/api/run', { featureId: 'extract', prompt: 'test', stream: false });
  assert.equal(JSON.parse(extraction.data.choices[0].message.content).demo, true);
  const invalid = settings(saved.data.state); invalid.routes.find(row => row.id === 'chat').allowedModelIds = [first, second];
  assert.equal((await f.request('/api/settings', invalid)).status, 400);
  assert.equal((await f.request('/api/settings', draft)).status, 409, 'stale drafts cannot overwrite newer app settings');
  const unbound = settings(await f.api('/api/state')); unbound.routes.find(row => row.id === 'summarize').allowedModelIds = [first];
  assert.equal((await f.request('/api/settings', unbound)).status, 200);
  const calls = f.mock.calls.length;
  assert.equal((await f.request('/api/run', { featureId: 'summarize', prompt: 'no fallback', stream: false })).status, 409);
  assert.equal(f.mock.calls.length, calls);
  const stored = f.app.store.read(); await f.restart();
  assert.deepEqual(f.app.store.read().models, stored.models); assert.deepEqual(f.app.store.read().routes, stored.routes);
  assert.deepEqual(f.mock.app.store.read(), initialServer);
});

test('project-key-only connection, catalog scoping, private storage, revocation, and local-origin boundaries', async t => {
  const f = await fixture(t, false), model = f.mock.app.store.read().models[0];
  assert.equal((await f.request('/api/connection', { revision: 0, baseUrl: f.mock.connection.baseUrl, apiKey: f.mock.app.store.adminToken })).status, 400);
  const key = await f.mock.app.gateway.createKey({ revision: f.mock.app.store.read().revision, name: 'limited demo', models: [model.id] });
  const connected = await f.request('/api/connection', { revision: 0, baseUrl: f.mock.connection.baseUrl, apiKey: key.token });
  assert.equal(connected.status, 200); assert.equal(connected.data.state.models.length, 1); assert.equal(connected.data.state.models[0].enabled, false);
  assert.ok(!JSON.stringify(connected.data).includes(key.token)); assert.ok(!JSON.stringify(connected.data).includes(f.app.store.accessToken));
  const draft = settings(connected.data.state); draft.models[0].enabled = true; draft.routes[0].allowedModelIds = [model.id]; draft.routes[0].modelId = model.id;
  assert.equal((await f.request('/api/settings', draft)).status, 200);
  assert.equal((await f.request('/api/state', undefined, { headers: { authorization: `Bearer ${key.token}` } })).status, 401);
  assert.equal((await f.request('/api/state', undefined, { headers: { origin: 'https://another-app.example' } })).status, 403);
  assert.equal((await f.request('/admin/state')).status, 404);
  await assert.rejects(new DemoStore(f.directory).open(), /in use/);
  if (process.platform !== 'win32') for (const file of ['client.json', 'access.token']) assert.equal((await fs.stat(path.join(f.directory, file))).mode & 0o777, 0o600);
  await f.mock.app.gateway.updateModel(model.id, { revision: f.mock.app.store.read().revision, enabled: false });
  assert.equal((await f.request('/api/run', { featureId: 'chat', prompt: 'must not run', stream: false })).status, 404, 'server enforces model disablement even before the client refreshes');
  const refreshed = await f.request('/api/refresh', { revision: f.app.store.read().revision });
  assert.equal(refreshed.data.state.models[0].available, false); assert.equal(refreshed.data.state.routes[0].modelId, model.id);
  assert.equal((await f.request('/api/run', { featureId: 'chat', prompt: 'must not fall back', stream: false })).status, 409);
  await f.mock.app.gateway.deleteKey(key.id, f.mock.app.store.read().revision);
  assert.equal((await f.request('/api/refresh', { revision: f.app.store.read().revision })).status, 401);
  assert.ok((await f.api('/api/state')).connection.error);
  assert.equal(f.mock.calls.length, 0);
});

test('changing project credentials disables previous app choices; streaming cancellation reaches the isolated gateway', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(f.app.origin + '/api/run', { method: 'POST', headers: { authorization: `Bearer ${f.app.store.accessToken}`, 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ featureId: 'chat', prompt: 'cancel me', stream: true }) });
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await until(() => f.mock.app.gateway.active.size === 0);
  assert.equal(f.mock.app.gateway.history[0].status, 'cancelled');
  const key = await f.mock.app.gateway.createKey({ revision: f.mock.app.store.read().revision, name: 'new project', models: ['*'] });
  const changed = await f.request('/api/connection', { revision: f.app.store.read().revision, baseUrl: f.mock.connection.baseUrl, apiKey: key.token });
  assert.equal(changed.status, 200); assert.ok(changed.data.state.models.every(model => !model.enabled));
  assert.equal((await f.request('/api/run', { featureId: 'chat', prompt: 'disabled', stream: false })).status, 409);
});

test('refresh reads newly published models, capability changes and reasoning switches without losing local drafts', async t => {
  const f = await fixture(t, false), gateway = f.mock.app.gateway;
  const publish = async (enabled, levels = ['low', 'high']) => gateway.saveModelSettings({ revision: f.mock.app.store.read().revision,
    models: f.mock.app.store.read().models.map((model, index) => ({ id: model.id, enabled: index === 1 && enabled,
      reasoningPolicy: index === 1 ? { allowedEfforts: levels, defaultEffort: levels.at(-1) } : null })) });
  await publish(false);
  const { state } = await f.api('/api/connection', { body: { revision: 0, ...f.mock.connection } });
  assert.equal(state.models.length, 0);
  const dom = new JSDOM('<div id="root"></div>', { url: f.app.origin }), win = dom.window, descriptors = new Map();
  for (const [key, value] of Object.entries({ window: win, document: win.document, sessionStorage: win.sessionStorage })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  let latest;
  const manager = new ModelManager({ api: f.api, onState: state => { latest = state; }, notify() {}, onDetails() {} });
  t.after(() => { manager.dispose(); win.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const root = win.document.getElementById('root'); manager.mount(root, state);
  manager.upsertRoute({ id: 'my-feature', name: '未保存的功能', kind: 'chat', group: '', selection: 'single' });
  await publish(true);
  await manager.handle({ dataset: { mm: 'refresh' } });
  const model = latest.models[0].id;
  assert.equal(latest.models.length, 1); assert.ok(latest.connection.refreshedAt);
  assert.equal(manager.snapshot.revision, latest.revision);
  assert.equal(manager.dirtyCount, 1); assert.equal(manager.form(model).enabled, false);
  assert.ok(manager.draft.routes.some(route => route.id === 'my-feature'));
  assert.deepEqual(manager.levels(model), ['low', 'high']); assert.equal(manager.model(model).defaultEffort, 'high');
  assert.match(root.textContent, /未保存的修改已保留/);
  await manager.handle({ dataset: { mm: 'save' } }); assert.equal(manager.error, '');
  await manager.handle({ dataset: { mm: 'toggle-model', id: model } });
  await manager.handle({ dataset: { mm: 'bind-route', id: model, route: 'chat' } });
  await publish(true, ['low']);
  await f.mock.app.store.mutate(f.mock.app.store.read().revision, state => { const row = state.models.find(row => row.id === model); row.capabilities.structured = false; row.capabilities.tools = true; });
  await manager.handle({ dataset: { mm: 'refresh' } });
  assert.deepEqual(manager.levels(model), ['low']); assert.equal(manager.model(model).defaultEffort, 'low');
  assert.equal(manager.model(model).capabilities.structured, false); assert.equal(manager.model(model).capabilities.tools, true);
  assert.equal(root.querySelector(`[data-mm="model-effort"][data-id="${model}"][data-level="high"]`), null);
  assert.ok(root.querySelector(`[data-mm="model-effort"][data-id="${model}"][data-level="low"]`));
  assert.equal(manager.form(model).enabled, true); assert.equal(manager.draft.routes[0].modelId, model);
  assert.equal(manager.dirtyCount, 2);
  await manager.handle({ dataset: { mm: 'save' } }); assert.equal(manager.error, '');
  const result = await f.request('/api/run', { featureId: 'chat', prompt: 'test refreshed defaults', stream: false });
  assert.equal(result.status, 200); assert.equal(f.mock.calls.at(-1).reasoning_effort, 'low');
  await publish(false, ['low']); await manager.handle({ dataset: { mm: 'refresh' } });
  assert.equal(manager.model(model).available, false); assert.equal(manager.usable(model), false);
  assert.equal(manager.draft.routes[0].modelId, model);
  await publish(true, ['low']); await manager.handle({ dataset: { mm: 'refresh' } });
  assert.equal(manager.model(model).available, true); assert.equal(manager.usable(model), true);
  // A different project's key is a settings change, even if all saved model
  // switches were already off. An old draft must not reactivate them silently.
  await manager.handle({ dataset: { mm: 'toggle-model', id: model } });
  await manager.handle({ dataset: { mm: 'save' } }); assert.equal(manager.error, '');
  await manager.handle({ dataset: { mm: 'toggle-model', id: model } });
  const beforeKeyChange = manager.snapshot.revision;
  const key = await gateway.createKey({ revision: f.mock.app.store.read().revision, name: 'Another project', models: [model] });
  await f.api('/api/connection', { body: { revision: f.app.store.read().revision, baseUrl: f.mock.connection.baseUrl, apiKey: key.token } });
  await manager.handle({ dataset: { mm: 'refresh' } });
  assert.equal(manager.snapshot.revision, beforeKeyChange);
  assert.match(root.textContent, /未保存修改已保留/);
  await manager.handle({ dataset: { mm: 'save' } }); assert.match(manager.error, /未保存的修改仍保留/);
  assert.equal(f.app.store.read().models[0].enabled, false);
});

test('client manager keeps drafts across views/reloads, edits group candidates/defaults, and isolates conflicting writes', async t => {
  const f = await fixture(t), serverBefore = f.mock.app.store.read();
  const dom = new JSDOM('<div id="root"></div>', { url: f.app.origin }), win = dom.window, descriptors = new Map();
  for (const [key, value] of Object.entries({ window: win, document: win.document, sessionStorage: win.sessionStorage })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  const create = () => new ModelManager({ api: f.api, onState() {}, notify() {}, onDetails() {} });
  let manager = create();
  t.after(() => { manager.dispose(); win.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const root = win.document.getElementById('root'); manager.mount(root, await f.api('/api/state'));
  const first = manager.draft.models[0].id, second = manager.draft.models[1].id;
  const click = selector => { const node = root.querySelector(selector); assert.ok(node, selector); assert.equal(node.disabled, false, selector); node.click(); };
  const single = `[data-mm="bind-route"][data-id="${second}"][data-route="chat"]`;
  click(single);
  assert.deepEqual(manager.draft.routes[0].allowedModelIds, [second]); assert.equal(manager.draft.routes[0].modelId, second);
  const radio = root.querySelector(single);
  assert.equal(radio.type, 'radio');
  radio.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.equal(manager.draft.routes[0].modelId, '');
  click(single);
  assert.equal(f.app.store.read().routes[0].modelId, first, 'selection is only a local draft');
  click(`[data-mm="pin"][data-id="${second}"][data-group="内容处理"][data-level="low"]`);
  click(`[data-mm="expand"][data-value="${second}:内容处理"]`);
  click(`[data-mm="pin"][data-id="${second}"][data-route="summarize"][data-level="medium"]`);
  click(`[data-mm="default"][data-id="${second}"][data-route="summarize"]`);
  click(`[data-mm="model-effort"][data-id="${second}"][data-level="medium"]`);
  assert.equal(manager.draft.routes.find(row => row.id === 'summarize').reasoningOverrides[second].defaultEffort, 'low');
  click('[data-mm="view"][data-value="functions"]');
  manager.search = '文档摘要';
  manager.renderTable();
  assert.equal(root.querySelectorAll('[data-mm="bind-group"]').length, 0, 'searching one child hides the bulk control');
  assert.equal(root.querySelectorAll('[data-mm="bind-route"][data-route="summarize"]').length, 2);
  manager.search = '';
  manager.renderTable();
  root.querySelector('[data-column="model"]').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(root.querySelector('[data-column="model"]').getAttribute('aria-valuenow'), '424');
  assert.equal(JSON.parse(win.sessionStorage.getItem('model-dock-demo-columns')).functions.model, 424);
  click('[data-mm="save"]'); await until(() => !manager.busy);
  assert.equal(manager.error, ''); assert.equal(manager.dirtyCount, 0);
  assert.equal((await f.request('/api/run', { featureId: 'summarize', prompt: 'fixture', stream: false })).status, 200);
  assert.equal(f.mock.calls.at(-1).model, 'demo-reasoner'); assert.equal(f.mock.calls.at(-1).reasoning_effort, 'low');
  click('[data-mm="view"][data-value="connections"]');
  click(`[data-mm="toggle-model"][data-id="${first}"]`);
  const revision = manager.snapshot.revision;
  const otherTab = settings(await f.api('/api/state')); otherTab.routes[0].name = '另一页面的功能名称';
  await f.request('/api/settings', otherTab);
  manager.accept(await f.api('/api/state')); manager.render();
  assert.equal(manager.snapshot.revision, revision); assert.match(root.textContent, /未保存修改已保留/);
  manager.remember(); manager.dispose(); root.replaceChildren(); manager = create(); manager.mount(root, await f.api('/api/state'));
  assert.equal(manager.snapshot.revision, revision); assert.ok(manager.dirtyCount);
  await manager.handle({ dataset: { mm: 'save' } }); assert.match(root.textContent, /未保存的修改仍保留/);
  await manager.handle({ dataset: { mm: 'revert' } }); assert.equal(manager.dirtyCount, 0);
  const search = root.querySelector('#model-search'); search.value = 'no-such-model'; search.dispatchEvent(new win.Event('input', { bubbles: true })); assert.match(root.textContent, /没有匹配/);
  await f.mock.app.store.mutate(f.mock.app.store.read().revision, state => { state.models[1].reasoningEfforts = []; state.models[1].defaultEffort = null; });
  manager.search = ''; await manager.handle({ dataset: { mm: 'refresh' } });
  click('[data-mm="reset-reasoning"]'); await manager.handle({ dataset: { mm: 'save' } });
  assert.equal(manager.error, ''); assert.equal(manager.dirtyCount, 0);
  assert.deepEqual(f.mock.app.store.read().routes, serverBefore.routes);
  assert.deepEqual(f.mock.app.store.read().keys, serverBefore.keys);
  assert.ok(f.mock.app.store.read().models.every(model => model.enabled));
  await f.mock.app.gateway.updateModel(first, { revision: f.mock.app.store.read().revision, enabled: false });
  await manager.handle({ dataset: { mm: 'refresh' } });
  const publication = f.mock.app.store.read().models;
  click(`[data-mm="toggle-model"][data-id="${first}"]`);
  await manager.handle({ dataset: { mm: 'save' } });
  assert.equal(manager.error, ''); assert.equal(f.app.store.read().models.find(model => model.id === first).enabled, false, 'unavailable models can still be disabled locally');
  assert.deepEqual(f.mock.app.store.read().models, publication);
});
