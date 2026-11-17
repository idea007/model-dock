import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setup } from './helpers.mjs';
import { Store } from '../packages/core/store.mjs';
import { SCHEMA_VERSION } from '../packages/protocol/index.mjs';

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
  for (const input of [
    { models: [{ ...models[0], enabled: false }, { ...models[1], enabled: 'yes' }] },
    { models, routes: [] },
    { models: [models[0], { ...models[1], groupPolicies: {} }] },
    { models: [{ ...models[0], enabled: false }, { ...models[1], reasoningPolicy: { allowedEfforts: ['high'], defaultEffort: 'low' } }] },
    { models: [models[0], { ...models[1], reasoningPolicy: { openEfforts: ['low', 'high'], allowedEfforts: ['medium', 'high'], defaultEffort: 'high' } }] }
  ]) {
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

test('server model reasoning settings constrain the authorized catalog and new calls until reset', async t => {
  const app = await setup(t, fixture());
  const connection = await app.connection('openai', 'http://127.0.0.1:9/v1');
  const models = app.store.read().models.map(model => ({ id: model.id, enabled: true }));
  const [alpha, beta] = models;
  const reasoningPolicy = { openEfforts: ['low', 'medium', 'high'], allowedEfforts: ['low', 'high'], defaultEffort: 'high' };
  assert.equal((await app.mutate('/admin/model-settings', 'PATCH', { models: [{ ...alpha, reasoningPolicy }, beta] })).status, 200);
  await app.mutate(`/admin/connections/${connection}/discover`, 'POST');
  assert.equal((await app.mutate('/admin/model-settings', 'PATCH', { models })).status, 200);
  assert.deepEqual(app.store.read().models[0].reasoningPolicy, reasoningPolicy, 'refresh and enable-only writes preserve policy');
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'only alpha', models: [alpha.id] })).data.token;
  const [entry] = (await app.request('/v1/models', 'GET', undefined, key)).data.data;
  assert.deepEqual(entry.reasoning_efforts, ['low', 'high']);
  assert.equal(entry.default_reasoning_effort, 'high');
  const invoke = effort => app.request('/v1/chat/completions', 'POST', { ...chat(alpha.id), ...(effort ? { reasoning_effort: effort } : {}) }, key);
  assert.equal((await invoke()).data.choices[0].message.content, 'high');
  assert.equal((await invoke('low')).data.choices[0].message.content, 'low');
  assert.equal((await invoke('medium')).data.error.code, 'reasoning_effort_disabled');
  assert.equal((await app.mutate('/admin/model-settings', 'PATCH', { models: [{ ...alpha, reasoningPolicy: null }, beta] })).status, 200);
  assert.equal((await invoke()).data.choices[0].message.content, 'provider-default');
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
  const narrowerSelection = app.store.read().models.map(({ id, enabled }) => ({ id, enabled }));
  narrowerSelection[0].reasoningPolicy = { openEfforts: ['low', 'medium'], allowedEfforts: ['medium'], defaultEffort: 'medium' };
  assert.equal((await app.mutate('/admin/model-settings', 'PATCH', { models: narrowerSelection })).status, 200);
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat('chat-default'), key)).data.choices[0].message.content, 'low');
  assert.equal((await app.request('/v1/chat/completions', 'POST', { ...chat(first), reasoning_effort: 'low' })).data.error.code, 'reasoning_effort_disabled');
  const before = app.store.read();
  const models = before.models.map(({ id, enabled }) => ({ id, enabled }));
  models[0].reasoningPolicy = { allowedEfforts: ['medium', 'high'], defaultEffort: 'medium' };
  const conflict = await app.mutate('/admin/model-settings', 'PATCH', { models });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'reasoning_policy_conflict');
  assert.deepEqual(app.store.read(), before);
  data.runtime.levels = ['high'];
  await app.mutate(`/admin/connections/${connection}/discover`, 'POST');
  assert.equal((await app.request('/v1/chat/completions', 'POST', chat('chat-default'), key)).data.error.code, 'reasoning_policy_unavailable');
  assert.equal(data.calls.length, 3);
});

