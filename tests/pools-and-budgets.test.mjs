import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGateway } from '../apps/gateway/server.mjs';
import { fixtureUpstream, setup, until } from './helpers.mjs';

const chatEndpoint = '/v1/chat/completions';
const usd = amount => ({ currency: 'USD', amount });
const chat = (model, content = 'hello') => ({ model, messages: [{ role: 'user', content }] });
const invoke = (app, model, token, content) => app.request(chatEndpoint, 'POST', chat(model, content), token);
const stateBudget = (app, id) => app.gateway.snapshot().keys.find(key => key.id === id).budgetUsage;
const budgetFile = app => path.join(app.directory, 'budgets.json');

async function modelFrom(app, upstream, name) {
  const connection = await app.connection('openai', `${upstream.origin}/v1`);
  const model = `${connection}/${name}`;
  await app.enable(model);
  return model;
}

async function createPool(app, modelIds) {
  const response = await app.mutate('/admin/pools', 'POST', { name: 'Shared pool', modelIds, enabled: true });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.id;
}

async function createKey(app, models, budget = null) {
  const response = await app.mutate('/admin/keys', 'POST', { name: 'Fixture project', models, budget });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

test('a scoped pool selects compatible deployments, cools failed connections and never replays a call', async t => {
  let now = Date.now();
  const [first, second] = await Promise.all([
    fixtureUpstream(t, [{ id: 'shared', capabilities: { text: true, tools: false } }]),
    fixtureUpstream(t, [{ id: 'shared', capabilities: { text: true, tools: true } }])
  ]);
  const app = await setup(t, { clock: () => now });
  const a = await modelFrom(app, first, 'shared');
  const b = await modelFrom(app, second, 'shared');
  const duplicate = await modelFrom(app, first, 'shared');
  const bad = await app.mutate('/admin/pools', 'POST', { name: 'Invalid', modelIds: [a, duplicate], enabled: true });
  assert.equal(bad.data.error.code, 'incompatible_pool_members');
  const pool = await createPool(app, [a, b]);
  const key = await createKey(app, [pool]);
  const directKey = await createKey(app, [a]);
  const catalog = await app.request('/v1/models', 'GET', undefined, key.token);
  assert.deepEqual(catalog.data.data.map(row => row.id), [pool]);
  assert.equal(catalog.data.data[0].source.type, 'pool');
  assert.equal(catalog.data.data[0].capabilities.tools, false);
  assert.ok(!JSON.stringify(catalog.data).includes(a));
  assert.equal((await invoke(app, a, key.token)).data.error.code, 'model_forbidden');
  assert.equal((await invoke(app, pool, directKey.token)).data.error.code, 'model_forbidden');

  const tool = await app.request(chatEndpoint, 'POST', { ...chat(pool),
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] }, key.token);
  assert.equal(tool.status, 200);
  assert.equal(tool.data.model, pool);
  assert.deepEqual([first.calls.length, second.calls.length], [0, 1]);

  const failed = await invoke(app, pool, key.token, 'rate-limit-seconds');
  assert.equal(failed.status, 429);
  assert.equal(failed.response.headers.get('retry-after'), '90');
  assert.deepEqual([first.calls.length, second.calls.length], [1, 1]);
  assert.equal((await invoke(app, pool, key.token)).status, 200);
  assert.equal((await invoke(app, pool, key.token, 'rate-limit-seconds')).status, 429);
  const cooling = await invoke(app, pool, key.token);
  assert.equal(cooling.status, 503);
  assert.equal(cooling.data.error.code, 'pool_unavailable');
  assert.equal(cooling.response.headers.get('retry-after'), '90');
  assert.deepEqual([first.calls.length, second.calls.length], [1, 3]);
  assert.equal((await invoke(app, a, directKey.token)).status, 200);
  assert.equal(app.gateway.snapshot().pools[0].members[0].cooldownUntil, now + 90_000);
  now += 90_000;
  assert.equal((await invoke(app, pool, key.token)).status, 200);
  assert.deepEqual([first.calls.length, second.calls.length], [3, 3]);
  const { data } = await app.request(`/admin/usage?project=${key.id}`);
  assert.ok(data.recent.some(row => row.model === pool && row.modelId === a));
  assert.ok(data.recent.some(row => row.model === pool && row.modelId === b));

  const address = `/admin/pools/${pool}`;
  assert.equal((await app.mutate(address, 'PATCH', { name: 'Paused', modelIds: [a, b], enabled: false })).status, 200);
  assert.equal((await invoke(app, pool, key.token)).data.error.code, 'model_unavailable');
  assert.equal((await app.mutate(address, 'DELETE')).status, 200);
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, key.token)).data.data, []);
});

