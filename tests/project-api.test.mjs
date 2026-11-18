import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureUpstream, setup } from './helpers.mjs';

test('project APIs expand authorized service models and isolate paginated receipts', async t => {
  const app = await setup(t);
  const upstream = await fixtureUpstream(t);
  async function publish(name, service, extra = {}) {
    const connection = await app.mutate('/admin/connections', 'POST', {
      name, type: 'service', service, baseUrl: upstream.origin + '/v1', apiKey: 'fixture-upstream', ...extra
    });
    assert.equal(connection.status, 200);
    const { id } = connection.data;
    assert.equal((await app.mutate(`/admin/connections/${id}/discover`, 'POST')).status, 200);
    const deployment = id + '/' + service;
    await app.enable(deployment);
    return deployment;
  }
  const a = await publish('Text Service', 'deepseek');
  const b = await publish('Other service', 'deepseek', { serviceModels: ['deepseek-exp'] });
  const first = (await app.mutate('/admin/keys', 'POST', { name: 'App A', models: [a] })).data.token;
  const second = (await app.mutate('/admin/keys', 'POST', { name: 'App B', models: [b] })).data.token;
  const get = (path, key) => app.request(path, 'GET', undefined, key);
  const models = await get('/v1/project/models', first);
  assert.equal(models.status, 200);
  assert.deepEqual(models.data.data.map(row => row.native_model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.ok(models.data.data.every(row => row.deployment_id === a && row.credential.name));
  const otherModels = (await get('/v1/project/models', second)).data.data;
  assert.deepEqual(otherModels.map(row => row.native_model), ['deepseek-exp']);
  assert.equal(models.data.data[0].credential.id, otherModels[0].credential.id);
  assert.equal((await get('/v1/project/models', app.admin)).status, 403);
  assert.equal((await get('/v1/project/usage', '')).status, 401);
  assert.equal((await get('/v1/project/usage?project=other', first)).status, 400);
  assert.equal((await get('/admin/usage/analytics', first)).status, 401);
  const send = (key, deployment, suffix) => app.request(
    `/v1/services/${encodeURIComponent(deployment)}/chat/completions`, 'POST',
    { model: 'deepseek-flash', messages: [{ role: 'user', content: 'fixture prompt' }] }, key, {
      'x-model-dock-call-id': 'fixture-call-' + suffix,
      'x-model-dock-operation-id': 'fixture-operation',
      'x-model-dock-feature': 'fixture-feature'
    });
  const receipts = [await send(first, a, 'one'), await send(first, a, 'two'), await send(second, b, 'three')];
  assert.ok(receipts.every(receipt => receipt.status === 200));
  let page;
  for (let attempt = 0; attempt < 50; attempt++) {
    page = await get('/v1/project/usage?linked=1&limit=1', first);
    if (page.data.summary.calls === 2) break;
    await delay(10);
  }
  assert.equal(page.status, 200);
  assert.equal(page.data.summary.calls, 2);
  const tail = await get('/v1/project/usage?' + new URLSearchParams({ ...page.data.next, linked: 1, limit: 1 }), first);
  assert.equal(tail.data.next, null);
  const combined = [...page.data.data, ...tail.data.data];
  assert.deepEqual(new Set(combined.map(row => row.id)), new Set(receipts.slice(0, 2).map(receipt =>
    receipt.response.headers.get('x-model-dock-request-id'))));
  const row = combined.find(row => row.id === receipts[1].response.headers.get('x-model-dock-request-id'));
  assert.equal(row.clientCallId, 'fixture-call-two');
  assert.equal(row.operationId, 'fixture-operation');
  assert.equal(row.metrics.inputTokens, 5);
  assert.doesNotMatch(JSON.stringify([...page.data.data, ...tail.data.data]), /fixture-upstream|fixture prompt|Other service/);
});
