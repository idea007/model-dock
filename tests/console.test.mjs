// DOM-level integration only; this does not replace visual browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setup, fixtureUpstream, until } from './helpers.mjs';

test('console: login, connection discovery, model enablement, aliases, scoped key and JSON/SSE playground', async t => {
  const upstream = await fixtureUpstream(t), app = await setup(t);
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
  assert.match(document.querySelector('h1').textContent, /各就各位/);
  click('[data-action="add-connection"][data-type="openai"]');
  fill('name', '测试 API'); fill('baseUrl', `${upstream.origin}/v1`); fill('apiKey', 'fixture-upstream'); submit('#modal-form');
  await modalDone();
  assert.match(document.querySelector('.connection-card').textContent, /测试 API/);
  click('.connection-card [data-action="discover"]');
  await until(() => app.store.read().models.length === 3 && !document.querySelector('.connection-card [data-action="discover"]').disabled);
  click('[data-view="models"]');
  const model = app.store.read().models.find(item => item.nativeId === 'shared');
  click(`[data-action="toggle-model"][data-id="${model.id}"]`);
  await until(() => document.querySelector(`[data-id="${model.id}"]`).getAttribute('aria-checked') === 'true');
  click('[data-action="add-route"]'); fill('name', '聊天'); fill('id', 'chat-default'); fill('modelId', model.id); submit('#modal-form');
  await modalDone();
  click('[data-model-view="functions"]'); assert.match(document.querySelector('#model-list').textContent, /chat-default/);
  click('[data-view="keys"]'); click('[data-action="add-key"]'); fill('name', '测试 demo');
  document.querySelector('[name="models"][value="chat-default"]').checked = true;
  submit('#modal-form');
  await until(() => document.querySelector('#new-token'));
  const key = document.querySelector('#new-token').textContent;
  assert.match(key, /^md_key_/);
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key)).data.data.map(item => item.id), ['chat-default']);
  assert.ok(document.querySelector('#dialog').open, 'new token dialog survives the prior dialog close event');
  submit('#modal-form'); await modalDone();
  click('[data-view="playground"]'); fill('model', 'chat-default'); fill('prompt', '你好'); submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '已完成');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  assert.match(document.querySelector('#response-meta').textContent, /输入 5 \/ 输出 7/);
  await until(() => !document.querySelector('#send-button').disabled);
  document.querySelector('[name="stream"]').checked = false; submit('#play-form');
  await until(() => document.querySelector('#response-status').textContent === '已完成');
  assert.equal(document.querySelector('#response-output').textContent, '你好，来自测试上游。');
  await until(() => !document.querySelector('#send-button').disabled);
});
