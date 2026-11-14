// DOM-level integration only; this does not replace visual browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
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
    reasoning_efforts: ['none', 'low', 'high', 'max'], default_reasoning_effort: 'high', capabilities: { text: true, thinking: true }
  }, { id: 'slow' }, { id: 'broken' }]), app = await setup(t);
  const html = await fs.readFile(new URL('../apps/console/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: app.origin });
  const win = dom.window, document = win.document;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; queueMicrotask(() => this.dispatchEvent(new win.Event('close'))); };
  const descriptors = new Map(), nativeFetch = globalThis.fetch;
  let clipboard;
  const globals = { window: win, document, location: win.location, history: win.history, sessionStorage: win.sessionStorage, localStorage: win.localStorage,
    FormData: win.FormData, navigator: { clipboard: { writeText: async text => { clipboard = text; } } },
    fetch: (url, options) => nativeFetch(new URL(url, app.origin), options) };
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
  const directAdd = type => `${providerGroup(type)} .provider-actions > [data-action="add-connection"]`;
  const connectionNames = type => [...document.querySelectorAll(`${providerGroup(type)} .connection-card h4`)].map(heading => heading.textContent);
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
  assert.deepEqual([...document.querySelectorAll('.nav button')].map(button => button.textContent), ['连接与凭证', '模型与服务', '接口文档', '调用测试', '项目访问']);
  assert.ok(document.querySelector('.page > section').classList.contains('connections-endpoint'));
  assert.equal(document.querySelector('.stats'), null);
  assert.deepEqual([...document.querySelectorAll('.provider-group h3')].map(heading => heading.textContent), ['模型 API', 'Ollama', 'Codex']);
  assert.equal(document.querySelectorAll('.provider-empty').length, 3);
  for (const type of ['openai', 'ollama', 'codex']) assert.ok(document.querySelector(directAdd(type)));
  click('.connections-endpoint [data-action="copy-endpoint"]');
  assert.equal(clipboard, `${app.origin}/v1`);
  click('.nav [data-view="api"]');
  assert.equal(document.querySelector('a[href="/openapi.json"]').getAttribute('download'), 'model-dock.openapi.json');
  assert.equal(win.location.search, '?view=api');
  assert.equal(document.querySelector('h1').textContent, '接口文档');
  assert.equal(document.querySelectorAll('.api-endpoint').length, 5);
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
  click('[data-action="add-connection"][data-type="openai"]');
  fill('name', '测试 API'); fill('baseUrl', `${upstream.origin}/v1`); fill('apiKey', 'fixture-upstream'); submit('#modal-form');
  await modalDone();
  assert.deepEqual(connectionNames('openai'), ['测试 API']);
  click('.connection-card [data-action="discover"]');
  await until(() => app.store.read().models.length === 3 && !document.querySelector('.connection-card [data-action="discover"]').disabled);
  click('.section-header [data-view="models"]');
  assert.match(document.querySelector('h1').textContent, /模型与服务/);
  assert.equal(document.querySelectorAll('.catalog-group').length, 1);
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
  const effort = `${row} .catalog-level[data-level="none"]`;
  const pin = `${row} [data-action="pin-model-effort"][data-level="low"]`;
  const publish = `[data-action="publish-model"][data-id="${model.id}"]`;
  assert.match(document.querySelector(`${row} .catalog-limits`).textContent.replace(/\s+/g, ' '), /最大输入 1M · 最大输出 384K tokens/);
  assert.equal(document.querySelector(effort).disabled, true);
  click(publish);
  assert.equal(document.querySelector(publish).getAttribute('aria-checked'), 'true');
  assert.equal(app.store.read().models.find(row => row.id === model.id).enabled, false, 'publication changes wait for save');
  click(effort); click(pin);
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector(pin).getAttribute('aria-pressed'), 'true');
  assert.equal(app.store.read().models.find(row => row.id === model.id).reasoningPolicy, undefined, 'reasoning changes wait for save');
  click('[data-language="en"]');
  assert.equal(document.querySelector(publish).getAttribute('aria-checked'), 'true');
  assert.equal(document.querySelector(effort).getAttribute('aria-pressed'), 'false');
  assert.match(document.querySelector('[data-action="save-publication"]').textContent, /Save changes/);
  click('[data-language="zh-CN"]');
  assert.match(document.querySelector('.catalog-runtime').textContent, /API 连接正常/);
  const check = '[data-action="check-connection"]';
  const refresh = '[data-action="refresh-catalog"]';
  const provider = app.gateway.providers.openai;
  const pendingCheck = Promise.withResolvers();
  let checks = 0, inferenceDenied = false;
  app.gateway.providers.openai = {
    ...provider,
    async discover(...args) {
      checks++;
      if (checks === 1) {
        await pendingCheck.promise;
        throw new GatewayError('Fixture rejected the catalog request.', 502, 'upstream_auth_failed');
      }
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
  assert.match(document.querySelector('.catalog-runtime-error').textContent, /API 密钥/);
  assert.equal(document.querySelectorAll('.catalog-model').length, 3, 'a failed check keeps the catalog');
  assert.equal(document.querySelector('[data-action="save-publication"]').disabled, false);
  assert.match(document.querySelector(refresh).textContent, /保留修改/);
  click(refresh);
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
  assert.deepEqual(app.store.read().models.find(row => row.id === model.id).reasoningPolicy, { allowedEfforts: ['low', 'high', 'max'], defaultEffort: 'low' });
  click('[data-view="keys"]'); click('[data-action="add-key"]'); fill('name', '测试 demo');
  document.querySelector(`[name="models"][value="${model.id}"]`).checked = true;
  submit('#modal-form');
  await until(() => document.querySelector('#new-token'));
  const key = document.querySelector('#new-token').textContent;
  assert.match(key, /^md_key_/);
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key)).data.data.map(item => item.id), [model.id]);
  assert.ok(document.querySelector('#dialog').open, 'new token dialog survives the prior dialog close event');
  submit('#modal-form'); await modalDone();
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

  const storedConnections = [
    { type: 'ollama', name: '测试 Ollama', enabled: false },
    { type: 'codex', name: '测试 Codex' },
    { type: 'openai', name: '第二个 API', baseUrl: `${upstream.origin}/v1` }
  ];
  for (const connection of storedConnections) {
    const result = await app.mutate('/admin/connections', 'POST', connection);
    assert.equal(result.status, 200);
  }
  click('[data-view="connections"]'); click('[data-action="refresh"]');
  await until(() => connectionNames('codex').length === 1);
  assert.deepEqual(connectionNames('openai'), ['测试 API', '第二个 API']);
  assert.deepEqual(connectionNames('ollama'), ['测试 Ollama']);
  assert.deepEqual(connectionNames('codex'), ['测试 Codex']);
  assert.match(document.querySelector(`${providerGroup('ollama')} .connection-card`).textContent, /已停用/);
  assert.ok(document.querySelector(directAdd('openai')));
  assert.equal(document.querySelector(directAdd('ollama')), null);
  assert.equal(document.querySelector(`${providerGroup('codex')} [data-action="add-connection"]`), null);

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
});