test('selection prefers an idle deployment while a different member has an active stream', async t => {
  const [first, second] = await Promise.all([fixtureUpstream(t), fixtureUpstream(t)]);
  const app = await setup(t);
  const a = await modelFrom(app, first, 'slow');
  const b = await modelFrom(app, second, 'slow');
  const pool = await createPool(app, [a, b]);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = await fetch(`${app.origin}${chatEndpoint}`, {
    method: 'POST', headers: { authorization: `Bearer ${app.admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...chat(a), stream: true }), signal: controller.signal
  });
  assert.equal(running.status, 200);
  assert.equal((await invoke(app, pool)).status, 200);
  assert.equal((await invoke(app, pool)).status, 200);
  assert.deepEqual([first.calls.length, second.calls.length], [1, 2]);
  controller.abort();
});

test('project budget reservations are persisted before dispatch and prevent concurrent overspending', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const sent = [];
  const provider = {
    async discover() { return [{ nativeId: 'shared', name: 'Shared', maxInputTokens: 100, maxOutputTokens: 20 }]; },
    async *generate(connection, body, { signal }) {
      sent.push(body);
      if (body.messages.at(-1).content === 'hold') {
        started.resolve();
        await Promise.race([release.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
        signal.throwIfAborted();
      }
      yield { type: 'delta', delta: { content: 'ok' } };
      if (body.messages.at(-1).content !== 'unknown') yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } };
      yield { type: 'done', finishReason: 'stop' };
    }
  };
  const app = await setup(t, { providers: { openai: provider } });
  const shared = await modelFrom(app, { origin: 'http://127.0.0.1:9000' }, 'shared');
  const key = await createKey(app, [shared], usd(130));
  const price = { currency: 'USD', inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 };
  const beforePrice = await invoke(app, shared, key.token);
  assert.equal(beforePrice.status, 409);
  assert.equal(beforePrice.data.error.code, 'budget_price_required');
  assert.equal(sent.length, 0);
  assert.equal((await app.mutate('/admin/usage/prices', 'PATCH', { modelId: shared, price })).status, 200);

  const pending = [invoke(app, shared, key.token, 'hold'), invoke(app, shared, key.token, 'hold')];
  try {
    await Promise.race([started.promise, Promise.all(pending).then(() => assert.fail('No request reached the provider'))]);
    const stored = JSON.parse(await fs.readFile(budgetFile(app), 'utf8'));
    assert.equal(stored.holds[0].units, 120_000_000);
    assert.equal(stateBudget(app, key.id).reserved, 120);
    const full = await Promise.race(pending);
    assert.equal(full.status, 429);
    assert.equal(full.data.error.code, 'project_budget_exceeded');
    assert.equal(sent.length, 1);
  } finally { release.resolve(); }
  assert.deepEqual((await Promise.all(pending)).map(result => result.status).sort(), [200, 429]);
  await until(() => stateBudget(app, key.id).settled === 12);
  assert.equal(stateBudget(app, key.id).remaining, 118);
  const resumed = await app.request('/v1/responses', 'POST', { model: shared, input: 'unknown', max_output_tokens: 8 }, key.token);
  assert.equal(resumed.status, 200);
  assert.equal(sent.at(-1).max_completion_tokens, 8);
  await until(() => stateBudget(app, key.id).unconfirmed === 108);
  assert.equal(stateBudget(app, key.id).remaining, 10);
  assert.equal((await invoke(app, shared, key.token)).data.error.code, 'project_budget_exceeded');
  assert.equal((await app.request('/admin/usage')).data.recent.find(row => row.id === resumed.data.id).budget.basis, 'reserved');
  if (process.platform !== 'win32') assert.equal((await fs.stat(budgetFile(app))).mode & 0o777, 0o600);

  assert.equal((await app.mutate(`/admin/keys/${key.id}`, 'PATCH', { limits: { requestsPerMinute: 5 } })).status, 200);
  await app.close();
  const restarted = await startGateway({ directory: app.directory, port: 0, providers: { openai: provider } });
  try {
    assert.equal(stateBudget(restarted, key.id).unconfirmed, 108);
    assert.equal(stateBudget(restarted, key.id).settled, 12);
    assert.equal(stateBudget(restarted, key.id).remaining, 10);
  } finally { await restarted.close(); }
});

test('budget recovery accounts for interrupted requests in their original calendar month', async t => {
  let time = new Date(2026, 10, 20).getTime();
  const clock = () => time;
  const app = await setup(t, { clock });
  const key = await createKey(app, ['*'], usd(1));
  await app.gateway.budgets.reserve({ principalId: key.id, currency: 'USD', allowance: 1_000_000, units: 500_000 },
    'interrupted-request', new AbortController().signal);
  await app.close();
  const restarted = await startGateway({ directory: app.directory, port: 0, clock });
  try {
    const scope = restarted.gateway.snapshot().keys[0].budgetUsage;
    assert.deepEqual([scope.period, scope.reserved, scope.unconfirmed, scope.remaining], ['2026-11', 0, 0.5, 0.5]);
    time = new Date(2026, 11, 1).getTime();
    const next = stateBudget(restarted, key.id);
    assert.deepEqual([next.period, next.unconfirmed, next.remaining], ['2026-12', 0, 1]);
  } finally { await restarted.close(); }
});

test('budgeted requests require priced deployments and verified bounds and can select a matching pool member', async t => {
  const [first, second] = await Promise.all([fixtureUpstream(t), fixtureUpstream(t)]);
  const app = await setup(t);
  const a = await modelFrom(app, first, 'shared');
  const b = await modelFrom(app, second, 'shared');
  const pool = await createPool(app, [a, b]);
  const key = await createKey(app, [pool, b], usd(0.0002));
  const setPrice = price => app.mutate('/admin/usage/prices', 'PATCH', { modelId: b, price });
  const price = { currency: 'USD', inputPerMillion: 1.5, outputPerMillion: 1.5 };
  assert.equal((await setPrice({ ...price, currency: 'CNY' })).status, 200);
  assert.equal((await invoke(app, b, key.token)).data.error.code, 'budget_price_required');
  assert.equal((await setPrice(price)).status, 200);
  assert.equal((await invoke(app, b, key.token)).data.error.code, 'budget_token_ceiling_required');
  assert.deepEqual([first.calls.length, second.calls.length], [0, 0]);
  assert.equal((await setPrice({ ...price, maxInputTokens: 100, maxOutputTokens: 33 })).status, 200);
  assert.equal((await invoke(app, pool, key.token)).status, 200);
  await until(() => stateBudget(app, key.id).settled === 0.000018);
  assert.deepEqual([first.calls.length, second.calls.length], [0, 1]);
});

test('a generated image at the budget boundary settles once at its per-image price', async t => {
  let images = 0;
  const provider = {
    async discover() { return [{ nativeId: 'fixture-image', name: 'Image', capability: 'image_generation' }]; },
    async generateImage() {
      images++;
      return { format: 'png', b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxoAAAAASUVORK5CYII=', width: 1, height: 1 };
    }
  };
  const app = await setup(t, { providers: { codex: provider } });
  const connection = await app.connection('codex');
  const model = `${connection}/fixture-image`;
  await app.enable(model);
  const amount = 0.030001;
  const key = await createKey(app, [model], usd(amount));
  assert.equal((await app.mutate('/admin/usage/prices', 'PATCH', { modelId: model, price: { currency: 'USD', perImage: amount } })).status, 200);
  const generate = () => app.request('/v1/images/generations', 'POST', { model, prompt: 'A test image' }, key.token);
  assert.equal((await generate()).status, 200);
  await until(() => stateBudget(app, key.id).settled === amount);
  assert.equal(stateBudget(app, key.id).remaining, 0);
  assert.equal((await generate()).data.error.code, 'project_budget_exceeded');
  assert.equal(images, 1);
});
