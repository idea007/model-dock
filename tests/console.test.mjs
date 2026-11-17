// DOM-level integration only; this does not replace visual browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import jsdomUtils from 'jsdom/lib/jsdom/living/generated/utils.js';
import { GatewayError } from '../packages/protocol/index.mjs';
import { setup, fixtureUpstream, until } from './helpers.mjs';

test('console links are single-use and authorize only an issued session', async t => {
  const app = await setup(t);
  const issue = '/admin/console-links';
  const sessionPath = '/console/session';
  const state = '/admin/state';
  const anon = '';
  const { data: credentials } = await app.mutate('/admin/keys', 'POST', { name: 'Console scope test', models: ['*'] });
  assert.equal((await app.request(issue, 'POST', undefined, anon)).status, 401);
  assert.equal((await app.request(issue, 'POST', undefined, credentials.token)).status, 401);

  const cli = fileURLToPath(new URL('../apps/gateway/cli.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'open', '--port', new URL(app.origin).port, '--print'], {
    env: { ...process.env, MODEL_DOCK_HOME: app.directory }
  });
  const url = new URL(stdout.trim());
  const code = new URLSearchParams(url.hash.slice(1)).get('session');
  assert.equal(url.origin, app.origin);
  assert.equal(url.search, '?view=connections');
  assert.ok(code?.startsWith('md_console_link_'));
  assert.equal((await app.request(state, 'GET', undefined, code)).status, 401);
  assert.equal((await app.request(sessionPath, 'POST', { code }, anon, { origin: 'http://localhost' })).status, 403);

  const { status, data } = await app.request(sessionPath, 'POST', { code }, anon);
  assert.equal(status, 200);
  const session = data.session;
  assert.equal((await app.request(sessionPath, 'POST', { code }, anon)).status, 401);
  assert.equal((await app.request(state, 'GET', undefined, session)).status, 200);
  assert.equal((await app.request('/v1/models', 'GET', undefined, session)).status, 200);
  assert.equal((await app.request(issue, 'POST', undefined, session)).status, 401);

  const secondLink = new URL(app.consoleLink());
  const secondCode = new URLSearchParams(secondLink.hash.slice(1)).get('session');
  assert.equal((await app.request(sessionPath, 'POST', { code: secondCode }, session)).data.session, session);
  assert.equal((await app.request(sessionPath, 'DELETE', undefined, session)).status, 200);
  assert.equal((await app.request(state, 'GET', undefined, session)).status, 401);
  assert.equal((await app.request(state)).status, 200);

  const now = Date.now();
  const expiringLink = new URL(app.consoleLink());
  const expiringCode = new URLSearchParams(expiringLink.hash.slice(1)).get('session');
  const clock = t.mock.method(Date, 'now', () => now + 6 * 60_000);
  assert.equal((await app.request(sessionPath, 'POST', { code: expiringCode }, anon)).status, 401);
  const freshLink = new URL(app.consoleLink());
  const freshCode = new URLSearchParams(freshLink.hash.slice(1)).get('session');
  const freshSession = (await app.request(sessionPath, 'POST', { code: freshCode }, anon)).data.session;
  assert.ok(freshSession);
  clock.mock.mockImplementation(() => now + 8 * 24 * 60 * 60_000);
  assert.equal((await app.request(state, 'GET', undefined, freshSession)).status, 401);
});

