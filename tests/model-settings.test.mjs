import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setup } from './helpers.mjs';
import { Store } from '../packages/core/store.mjs';

const fixture = () => {
  const calls = [], runtime = { levels: ['low', 'medium', 'high'] };
  return { calls, runtime, providers: { openai: {
    async discover() { return ['alpha', 'beta'].map(nativeId => ({ nativeId, name: nativeId, reasoningEfforts: runtime.levels, defaultEffort: 'medium', contextWindow: 32768, capabilities: { text: true, tools: true, structured: true, privateMetadata: 'must-not-leak' } })); },
    async *generate(connection, request) { calls.push(request); yield { type: 'delta', delta: { content: request.reasoning_effort || 'provider-default' } }; yield { type: 'done', finishReason: 'stop' }; }
  } } };
};
const chat = model => ({ model, messages: [{ role: 'user', content: 'fixture only' }] });

test('server publishes resources atomically, refuses application settings, and scopes safe capability metadata', async t => {
  const data = fixture(), app = await setup(t, data);
  await app.connection('openai', 'http://127.0.0.1:9/v1');
  const models = app.store.read().models.map(model => ({ id: model.id, enabled: true })), revision = app.store.read().revision;
  assert.equal((await app.mutate('/admin/model-settings', 'PATCH', { models })).status, 200);
  const before = app.store.read();
  assert.equal((await app.request('/admin/model-settings', 'PATCH', { models, revision })).status, 409);
  for (const input of [{ models: [{ ...models[0], enabled: false }, { ...models[1], enabled: 'yes' }] }, { models, routes: [] }, { models: models.map(model => ({ ...model, reasoningPolicy: null })) }]) {
    assert.equal((await app.mutate('/admin/model-settings', 'PATCH', input)).status, 400);
    assert.deepEqual(app.store.read(), before, 'failed validation never partially publishes models');
  }
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'only alpha', models: [models[0].id] })).data.token;
  assert.equal((await app.request('/admin/model-settings', 'PATCH', { models, revision: app.store.read().revision }, key)).status, 401);
  const catalog = (await app.request('/v1/models', 'GET', undefined, key)).data;
  assert.equal(catalog.data.length, 1); const entry = catalog.data[0];
  assert.equal(entry.id, models[0].id); assert.deepEqual(entry.reasoning_efforts, ['low', 'medium', 'high']);
  assert.equal(entry.context_window, 32768); assert.equal(entry.source.type, 'openai');
  for (const secret of ['fixture-upstream', 'baseUrl', 'must-not-leak', app.admin, key]) assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat(models[1].id), key)).status, 403);
  assert.equal((await app.mutate('/admin/routes', 'POST', { id: 'feature', modelId: models[0].id })).status, 410);
});

test('legacy aliases and reasoning preferences continue to enforce saved choices without fallback', async t => {
  const data = fixture(), app = await setup(t, data);
  const connection = await app.connection('openai', 'http://127.0.0.1:9/v1');
  const first = app.store.read().models[0].id;
  await app.store.mutate(app.store.read().revision, state => {
    Object.assign(state.models[0], { enabled: true, reasoningPolicy: { allowedEfforts: ['low', 'medium'], defaultEffort: 'medium' }, groupPolicies: { Legacy: { allowedEfforts: ['low'], defaultEffort: 'low' } } });
    state.routes.push({ id: 'chat-default', name: 'Legacy chat', modelId: first, group: 'Legacy' });
  });
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'legacy key', models: ['chat-default'] })).data.token;
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat('chat-default'), key)).data.choices[0].message.content, 'low');
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat(first))).data.choices[0].message.content, 'medium');
  assert.equal((await app.request('/v1/chat/completions', 'POST', { ...chat('chat-default'), reasoning_effort: 'high' }, key)).data.error.code, 'reasoning_effort_disabled');
  assert.equal((await app.request('/v1/models', 'GET', undefined, key)).data.data[0].legacy_alias, true);
  data.runtime.levels = ['high'];
  await app.mutate(`/admin/connections/${connection}/discover`, 'POST');
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat('chat-default'), key)).data.error.code, 'reasoning_policy_unavailable');
  assert.equal(data.calls.length, 2);
});

test('v1 migration backs up configuration and preserves private identity and settings across restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-migration-'));
  let store = await new Store(directory).open();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const token = store.adminToken, key = await fs.readFile(path.join(directory, 'master.key'));
  await store.mutate(0, state => { state.connections.push({ id: 'legacy', secret: store.encrypt('fixture-secret') }); state.models.push({ id: 'legacy/model', enabled: true }); state.routes.push({ id: 'chat', name: 'Chat', modelId: 'legacy/model' }); });
  const legacy = { ...store.read(), schemaVersion: 1 };
  await store.close(); await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(legacy));
  store = await new Store(directory).open();
  assert.equal(store.adminToken, token); assert.deepEqual(await fs.readFile(path.join(directory, 'master.key')), key);
  assert.equal(store.read().schemaVersion, 2); assert.equal(store.read().revision, legacy.revision + 1);
  for (const field of ['connections', 'models', 'routes', 'keys']) assert.deepEqual(store.read()[field], legacy[field]);
  assert.equal(store.decrypt(store.read().connections[0].secret), 'fixture-secret');
  const backups = (await fs.readdir(directory)).filter(name => name.endsWith('.backup.json'));
  assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, backups[0]))), legacy);
  await store.close(); store = await new Store(directory).open();
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.backup.json')).length, 1);
});
