// DOM-level integration only; this does not replace visual browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { GatewayError } from '../packages/protocol/index.mjs';
import { setup, fixtureUpstream, until } from './helpers.mjs';

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
  const globals = { window: win, document, location: win.location, history: win.history, sessionStorage: win.sessionStorage,
    FormData: win.FormData, navigator: { clipboard: { writeText: async () => {} } },
    fetch: (url, options) => nativeFetch(new URL(url, app.origin), options) };
  for (const [key, value] of Object.entries(globals)) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  let module;
  t.after(() => {
    module?.dispose(); dom.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const source = (await fs.readFile(new URL('../apps/console/app.mjs', import.meta.url), 'utf8')).replace("'./events.mjs'", JSON.stringify(new URL('../packages/protocol/events.mjs', import.meta.url).href));
  module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const click = selector => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); };
  const fill = (name, value) => { const field = document.querySelector(`[name="${name}"]`); assert.ok(field, name); field.value = value; };
  const submit = selector => {
    const form = document.querySelector(selector); assert.ok(form, selector);
    form.dispatchEvent(new win.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button[type=submit],button.primary') }));
  };
  const modalDone = () => until(() => !document.querySelector('#dialog').open);
  fill('token', 'incorrect'); submit('#login-form');
  await until(() => document.querySelector('#login-form .form-error')?.textContent.includes('valid access token'));
  fill('token', app.admin); submit('#login-form');
  await until(() => document.querySelector('.shell'));
  assert.match(document.querySelector('h1').textContent, /模型服务/);
  click('[data-action="add-connection"][data-type="openai"]');
  fill('name', '测试 API'); fill('baseUrl', `${upstream.origin}/v1`); fill('apiKey', 'fixture-upstream'); submit('#modal-form');
  await modalDone();
  assert.match(document.querySelector('.connection-card').textContent, /测试 API/);
  click('.connection-card [data-action="discover"]');
  await until(() => app.store.read().models.length === 3 && !document.querySelector('.connection-card [data-action="discover"]').disabled);
  click('[data-view="models"]');
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
  click('[data-view="playground"]'); fill('model', model.id); fill('prompt', '你好'); submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '已完成');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  assert.match(document.querySelector('#response-meta').textContent, /输入 5 \/ 输出 7/);
  assert.equal(upstream.calls.at(-1).body.reasoning_effort, 'low');
  await until(() => !document.querySelector('#send-button').disabled);
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
});