test('v1 migration backs up configuration and preserves private identity and settings across restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-migration-'));
  let store = await new Store(directory).open();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const token = store.adminToken, key = await fs.readFile(path.join(directory, 'master.key'));
  await store.mutate(0, state => { state.connections.push({ id: 'legacy', secret: store.encrypt('fixture-secret') }); state.models.push({ id: 'legacy/model', enabled: true }); state.routes.push({ id: 'chat', name: 'Chat', modelId: 'legacy/model' }); });
  const legacy = { ...store.read(), schemaVersion: 1 };
  delete legacy.apiCredentials;
  await store.close(); await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(legacy));
  store = await new Store(directory).open();
  assert.equal(store.adminToken, token); assert.deepEqual(await fs.readFile(path.join(directory, 'master.key')), key);
  assert.equal(store.read().schemaVersion, SCHEMA_VERSION); assert.equal(store.read().revision, legacy.revision + 1);
  assert.deepEqual(store.read().apiCredentials, []);
  for (const field of ['connections', 'models', 'routes', 'keys']) assert.deepEqual(store.read()[field], legacy[field]);
  assert.equal(store.decrypt(store.read().connections[0].secret), 'fixture-secret');
  const backups = (await fs.readdir(directory)).filter(name => name.endsWith('.backup.json'));
  assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, backups[0]))), legacy);
  await store.close(); store = await new Store(directory).open();
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.backup.json')).length, 1);
});

test('v2 migration links legacy service rows to one saved credential without changing deployments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-api-credential-migration-'));
  let store = await new Store(directory).open();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const origin = 'https://provider.example';
  const connections = [
    { id: 'legacy-text', type: 'service', name: 'Text', service: 'minimax-chat', baseUrl: origin + '/v1' },
    { id: 'legacy-image', type: 'service', name: 'Images', service: 'minimax-image', baseUrl: origin }
  ];
  const models = connections.map(connection => ({ id: `${connection.id}/${connection.service}`, connectionId: connection.id, enabled: true }));
  const legacy = {
    schemaVersion: 2, revision: 8, models, routes: [],
    keys: [{ id: 'project', models: models.map(model => model.id) }],
    connections: connections.map(connection => ({ ...connection, secret: store.encrypt('shared-fixture') }))
  };
  await store.close();
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(legacy));
  store = await new Store(directory).open();
  const migrated = store.read();
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.revision, legacy.revision + 1);
  assert.deepEqual(migrated.connections, connections.map(connection => ({ ...connection, credentialId: 'legacy-text' })));
  assert.deepEqual(migrated.models, legacy.models);
  assert.deepEqual(migrated.keys, legacy.keys);
  assert.deepEqual(migrated.apiCredentials, [{ id: 'legacy-text', name: 'MiniMax', baseUrl: origin + '/v1', secret: legacy.connections[0].secret }]);
  assert.equal(store.decrypt(store.connectionKey(migrated.connections[1])), 'shared-fixture');
  const backup = (await fs.readdir(directory)).find(name => name.startsWith('state.v2.') && name.endsWith('.backup.json'));
  assert.ok(backup);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, backup))), legacy);
  await store.close();
  store = await new Store(directory).open();
  assert.deepEqual(store.read(), migrated);
});

test('v3 migration moves MFLUX keys into the API credential store and preserves existing grants', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-mflux-migration-'));
  let store = await new Store(directory).open();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:8016';
  const sharedKey = 'synthetic_mflux_service_token_example';
  const separateKey = 'another_synthetic_mflux_service_token';
  const saved = { id: 'saved-credential', name: 'Already saved', baseUrl: origin, secret: store.encrypt(sharedKey) };
  const sources = [
    { id: 'reused-service', type: 'mflux', name: 'Reuse MFLUX', baseUrl: origin + '/v1' },
    { id: 'independent-service', type: 'mflux', name: 'Other MFLUX', baseUrl: origin + '/v1' }
  ];
  const models = sources.map(({ id }) => ({ id: `${id}/image-model`, connectionId: id, enabled: true }));
  const legacy = { ...store.read(), schemaVersion: 3, apiCredentials: [saved],
    connections: sources.map((source, index) => ({ ...source, secret: store.encrypt(index === 0 ? sharedKey : separateKey) })),
    models, keys: [{ id: 'app', models: models.map(model => model.id) }] };
  await store.close();
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(legacy));
  store = await new Store(directory).open();
  const migrated = store.read();
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.revision, legacy.revision + 1);
  assert.deepEqual(migrated.connections, [
    { ...sources[0], credentialId: saved.id }, { ...sources[1], credentialId: sources[1].id }
  ]);
  assert.deepEqual(migrated.apiCredentials, [saved, {
    id: sources[1].id, name: sources[1].name, baseUrl: sources[1].baseUrl, secret: legacy.connections[1].secret
  }]);
  assert.deepEqual(migrated.models, models);
  assert.deepEqual(migrated.keys, legacy.keys);
  const backup = (await fs.readdir(directory)).find(name => name.startsWith('state.v3.') && name.endsWith('.backup.json'));
  assert.ok(backup);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, backup))), legacy);
  await store.close();
  store = await new Store(directory).open();
  assert.deepEqual(store.read(), migrated);
});