test('console: login, connection discovery, model publication, scoped key and JSON/SSE playground', async t => {
  const upstream = await fixtureUpstream(t, [{
    id: 'shared', max_input_tokens: 1_000_000, max_output_tokens: 393_216, context_window: 1_000_000,
    reasoning_efforts: ['none', 'low', 'high', 'max'], default_reasoning_effort: 'high', capabilities: { text: true, thinking: true, image_input: true, tools: true }
  }, { id: 'slow' }, { id: 'broken' }]), app = await setup(t);
  const html = await fs.readFile(new URL('../apps/console/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: app.origin });
  const win = dom.window, document = win.document;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; queueMicrotask(() => this.dispatchEvent(new win.Event('close'))); };
  const descriptors = new Map(), nativeFetch = globalThis.fetch;
  let clipboard, mediaFetch;
  const globals = { window: win, document, location: win.location, history: win.history, sessionStorage: win.sessionStorage, localStorage: win.localStorage,
    FormData: win.FormData, navigator: { clipboard: { writeText: async text => { clipboard = text; } } },
    fetch: (url, options) => {
      const location = new URL(url, app.origin);
      return (location.origin === app.origin && mediaFetch?.(location.pathname, options)) || nativeFetch(location, options);
    } };
  for (const [key, value] of Object.entries(globals)) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  let module;
  t.after(() => {
    module?.dispose(); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const source = (await fs.readFile(new URL('../apps/console/app.mjs', import.meta.url), 'utf8'))
    .replace("'./events.mjs'", JSON.stringify(new URL('../packages/protocol/events.mjs', import.meta.url).href))
    .replace("'./image-options.mjs'", JSON.stringify(new URL('../packages/protocol/image-options.mjs', import.meta.url).href))
    .replace("'./api-docs.mjs'", JSON.stringify(new URL('../apps/console/api-docs.mjs', import.meta.url).href))
    .replace("'./playground-media.mjs'", JSON.stringify(new URL('../apps/console/playground-media.mjs', import.meta.url).href))
    .replace("'./usage.mjs'", JSON.stringify(new URL('../apps/console/usage.mjs', import.meta.url).href))
    .replace("'../../packages/ui/i18n.mjs'", JSON.stringify(new URL('../packages/ui/i18n.mjs', import.meta.url).href));
  module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const click = selector => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); };
  const fill = (name, value) => { const field = document.querySelector(`[name="${name}"]`); assert.ok(field, name); field.value = value; };
  const submit = selector => {
    const form = document.querySelector(selector); assert.ok(form, selector);
    form.dispatchEvent(new win.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button[type=submit],button.primary') }));
  };
  const modalDone = () => until(() => !document.querySelector('#dialog').open);
  const providerGroup = type => `[aria-labelledby="provider-${type}-heading"]`;
  const directAdd = (group, type = group) => `${providerGroup(group)} .provider-actions > [data-action="add-connection"][data-type="${type}"]`;
  const addCredential = `${providerGroup('openai')} [data-action="add-api-credential"]`;
  const addLocalEndpoint = `${providerGroup('local')} [data-action="add-local-endpoint"]`;
  const addService = '[data-action="add-api-service"]';
  const connectionNames = type => [...document.querySelectorAll(`${providerGroup(type)} .connection-card h4`)].map(heading => heading.textContent);
  const serviceSources = () => [...document.querySelectorAll('.catalog-source h2')].map(heading => heading.textContent);
  const manageServices = credentialId => click(`.catalog-source [data-action="manage-api-services"][data-id="${credentialId}"]`);
  const managedServices = () => [...document.querySelectorAll('.service-action-list strong')].map(name => name.textContent).sort();
  const closeDialog = () => click('#dialog [data-action="close-dialog"]');
  const catalogModelIds = () => [...document.querySelectorAll('.catalog-model')].map(row => row.dataset.modelId.split('/').at(-1));
  fill('token', 'incorrect'); submit('#login-form');
  await until(() => document.querySelector('#login-form .form-error')?.textContent.includes('需要有效的访问令牌'));
  fill('token', 'unfinished');
  click('[data-language="en"]');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.querySelector('h1').textContent, 'Open the console');
  assert.equal(document.querySelector('#login-form [name="token"]').value, 'unfinished');
  assert.match(document.querySelector('#login-form .form-error').textContent, /valid access token/);
  click('[data-language="zh-CN"]');
  fill('token', app.admin); submit('#login-form');
  await until(() => document.querySelector('.shell'));
  assert.equal(document.querySelector('h1').textContent, '连接与凭证');
  assert.deepEqual([...document.querySelectorAll('.nav button')].map(button => button.textContent), ['连接与凭证', '模型与服务', '接口文档', '调用测试', '项目访问', '用量']);
  assert.ok(document.querySelector('.page > section').classList.contains('connections-endpoint'));
  assert.equal(document.querySelector('.stats'), null);
  assert.deepEqual([...document.querySelectorAll('.provider-group h3')].map(heading => heading.textContent), ['模型 API', '本机服务', 'Ollama', 'Codex']);
  assert.equal(document.querySelectorAll('.provider-empty').length, 4);
  for (const type of ['ollama', 'codex']) assert.ok(document.querySelector(directAdd(type)));
  assert.ok(document.querySelector(addCredential));
  assert.ok(document.querySelector(addLocalEndpoint));
  assert.equal(document.querySelector(`${providerGroup('openai')} [data-action="add-connection"]`), null);
  click('.connections-endpoint [data-action="copy-endpoint"]');
  assert.equal(clipboard, `${app.origin}/v1`);
  click('.nav [data-view="api"]');
  assert.equal(document.querySelector('a[href="/openapi.json"]').getAttribute('download'), 'model-dock.openapi.json');
  assert.equal(win.location.search, '?view=api');
  assert.equal(document.querySelector('h1').textContent, '接口文档');
  assert.deepEqual([...document.querySelectorAll('.api-endpoint')].map(section => section.dataset.apiId),
    ['models', 'chat', 'responses', 'images', 'speech', 'transcription', 'embeddings', 'video-create', 'video-status', 'video-content', 'health']);
  assert.match(document.querySelector('#api-code-speech-request').textContent, /--output 'speech\.mp3'/);
  assert.match(document.querySelector('#api-code-video-content-request').textContent, /-L .*\/v1\/videos\/VIDEO_ID\/content/);
  assert.equal(document.querySelectorAll('.api-endpoint[open]').length, 0);
  assert.match(document.querySelector('[data-api-id="chat"]').textContent, /当前没有可用的文本模型/);
  assert.match(document.querySelector('#api-code-health-request').textContent, new RegExp(`${app.origin}/healthz`));
  assert.doesNotMatch(document.querySelector('#api-code-health-request').textContent, /Authorization/);
  click('[data-api-id="models"] > summary');
  click('[data-api-id="chat"] > summary');
  assert.equal(document.querySelectorAll('.api-endpoint[open]').length, 2, 'endpoints expand independently');
  click('.sidebar-bottom [data-language="en"]');
  assert.equal(document.querySelector('h1').textContent, 'API documentation');
  assert.equal(document.querySelectorAll('.api-endpoint[open]').length, 2);
  assert.match(document.querySelector('[data-api-id="chat"] .api-endpoint-body').textContent, /Request parameters/);
  assert.equal(win.localStorage.getItem('model-dock-language'), 'en');
  click('.sidebar-bottom [data-language="zh-CN"]');
  click('[data-code-id="api-code-models-request"]');
  assert.equal(clipboard, `curl '${app.origin}/v1/models' \\\n  -H "Authorization: Bearer $MODEL_DOCK_API_KEY"`);
  click('.nav [data-view="connections"]');
  click('.nav [data-view="api"]');
  assert.equal(document.querySelectorAll('.api-endpoint[open]').length, 2, 'navigation preserves expanded endpoints');
  click('[data-api-id="models"] > summary');
  assert.equal(document.querySelector('[data-api-id="models"]').open, false);
  click('.nav [data-view="connections"]');
  click(addCredential);
  fill('name', '本机地址误填'); fill('baseUrl', `${upstream.origin}/v1`); submit('#modal-form');
  await until(() => document.querySelector('#modal-error').textContent.includes('添加本机连接'));
  assert.equal(app.store.read().apiCredentials.length, 0);
  closeDialog();
  click(addLocalEndpoint);
  assert.equal(document.querySelector('#modal-form [name="service"]'), null);
  assert.match(document.querySelector('[name="apiKey"]').closest('label').textContent, /服务令牌/);
  fill('name', '测试本机 API'); fill('baseUrl', `${upstream.origin}/v1`); fill('apiKey', 'fixture-upstream'); submit('#modal-form');
  await modalDone();
  assert.deepEqual(connectionNames('local'), ['测试本机 API']);
  assert.deepEqual(connectionNames('openai'), []);
  assert.equal(app.store.read().connections.length, 0, 'saving an endpoint does not add a model service');
  const testCredential = app.store.read().apiCredentials[0];
  assert.equal(document.querySelector(`${providerGroup('local')} [data-action="discover"]`), null);
  click(`[data-view="models"][data-credential="${testCredential.id}"]`);
  assert.ok(document.querySelector(`.catalog-secondary ${addService}`));
  click(addService);
  assert.equal(document.querySelector('#modal-form [name="apiKey"]'), null);
  assert.equal(document.querySelector('[name="credentialId"]').value, testCredential.id);
  assert.equal(document.querySelector('[name="credentialId"]').selectedOptions[0].parentElement.label, '本机服务');
  assert.equal(document.querySelector('[name="baseUrl"]').value, `${upstream.origin}/v1`);
  fill('name', '测试 API'); fill('service', 'openai'); submit('#modal-form');
  await modalDone();
  assert.deepEqual([...document.querySelectorAll('.catalog-header > span')].map(header => header.textContent.trim()), ['凭证 / 服务', '模型', '思考深度（可选 / 默认）']);
  assert.deepEqual([...document.querySelectorAll('.catalog-resizer')].map(handle => handle.dataset.catalogColumn), ['provider', 'model', 'effort']);
  const effortWidth = document.querySelector('[data-catalog-column="effort"]');
  effortWidth.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(effortWidth.getAttribute('aria-valuenow'), '328');
  assert.equal(JSON.parse(win.localStorage.getItem('model-dock-catalog-columns')).effort, 328);
  effortWidth.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  const pointer = { pointerId: 1, bubbles: true };
  effortWidth.dispatchEvent(new win.PointerEvent('pointerdown', { ...pointer, clientX: 320 }));
  win.dispatchEvent(new win.PointerEvent('pointermove', { ...pointer, clientX: 400 }));
  assert.equal(effortWidth.getAttribute('aria-valuenow'), '400');
  assert.equal(JSON.parse(win.localStorage.getItem('model-dock-catalog-columns')).effort, 320);
  win.dispatchEvent(new win.PointerEvent('pointerup', { ...pointer, clientX: 400 }));
  assert.equal(effortWidth.hasAttribute('data-resizing'), false);
  assert.equal(JSON.parse(win.localStorage.getItem('model-dock-catalog-columns')).effort, 400);
  effortWidth.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(JSON.parse(win.localStorage.getItem('model-dock-catalog-columns')).effort, 320);
  assert.equal(document.querySelector('.catalog-source details'), null);
  manageServices(testCredential.id);
  assert.deepEqual(managedServices(), ['测试 API']);
  click('.service-action-list [data-action="add-model"]');
  assert.equal(document.querySelector('#dialog-title').textContent, '手动添加模型');
  closeDialog();
  click('[data-action="check-credential"]');
  await until(() => app.store.read().models.length === 3 && document.querySelector('.catalog-runtime')?.dataset.status === 'connected');
  assert.match(document.querySelector('h1').textContent, /模型与服务/);
  assert.equal(document.querySelectorAll('.catalog-group').length, 1);
  assert.deepEqual(serviceSources(), ['测试本机 API']);
  assert.equal(document.querySelector('.catalog-source > .catalog-badge').textContent, '3 / 3 已配置');
  const categoryButtons = () => [...document.querySelectorAll('.catalog-filters button')];
  assert.deepEqual(categoryButtons().map(button => button.textContent), ['全部', '文本与理解', '图片生成', '视频生成', '语音识别', '语音合成']);
  click('[data-action="catalog-filter"][data-value="image_generation"]');
  assert.match(document.querySelector('#catalog-table').textContent, /暂无图片生成模型/);
  assert.equal(document.querySelectorAll('.catalog-model').length, 0);
  click('[data-action="catalog-filter"][data-value="content_ai"]');
  assert.equal(document.querySelectorAll('.catalog-model').length, 3);
  const model = app.store.read().models.find(item => item.nativeId === 'shared');
  assert.equal(document.querySelector('[data-action="add-route"]'), null, 'business features have moved out of the server console');
  const row = `[data-model-id="${model.id}"]`;
  const effort = `${row} .catalog-model-info [data-action="toggle-open-effort"][data-level="none"]`;
  const selectable = `${row} .catalog-reasoning [data-action="toggle-model-effort"][data-level="none"]`;
  const openHigh = `${row} [data-action="toggle-open-effort"][data-level="high"]`;
  const selectHigh = `${row} [data-action="toggle-model-effort"][data-level="high"]`;
  const pin = `${row} .catalog-reasoning [data-action="pin-model-effort"][data-level="low"]`;
  const publish = `${row} .catalog-model-info [data-action="publish-model"]`;
  assert.match(document.querySelector(`${row} .catalog-limits`).textContent.replace(/\s+/g, ' '), /最大输入 1M · 最大输出 384K tokens/);
  assert.equal(document.querySelectorAll(`${row} .catalog-levels`).length, 2);
  assert.match(document.querySelector(effort).textContent, /关闭（none）/);
  assert.match(document.querySelector(publish).textContent, /未启用/);
  assert.equal(document.querySelector(`${row} .catalog-warning`), null);
  assert.equal(document.querySelector(effort).disabled, true);
  assert.equal(document.querySelector(selectable).disabled, true);
  click(publish);
  assert.equal(document.querySelector(publish).getAttribute('aria-checked'), 'true');
  assert.equal(app.store.read().models.find(row => row.id === model.id).enabled, false, 'publication changes wait for save');
  click(selectable);
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector(selectable).getAttribute('aria-pressed'), 'false');
  click(effort);
  assert.equal(document.querySelector(selectable).disabled, true);
  assert.equal(document.querySelector(selectable).title, '模型未开放此深度');
  click(selectHigh);
  assert.equal(document.querySelector(openHigh).getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector(selectHigh).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(pin).getAttribute('aria-pressed'), 'true');
  click(`${row} [data-action="pin-model-effort"][data-level="max"]`);
  assert.equal(document.querySelector(pin).getAttribute('aria-pressed'), 'false');
  click(pin);
  assert.equal(app.store.read().models.find(row => row.id === model.id).reasoningPolicy, undefined, 'reasoning changes wait for save');
  click('[data-language="en"]');
  assert.equal(document.querySelector(publish).getAttribute('aria-checked'), 'true');
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(selectHigh).getAttribute('aria-pressed'), 'false');
  assert.match(document.querySelector('[data-action="save-publication"]').textContent, /Save changes/);
  click('[data-language="zh-CN"]');
  assert.match(document.querySelector('.catalog-runtime').textContent, /API 连接正常/);
  const check = '[data-action="check-credential"]';
  const refresh = '[data-action="refresh-catalog"]';
  const provider = app.gateway.providers.openai;
  const pendingCheck = Promise.withResolvers();
  const pendingRefresh = Promise.withResolvers();
  let checks = 0, inferenceDenied = false;
  app.gateway.providers.openai = {
    ...provider,
    async discover(...args) {
      checks++;
      if (checks === 1) {
        await pendingCheck.promise;
        throw new GatewayError('Fixture rejected the catalog request.', 502, 'upstream_auth_failed');
      }
      if (checks === 2) await pendingRefresh.promise;
      return provider.discover(...args);
    },
    async *generate(...args) {
      if (inferenceDenied) throw new GatewayError('Fixture rejected the inference request.', 502, 'upstream_auth_failed');
      yield* provider.generate(...args);
    }
  };
  click(check);
  assert.equal(document.querySelector(check).getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector(check).disabled, true);
  assert.equal(document.querySelector(refresh).disabled, true);
  assert.match(document.querySelector('.catalog-runtime').textContent, /正在检测/);
  pendingCheck.resolve();
  await until(() => document.querySelector('.catalog-runtime')?.dataset.status === 'error');
  assert.match(document.querySelector('.catalog-runtime').title, /API 密钥/);
  assert.equal(document.querySelectorAll('.catalog-model').length, 3, 'a failed check keeps the catalog');
  assert.equal(document.querySelector('[data-action="save-publication"]').disabled, false);
  assert.match(document.querySelector(refresh).textContent, /保留修改/);
  click(refresh);
  try {
    await until(() => document.querySelector('.catalog-secondary [role="status"]')?.textContent === '正在检查服务 1 / 1');
  } finally { pendingRefresh.resolve(); }
  await until(() => document.querySelector('.catalog-runtime')?.dataset.status === 'connected');
  assert.equal(checks, 2, 'toolbar refresh checks the configured service');
  assert.equal(document.querySelector(publish).getAttribute('aria-checked'), 'true');
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(pin).getAttribute('aria-pressed'), 'true');
  assert.equal(app.store.read().models.find(row => row.id === model.id).enabled, false, 'refresh does not save the draft');
  assert.equal(upstream.calls.length, 0, 'status checks do not invoke a model');
  click('[data-action="save-publication"]');
  await until(() => app.store.read().models.find(row => row.id === model.id).enabled);
  await until(() => document.querySelector('[data-action="save-publication"]').textContent === '已保存');
  assert.deepEqual(app.store.read().models.find(row => row.id === model.id).reasoningPolicy,
    { openEfforts: ['low', 'high', 'max'], allowedEfforts: ['low', 'max'], defaultEffort: 'low' });
  click(`${row} .catalog-reasoning [data-action="reset-model-efforts"]`);
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(selectHigh).getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector(`${row} [data-action="pin-model-effort"][data-level="high"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(app.store.read().models.find(row => row.id === model.id).reasoningPolicy.defaultEffort, 'low');
  click('.catalog-secondary [data-action="revert-publication"]');
  assert.equal(document.querySelector(selectHigh).getAttribute('aria-pressed'), 'false');
  click(`${row} .catalog-limits [data-action="model-details"]`);
  assert.equal(document.querySelector('#dialog-title').textContent, '模型详情与价格');
  assert.match(document.querySelector('#dialog').textContent, /未配置模型单价/);
  click('#dialog [data-action="close-dialog"]');
  click('[data-view="keys"]'); click('[data-action="add-key"]'); fill('name', '测试 demo');
  document.querySelector(`[name="models"][value="${model.id}"]`).checked = true;
  submit('#modal-form');
  await until(() => document.querySelector('#new-token'));
  const key = document.querySelector('#new-token').textContent;
  assert.match(key, /^md_key_/);
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key)).data.data.map(item => item.id), [model.id]);
  assert.ok(document.querySelector('#dialog').open, 'new token dialog survives the prior dialog close event');
  submit('#modal-form'); await modalDone();
  click('[data-action="edit-key-limits"]');
  fill('requestsPerMinute', '12'); submit('#modal-form'); await modalDone();
  assert.equal(app.store.read().keys[0].limits.requestsPerMinute, 12);
  assert.match(document.querySelector('.table-wrap').textContent, /12 次\/分钟/);
  const callsBeforeDocs = upstream.calls.length;
  click('.nav [data-view="api"]');
  assert.equal(document.querySelector('[data-api-id="chat"]').open, true);
  assert.equal(document.querySelector('[data-api-id="models"]').open, false);
  click('[data-code-id="api-code-chat-request"]');
  assert.ok(clipboard.includes(`${app.origin}/v1/chat/completions`));
  const exampleBody = JSON.parse(clipboard.match(/-d '([\s\S]+)'$/)[1]);
  assert.equal(exampleBody.model, model.id, 'example uses the currently published model ID');
  assert.deepEqual(exampleBody.messages, [{ role: 'user', content: '你好，请介绍一下你自己。' }]);
  click('[data-api-id="responses"] > summary');
  click('[data-code-id="api-code-responses-request"]');
  assert.ok(clipboard.includes(`${app.origin}/v1/responses`));
  assert.deepEqual(JSON.parse(clipboard.match(/-d '([\s\S]+)'$/)[1]), { model: model.id, input: exampleBody.messages[0].content, store: false });
  click('[data-code-id="api-code-chat-tool"]');
  const chatTool = JSON.parse(clipboard.match(/-d '([\s\S]+)'$/)[1]);
  assert.equal(chatTool.model, model.id);
  assert.equal(chatTool.parallel_tool_calls, false);
  assert.equal(chatTool.tools[0].function.name, 'add');
  click('[data-code-id="api-code-chat-tool-result"]');
  const chatReplay = JSON.parse(clipboard.match(/-d '([\s\S]+)'$/)[1]);
  assert.equal(chatReplay.messages.at(-1).tool_call_id, chatReplay.messages.at(-2).tool_calls[0].id);
  assert.deepEqual(JSON.parse(chatReplay.messages.at(-1).content), { result: 42 });
  click('[data-code-id="api-code-chat-vision"]');
  assert.ok(clipboard.includes(`${app.origin}/v1/chat/completions`) && clipboard.includes(model.id));
  assert.match(clipboard, /type: "image_url", image_url: \{ url: image \}/);
  for (const secret of [app.admin, key, 'fixture-upstream']) assert.ok(!document.querySelector('.api-docs').textContent.includes(secret), 'documentation never embeds stored credentials');
  assert.equal(upstream.calls.length, callsBeforeDocs, 'browsing and copying documentation does not invoke providers');
  click('[data-view="playground"]'); fill('model', model.id); fill('prompt', '你好'); submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '已完成');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  assert.match(document.querySelector('#response-meta').textContent, /输入 5 \/ 输出 7/);
  assert.equal(upstream.calls.at(-1).body.reasoning_effort, 'low');
  await until(() => !document.querySelector('#send-button').disabled);
  click('[data-language="en"]');
  assert.equal(document.querySelector('#response-status').textContent, 'Completed');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  assert.match(document.querySelector('#response-meta').textContent, /Input 5 \/ Output 7/);
  assert.equal(document.querySelector('[name="prompt"]').value, '你好');
  click('[data-language="zh-CN"]');
  document.querySelector('[name="stream"]').checked = false; submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '已完成');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  await until(() => !document.querySelector('#send-button').disabled);
  inferenceDenied = true;
  submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '失败');
  click('[data-view="connections"]'); click('[data-action="refresh"]');
  await until(() => document.querySelector('#toast').textContent === '状态已刷新。');
  click('[data-view="models"]');
  assert.match(document.querySelector('.catalog-runtime').textContent, /API 最近调用失败/);
  click(check);
  await until(() => document.querySelector('.catalog-runtime')?.dataset.status === 'connected');

  click('[data-view="usage"]');
  await until(() => document.querySelector('.usage-calls-table [data-usage-record]'));
  assert.match(document.querySelector('.usage-calls-table thead').textContent, /接口类型/);
  assert.match(document.querySelector('.usage-calls-table tbody').textContent, /Chat Completions/);
  click('[data-usage-action="filters"]');
  const endpoint = document.querySelector('[data-usage-filter="endpoint"]');
  endpoint.value = 'chat';
  endpoint.dispatchEvent(new win.Event('change', { bubbles: true }));
  await until(() => document.querySelector('.usage-calls-table [data-usage-record]'));
  click('[data-usage-tab="aiUsage"]');
  await until(() => document.querySelector('.usage-groups-table'));
  assert.equal(document.querySelector('[data-usage-filter="endpoint"]').value, 'chat');
  assert.equal(document.querySelector('.usage-matrix, [data-usage-filter="feature"]'), null);
  const grouping = document.querySelector('[data-usage-change="dimension"]');
  assert.equal(grouping.querySelector('[value="endpoints"]').textContent, '接口类型');
  assert.equal(grouping.querySelector('[value="features"]'), null);
  grouping.value = 'endpoints';
  grouping.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.match(document.querySelector('.usage-groups-table tbody').textContent, /Chat Completions/);

  const storedConnections = [
    { type: 'ollama', name: '测试 Ollama', enabled: false },
    { type: 'codex', name: '测试 Codex' },
    { type: 'openai', name: '第二个 API', baseUrl: 'https://second-provider.example/v1' },
    { type: 'service', service: 'minimax-image', name: 'MiniMax 生图', baseUrl: 'https://provider.example', apiKey: 'minimax-fixture' },
    { type: 'service', service: 'minimax-chat', name: 'MiniMax 文本', baseUrl: 'https://provider.example/v1', apiKey: 'minimax-fixture' }
  ];
  for (const connection of storedConnections) {
    const result = await app.mutate('/admin/connections', 'POST', connection);
    assert.equal(result.status, 200);
  }
  click('[data-view="connections"]'); click('[data-action="refresh"]');
  await until(() => connectionNames('codex').length === 1);
  assert.deepEqual(connectionNames('openai'), ['第二个 API', 'MiniMax']);
  assert.deepEqual(connectionNames('local'), ['测试本机 API']);
  assert.equal(document.querySelector(`${providerGroup('openai')} .provider-empty`), null);
  assert.deepEqual(connectionNames('ollama'), ['测试 Ollama']);
  assert.deepEqual(connectionNames('codex'), ['测试 Codex']);
  assert.match(document.querySelector(`${providerGroup('ollama')} .connection-card`).textContent, /已停用/);
  assert.ok(document.querySelector(addCredential));
  assert.equal(document.querySelector(directAdd('ollama')), null);
  assert.equal(document.querySelector(`${providerGroup('codex')} [data-action="add-connection"]`), null);

  const miniMaxCredentialId = app.store.read().connections.find(connection => connection.service === 'minimax-chat').credentialId;
  click(`[data-action="edit-api-credential"][data-id="${miniMaxCredentialId}"]`);
  assert.match(document.querySelector('.modal-heading').textContent, /2 个关联来源/);
  fill('name', '第二个 API');
  fill('apiKey', 'minimax-rotated'); submit('#modal-form');
  await modalDone();
  const miniMaxName = connectionNames('openai').at(-1);
  assert.equal(miniMaxName, '第二个 API · 凭证 2');

  click(`[data-view="models"][data-credential="${miniMaxCredentialId}"]`);
  assert.ok(document.querySelector('.catalog-scope').textContent.includes(`${miniMaxName} 的模型与服务`));
  assert.deepEqual(serviceSources(), [miniMaxName]);
  click(`[data-action="check-credential"][data-id="${miniMaxCredentialId}"]`);
  await until(() => document.querySelector('.catalog-runtime')?.dataset.status === 'connected');
  assert.equal(app.store.read().connections.filter(connection => connection.credentialId === miniMaxCredentialId && connection.status === 'connected').length, 2);
  assert.deepEqual(catalogModelIds(), ['minimax-chat', 'minimax-image']);
  const searchCatalog = value => {
    const search = document.querySelector('#catalog-search');
    search.value = value;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  searchCatalog(miniMaxName);
  assert.deepEqual(serviceSources(), [miniMaxName]);
  assert.deepEqual(catalogModelIds(), ['minimax-chat', 'minimax-image']);
  searchCatalog('MiniMax 生图');
  assert.deepEqual(serviceSources(), [miniMaxName]);
  assert.deepEqual(catalogModelIds(), ['minimax-image']);
  searchCatalog('');
  click(addService);
  fill('name', 'MiniMax 视频'); fill('service', 'minimax-video');
  document.querySelector('[name="service"]').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('[name="credentialId"]').value, miniMaxCredentialId);
  assert.equal(document.querySelector('[name="credentialId"]').selectedOptions[0].parentElement.label, '供应商凭证');
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector('[name="baseUrl"]').value, 'https://provider.example');
  submit('#modal-form');
  await modalDone();
  const service = app.store.read().connections.find(connection => connection.service === 'minimax-video');
  assert.equal(service.credentialId, miniMaxCredentialId);
  assert.equal(app.store.decrypt(app.store.connectionKey(service)), 'minimax-rotated');
  manageServices(miniMaxCredentialId);
  click(`.service-action-list [data-action="edit-connection"][data-id="${service.id}"]`);
  assert.equal(document.querySelector('[name="service"]').value, 'minimax-video');
  assert.equal(document.querySelector('[name="service"]').disabled, true);
  assert.equal(document.querySelector('#service-upstream-model').hidden, false);
  fill('name', '测试 MiniMax 视频'); fill('upstreamModel', 'MiniMax-H3'); submit('#modal-form');
  await modalDone();
  assert.equal(app.store.read().connections.find(connection => connection.id === service.id).upstreamModel, 'MiniMax-H3');
  assert.deepEqual(serviceSources(), [miniMaxName]);
  manageServices(miniMaxCredentialId);
  assert.deepEqual(managedServices(), ['MiniMax 文本', 'MiniMax 生图', '测试 MiniMax 视频']);
  closeDialog();
  click('[data-view="connections"]');
  assert.deepEqual(connectionNames('openai'), ['第二个 API · 凭证 1', miniMaxName]);
  const miniMaxCard = `[data-action="edit-api-credential"][data-id="${miniMaxCredentialId}"]`;
  assert.match(document.querySelector(miniMaxCard).closest('li').textContent, /关联 3 个来源/);

  const speech = await app.mutate('/admin/connections', 'POST', {
    type: 'service', service: 'minimax-speech', name: 'MiniMax 语音', credentialId: miniMaxCredentialId
  });
  const mixedApi = await app.mutate('/admin/connections', 'POST', {
    type: 'openai', name: 'MiniMax 混合 API', credentialId: miniMaxCredentialId
  });
  assert.equal(speech.status, 200);
  assert.equal(mixedApi.status, 200);
  const originalDiscovery = app.gateway.providers.openai.discover;
  t.mock.method(app.gateway.providers.openai, 'discover', (connection, options) => connection.id === mixedApi.data.id ? [
    { nativeId: 'mixed-image', name: 'Mixed image', capability: 'image_generation', capabilities: { text: false } },
    { nativeId: 'mixed-text', name: 'Mixed text', capabilities: { text: true } }
  ] : originalDiscovery(connection, options));
  for (const connection of app.store.read().connections.filter(item => item.credentialId === miniMaxCredentialId)) {
    assert.equal((await app.mutate(`/admin/connections/${connection.id}/discover`, 'POST')).status, 200);
  }
  click('[data-action="refresh"]');
  await until(() => document.querySelector(miniMaxCard).closest('li').textContent.includes('关联 5 个来源'));
  click(`[data-view="models"][data-credential="${miniMaxCredentialId}"]`);
  assert.deepEqual(serviceSources(), [miniMaxName]);
  assert.deepEqual(catalogModelIds(), ['minimax-chat', 'mixed-text', 'minimax-image', 'mixed-image', 'minimax-video', 'minimax-speech']);
  click('[data-action="catalog-filter"][data-value="image_generation"]');
  assert.deepEqual(serviceSources(), [miniMaxName]);
  assert.deepEqual(catalogModelIds(), ['minimax-image', 'mixed-image']);
  assert.equal(document.querySelectorAll('.catalog-model .catalog-levels').length, 0);
  assert.ok([...document.querySelectorAll('.catalog-model .catalog-limits')].every(limits => limits.textContent.includes('按媒体规格')));
  assert.deepEqual([...document.querySelectorAll('.catalog-model .catalog-badge')].map(badge => badge.textContent), ['图片生成', '图片生成']);
  click('[data-action="catalog-filter"][data-value="all"]');
  click('.nav [data-view="models"]');
  assert.deepEqual(serviceSources().filter(name => name.startsWith('第二个 API')).sort(), ['第二个 API · 凭证 1', miniMaxName]);
  click('.nav [data-view="connections"]');

  click(addLocalEndpoint);
  fill('name', '测试 MFLUX'); fill('baseUrl', 'http://127.0.0.1:9');
  fill('apiKey', 'synthetic_mflux_service_token_example'); submit('#modal-form');
  await modalDone();
  const mfluxCredential = app.store.read().apiCredentials.find(item => item.name === '测试 MFLUX');
  click(`[data-view="models"][data-credential="${mfluxCredential.id}"]`);
  click(addService);
  fill('name', '测试 MFLUX 生图'); fill('service', 'mflux');
  document.querySelector('[name="service"]').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('[name="baseUrl"]').value, 'http://127.0.0.1:9/v1');
  assert.equal(document.querySelector('[name="maxConcurrency"]').max, '4');
  assert.equal(document.querySelector('[name="maxConcurrency"]').value, '4');
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  submit('#modal-form');
  await modalDone();
  const mflux = app.store.read().connections.find(connection => connection.type === 'mflux');
  assert.equal(mflux.credentialId, mfluxCredential.id);
  assert.deepEqual(serviceSources(), ['测试 MFLUX']);
  manageServices(mfluxCredential.id);
  assert.deepEqual(managedServices(), ['测试 MFLUX 生图']);
  assert.equal(document.querySelector('.service-action-list [data-action="add-model"]'), null);
  click(`.service-action-list [data-action="delete-connection"][data-id="${mflux.id}"]`);
  assert.match(document.querySelector('#dialog .modal-heading').textContent, /此服务及其模型将从网关移除/);
  closeDialog();
  click('[data-view="connections"]');
  assert.ok(connectionNames('local').includes('测试 MFLUX'));
  const mfluxCard = document.querySelector(`[data-action="edit-api-credential"][data-id="${mfluxCredential.id}"]`).closest('li');
  assert.match(mfluxCard.textContent, /已保存服务令牌/);
  click(`[data-action="edit-api-credential"][data-id="${mfluxCredential.id}"]`);
  assert.equal(document.querySelector('#dialog-title').textContent, '编辑连接');
  assert.equal(document.querySelector('[name="clearKey"]'), null);
  closeDialog();

  click(addLocalEndpoint);
  fill('name', '本机语音合成'); fill('baseUrl', 'https://provider.example/v1'); submit('#modal-form');
  await until(() => document.querySelector('#modal-error').textContent.includes('[::1]'));
  assert.equal(app.store.read().apiCredentials.some(item => item.name === '本机语音合成'), false);
  fill('baseUrl', 'http://localhost:7720/v1'); submit('#modal-form');
  await modalDone();
  const voiceEndpoint = app.store.read().apiCredentials.find(item => item.name === '本机语音合成');
  assert.equal(voiceEndpoint.secret, null);
  assert.ok(connectionNames('local').includes(voiceEndpoint.name));

  const ollamaMore = `${providerGroup('ollama')} .provider-more`;
  assert.equal(document.querySelector(ollamaMore).open, false);
  click(`${ollamaMore} summary`);
  assert.equal(document.querySelector(ollamaMore).open, true);
  assert.match(document.querySelector(`${ollamaMore} button`).textContent, /添加其他实例/);
  click(`${ollamaMore} button`);
  assert.equal(document.querySelector(ollamaMore).open, false);
  assert.match(document.querySelector('#dialog-title').textContent, /添加 Ollama/);
  fill('name', '另一个 Ollama'); fill('baseUrl', 'http://127.0.0.1:11435'); submit('#modal-form');
  await modalDone();
  assert.deepEqual(connectionNames('ollama'), ['测试 Ollama', '另一个 Ollama']);

  for (const type of ['ollama', 'codex']) {
    const connections = app.store.read().connections.filter(connection => connection.type === type);
    for (const connection of connections) {
      click(`${providerGroup(type)} [data-action="delete-connection"][data-id="${connection.id}"]`);
      submit('#modal-form');
      await modalDone();
    }
    assert.deepEqual(connectionNames(type), []);
    assert.ok(document.querySelector(directAdd(type)));
    assert.equal(document.querySelector(`${providerGroup(type)} .provider-more`), null);
  }

  // Save and discover these sources out of category order, including an image-first mixed catalog.
  const sortingSources = [
    ['embedding', '排序向量'],
    ['speech', '排序语音合成'],
    ['seedance', '排序视频'],
    ['minimax-image', '排序图片甲'],
    ['transcription', '排序语音识别'],
    ['deepseek', '排序文本'],
    ['seedream', '排序图片乙']
  ];
  const sortingNames = new Map();
  for (const [service, name] of sortingSources) {
    const created = await app.mutate('/admin/connections', 'POST', { type: 'service', service, name, baseUrl: upstream.origin });
    assert.equal(created.status, 200);
    sortingNames.set(created.data.id, name);
    assert.equal((await app.mutate(`/admin/connections/${created.data.id}/discover`, 'POST')).status, 200);
  }
  t.mock.method(app.gateway.providers.codex, 'discover', async () => [
    { nativeId: 'image-first', name: 'Image first', capability: 'image_generation', capabilities: { text: false } },
    { nativeId: 'z-text', name: 'Z text', capabilities: { text: true } },
    { nativeId: 'a-text', name: 'A text', capabilities: { text: true } }
  ]);
  const mixed = await app.mutate('/admin/connections', 'POST', { type: 'codex', name: '排序混合' });
  assert.equal(mixed.status, 200);
  sortingNames.set(mixed.data.id, '排序混合');
  assert.equal((await app.mutate(`/admin/connections/${mixed.data.id}/discover`, 'POST')).status, 200);
  click('[data-action="refresh"]');
  await until(() => document.querySelector('#toast').textContent === '状态已刷新。');
  click('.nav [data-view="models"]');
  const sortedSources = () => {
    const names = [...document.querySelectorAll('.catalog-model')]
      .map(row => sortingNames.get(row.dataset.modelId.split('/')[0])).filter(Boolean);
    return [...new Set(names)];
  };
  const mixedModels = () => [...document.querySelectorAll('.catalog-model')]
    .map(row => row.dataset.modelId).filter(id => id.startsWith(`${mixed.data.id}/`))
    .map(id => id.split('/').at(-1));
  assert.deepEqual(sortedSources(), ['排序文本', '排序混合', '排序图片甲', '排序图片乙', '排序视频', '排序语音识别', '排序语音合成', '排序向量']);
  assert.deepEqual(mixedModels(), ['z-text', 'a-text', 'image-first']);
  for (const [category, names] of [
    ['content_ai', ['排序文本', '排序混合']],
    ['image_generation', ['排序图片甲', '排序图片乙', '排序混合']],
    ['video_generation', ['排序视频']],
    ['media_transcription', ['排序语音识别']],
    ['video_tts', ['排序语音合成']]
  ]) {
    click(`[data-action="catalog-filter"][data-value="${category}"]`);
    assert.deepEqual(sortedSources(), names);
    if (category === 'image_generation') assert.deepEqual(mixedModels(), ['image-first']);
  }

  const mediaModels = Object.fromEntries(['speech', 'transcription', 'embedding', 'minimax-video', 'seedance'].map(service => {
    const connection = app.store.read().connections.find(item => item.service === service);
    return [service, `${connection.id}/${service}`];
  }));
  const extraSpeech = await app.mutate('/admin/connections', 'POST', { type: 'service', service: 'edge-tts', name: '测试 Edge', baseUrl: upstream.origin });
  assert.equal((await app.mutate(`/admin/connections/${extraSpeech.data.id}/discover`, 'POST')).status, 200);
  mediaModels['edge-tts'] = `${extraSpeech.data.id}/edge-tts`;
  for (const id of Object.values(mediaModels)) await app.enable(id);

  const mediaCalls = [], mediaUrls = new Map(), revoked = [];
  win.URL.createObjectURL = blob => {
    const url = `blob:${app.origin}/play-result-${mediaUrls.size + 1}`;
    mediaUrls.set(url, blob);
    return url;
  };
  win.URL.revokeObjectURL = url => revoked.push(url);
  const video = { id: 'video_0123456789abcdef0123456789abcdef', model: mediaModels['minimax-video'] };
  let videoPolls = 0;
  mediaFetch = (path, options) => {
    let result;
    if (path === '/v1/audio/speech') result = new Response('audio-data', { headers: { 'content-type': 'audio/mp3' } });
    if (path === '/v1/audio/transcriptions') result = Response.json({ text: '音频转写测试' });
    if (path === '/v1/embeddings') result = Response.json({ data: [{ embedding: [0.25, 0.5] }] });
    if (path === '/v1/videos') result = Response.json({ ...video, status: 'queued', progress: 0 });
    if (path === `/v1/videos/${video.id}`) {
      videoPolls++;
      result = Response.json({ ...video, status: videoPolls === 1 ? 'in_progress' : 'completed', progress: videoPolls === 1 ? 35 : 100 });
    }
    if (path === `/v1/videos/${video.id}/content`) result = new Response('video-data', { headers: { 'content-type': 'video/mp4' } });
    if (result) mediaCalls.push({ path, options });
    return result && Promise.resolve(result);
  };
  click('[data-view="connections"]');
  const refreshPage = document.querySelector('[data-action="refresh"]');
  refreshPage.click();
  await until(() => refreshPage.isConnected === false);
  click('[data-view="playground"]');
  const choose = (name, value) => {
    const control = document.querySelector(`#play-form [name="${name}"]`);
    control.value = value;
    control.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const status = () => document.querySelector('#response-status').textContent;
  const download = () => document.querySelector('#play-media-download');
  const canSend = () => !document.querySelector('#send-button').disabled;
  choose('endpoint', 'speech');
  assert.deepEqual([...document.querySelector('[name="model"]').options].map(option => option.value), [mediaModels.speech, mediaModels['edge-tts']]);
  choose('model', mediaModels['edge-tts']);
  assert.equal(document.querySelector('[name="voice"]').value, 'zh-CN-XiaoxiaoNeural');
  fill('prompt', '语音合成测试'); submit('#play-form');
  await until(() => document.querySelector('#response-output audio')?.controls && canSend());
  const audioUrl = download().href;
  assert.equal(document.querySelector('audio').src, audioUrl);
  assert.equal(download().download, 'speech.mp3');
  assert.equal(await mediaUrls.get(audioUrl).text(), 'audio-data');
  assert.equal(mediaUrls.get(audioUrl).type, 'audio/mpeg');
  assert.equal(JSON.parse(mediaCalls.at(-1).options.body).model, mediaModels['edge-tts']);
  click('[data-language="en"]');
  assert.equal(download().textContent, 'Download audio');
  assert.equal(download().href, audioUrl);
  click('[data-language="zh-CN"]');

  choose('endpoint', 'transcription');
  assert.ok(revoked.includes(audioUrl));
  assert.equal(document.querySelector('#play-prompt').hidden, true);
  const audioInput = document.querySelector('[name="audio_file"]');
  jsdomUtils.implForWrapper(audioInput).files.push(jsdomUtils.implForWrapper(new win.File(['audio-data'], 'test.wav', { type: 'audio/wav' })));
  fill('audio_language', 'zh'); submit('#play-form');
  await until(() => status() === '已完成' && canSend());
  assert.equal(document.querySelector('#response-output').textContent, '音频转写测试');
  const upload = mediaCalls.at(-1).options;
  assert.equal(upload.body.get('file').name, 'test.wav');
  assert.equal(upload.body.get('language'), 'zh');
  assert.equal(upload.body.get('model'), mediaModels.transcription);
  assert.equal(upload.headers['content-type'], undefined, 'the browser sets the boundary');

  choose('endpoint', 'embeddings');
  fill('prompt', '嵌入测试'); submit('#play-form');
  await until(() => status() === '已完成' && canSend());
  assert.deepEqual(JSON.parse(document.querySelector('#response-output').textContent).data[0].embedding, [0.25, 0.5]);
  assert.equal(JSON.parse(mediaCalls.at(-1).options.body).model, mediaModels.embedding);

  choose('endpoint', 'video');
  const videoModels = document.querySelector('#play-form [name="model"]');
  assert.equal(videoModels.value, mediaModels['minimax-video']);
  assert.equal([...videoModels.options].find(option => option.value === mediaModels.seedance).disabled, true);
  assert.equal(videoModels.selectedOptions[0].textContent, app.store.read().models.find(model => model.id === videoModels.value).name);
  fill('prompt', '湖面的小船'); submit('#play-form');
  await until(() => status() === '排队中');
  assert.equal(document.querySelector('#play-video-id').textContent, video.id);
  assert.equal(document.querySelector('#stop-button').textContent, '停止等待');
  click('#stop-button');
  await until(() => status() === '已停止等待' && canSend());
  assert.equal(document.querySelector('[data-action="resume-video"]').hidden, false);
  click('[data-action="resume-video"]');
  await until(() => status() === '生成中');
  assert.equal(document.querySelector('#play-video-progress').value, 35);
  await until(() => document.querySelector('#response-output video')?.controls && canSend());
  assert.equal(mediaCalls.filter(call => call.path === '/v1/videos').length, 1, 'resuming does not submit a second job');
  const videoUrl = download().href;
  assert.equal(document.querySelector('video').src, videoUrl);
  assert.equal(download().download, `${video.id}.mp4`);
  assert.equal(await mediaUrls.get(videoUrl).text(), 'video-data');
  assert.equal(mediaCalls.at(-1).options.headers.accept, 'video/mp4');
  click('[data-view="connections"]');
  assert.ok(revoked.includes(videoUrl));
});
