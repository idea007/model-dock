import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startGateway } from '../apps/gateway/server.mjs';
import { UsageLedger, localDay } from '../packages/core/usage.mjs';
import { setup } from './helpers.mjs';

const analyticsPath = '/admin/usage/analytics';
const bills = '/admin/usage/billing';
const chatPath = '/v1/chat/completions';

async function analytics(app, params = {}, want = () => true) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, data } = await app.request(`${analyticsPath}?${new URLSearchParams(params)}`);
    assert.equal(status, 200, JSON.stringify(data));
    if (want(data)) return data;
    await delay(10);
  }
  assert.fail('The usage ledger did not contain the expected completed calls.');
}

test('usage views paginate existing records and share date, project and model filters with CSV', async t => {
  const app = await setup(t);
  const ledger = new UsageLedger(app.directory);
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  for (let index = 0; index < 55; index++) {
    const stamp = new Date(date.valueOf() + index * 1000).toISOString();
    await ledger.record({ id: `chatcmpl_${index.toString(16).padStart(16, '0')}`, startedAt: stamp, finishedAt: stamp,
      projectName: index < 52 ? '=Legacy project' : 'Other project', principalId: index < 52 ? 'key_legacy' : 'key_other',
      model: 'conn_fixture/alpha', modelId: 'conn_fixture/alpha', modelName: 'Alpha', provider: 'openai', connectionName: 'Old source',
      endpoint: 'chat', durationMs: 10, status: 'succeeded', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      images: 0, estimate: { currency: 'USD', amount: .01 } });
  }
  const query = { project: 'key_legacy', model: 'conn_fixture/alpha', dateFrom: localDay(date), dateTo: localDay(date) };
  const first = await analytics(app, query);
  assert.equal(first.summary.calls, 52);
  assert.equal(first.summary.standalone, 52);
  assert.equal(first.summary.legacy, 52);
  assert.equal(first.summary.cacheCount, 0);
  assert.equal(first.summary.totalTokens, 260);
  assert.equal(first.groups.hourly[0].calls, 52);
  assert.equal(first.groups.matrix[0].calls, 52);
  assert.equal(first.rows.length, 50);
  assert.equal(first.pagination.hasMore, true);
  const second = await analytics(app, { ...query, mode: 'calls', offset: '50' });
  assert.equal(second.rows.length, 2);
  assert.equal(second.rows[0].kind, 'legacy');
  assert.equal(second.rows[0].credential.id, 'unknown');
  assert.equal(second.pagination.total, 52);
  const response = await fetch(`${app.origin}/admin/usage/calls.csv?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${app.admin}` } });
  const csv = await response.text();
  assert.equal(csv.trim().split('\r\n').length, 53);
  assert.match(csv, /'=Legacy project/);
  assert.doesNotMatch(csv, /Other project/);
  assert.equal((await app.request(`${analyticsPath}?dateFrom=2026-02-30`)).status, 400);
  assert.equal((await app.request('/admin/usage?days=30')).data.total.requests, 55);
});

test('endpoint statistics classify gateway interfaces while legacy analytics and CSV keep feature data', async t => {
  const app = await setup(t), ledger = new UsageLedger(app.directory);
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  const stamp = at.toISOString();
  const samples = [
    { endpoint: 'chat', audit: { feature: 'outline' } },
    { endpoint: 'responses', audit: { feature: 'outline' } },
    { endpoint: 'service', audit: { feature: 'outline' } },
    { endpoint: 'service', audit: { endpoint: 'speech', feature: 'outline' } }
  ];
  for (const [index, sample] of samples.entries()) {
    await ledger.record({ id: `chatcmpl_${index.toString(16).padStart(16, '0')}`, startedAt: stamp, finishedAt: stamp,
      principalId: 'key_fixture', projectName: 'Editor', operationId: 'task-fixture', modelId: 'conn_fixture/model',
      modelName: 'Fixture', connectionName: 'Fixture source', provider: 'openai', status: 'succeeded', durationMs: 12, ...sample });
  }

  const version = '2';
  const group = await analytics(app, { version });
  const types = ['chat', 'responses', 'service', 'speech'];
  assert.deepEqual(group.options.endpoints.map(row => row.id), types);
  assert.deepEqual(group.groups.endpoints.map(row => [row.key, row.calls]), types.map(type => [type, 1]));
  assert.equal(group.rows[0].endpointCount, 4);
  assert.equal(Object.hasOwn(group.groups, 'matrix'), false);
  assert.equal(Object.hasOwn(group.groups, 'features'), false);
  assert.equal(Object.hasOwn(group.options, 'features'), false);
  assert.equal(Object.hasOwn(group.rows[0].representative, 'feature'), false);
  assert.equal(Object.hasOwn(group.rows[0].representative.audit, 'feature'), false);

  const endpointFilter = { version, mode: 'calls', endpoint: 'speech' };
  const selected = await analytics(app, endpointFilter);
  assert.equal(selected.summary.calls, 1);
  assert.equal(selected.rows[0].endpoint, 'speech');
  assert.equal(selected.cost.pagination.total, 1);
  assert.equal(Object.hasOwn(selected.cost.rows[0].audit, 'feature'), false);

  const legacy = await analytics(app, { feature: 'outline' });
  assert.equal(legacy.rows[0].featureCount, 1);
  assert.equal(legacy.groups.matrix[0].calls, 4);
  assert.equal(legacy.rows[0].representative.feature, 'outline');
  const csv = async params => {
    const response = await fetch(`${app.origin}/admin/usage/calls.csv?${new URLSearchParams(params)}`,
      { headers: { authorization: `Bearer ${app.admin}` } });
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\r\n');
  };
  const oldExport = await csv({ feature: 'outline' });
  const newExport = await csv(endpointFilter);
  assert.equal(oldExport.length, 5);
  assert.equal(newExport.length, 2);
  assert.ok(oldExport.slice(1).every(line => line.includes(',"outline",')));
  assert.match(newExport[1], /,"speech",/);
  assert.doesNotMatch(newExport.join('\n'), /outline|\bfeature\b/);
  assert.equal(newExport[0], oldExport[0].replace(',feature,', ',endpoint,'));
});

async function meteredUpstream(t) {
  let count = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'metered' }] }));
      return;
    }
    for await (const chunk of request) assert.ok(chunk.length);
    const attempt = ++count;
    response.writeHead(attempt === 1 ? 400 : 200, { 'content-type': 'application/json', 'x-request-id': `upstream-${attempt}` });
    response.end(JSON.stringify(attempt === 1 ? { error: 'fixture rejection' } : {
      choices: [{ finish_reason: 'stop', message: { content: 'fixture response', reasoning_content: 'reasoning from provider',
        metadata: { authorization: 'Bearer fixture-upstream' } } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } }
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('provider audits capture dispatched attempts, keep development payloads private and reconcile statements across restart', async t => {
  const upstream = await meteredUpstream(t);
  const app = await setup(t, { developmentDetails: true });
  const connection = await app.connection('openai', upstream), model = `${connection}/metered`;
  await app.enable(model);
  await app.mutate('/admin/usage/prices', 'PATCH', { modelId: model, price: { currency: 'USD', inputPerMillion: 1_000_000, outputPerMillion: 2_000_000 } });
  const key = (await app.mutate('/admin/keys', 'POST', { name: 'Editor', models: [model] })).data;
  const tags = { 'x-model-dock-operation-id': 'job_01', 'x-model-dock-feature': 'outline' };
  const body = { model, messages: [{ role: 'user', content: `fixture prompt fixture-upstream ${key.token} /Users/fixture/private.txt` }] };
  assert.equal((await app.request(chatPath, 'POST', body, key.token, tags)).status, 400);
  const result = await app.request(chatPath, 'POST', body, key.token, { ...tags, 'x-model-dock-attempt': '2' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  const grouped = await analytics(app, { project: key.id, feature: 'outline' }, data => data.summary.calls === 2);
  assert.equal(grouped.summary.operations, 1);
  assert.equal(grouped.summary.failed, 1);
  assert.equal(grouped.summary.retries, 1);
  assert.equal(grouped.summary.cachedTokens, 2);
  assert.equal(grouped.summary.reasoningTokens, 3);
  assert.equal(grouped.rows[0].count, 2);
  const children = await analytics(app, { project: key.id, feature: 'outline', operation: grouped.rows[0].operation, mode: 'calls' });
  const call = children.rows.find(row => row.status === 'succeeded');
  assert.equal(call.kind, 'provider');
  assert.equal(call.audit.providerRequestId, 'upstream-2');
  assert.equal(call.audit.httpStatus, 200);
  assert.equal(call.audit.attempt, 2);
  assert.equal(call.audit.metrics.cachedTokens, 2);
  assert.equal(call.audit.development.status, 'captured');
  const privateUrl = `/admin/usage/development/${call.id}`;
  assert.equal((await app.request(privateUrl, 'GET', undefined, key.token)).status, 401);
  const details = (await app.request(privateUrl)).data.data;
  assert.match(details.input.messages[0].content, /fixture prompt \[redacted\] \[redacted\] \[private path\]/);
  assert.equal(details.reasoning, 'reasoning from provider');
  assert.equal(details.output.choices[0].message.metadata.authorization, '[redacted]');
  const usageFiles = await fs.readdir(`${app.directory}/usage`);
  const raw = await fs.readFile(`${app.directory}/usage/${usageFiles[0]}`, 'utf8');
  assert.doesNotMatch(raw, /fixture prompt|fixture response|fixture-upstream|reasoning from provider/);
  assert.ok(!raw.includes(key.token));
  const rawFiles = await fs.readdir(`${app.directory}/usage-development`);
  assert.equal((await fs.stat(`${app.directory}/usage-development/${rawFiles[0]}`)).mode & 0o777, 0o600);

  const scope = { provider: call.provider, credential: call.credential.id, dateFrom: call.day, dateTo: call.day };
  const csv = 'statement_reference,provider_request_id,currency,amount\r\nreference-1,upstream-2,USD,19\r\nunrelated,missing,USD,0.01\r\n';
  assert.equal((await app.request(`${bills}/preview`, 'POST', { ...scope, csv }, key.token)).status, 401);
  const preview = await app.request(`${bills}/preview`, 'POST', { ...scope, csv });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.summary.matched, 1);
  assert.equal(preview.data.summary.unmatched, 1);
  const importBody = { ...scope, csv, previewHash: preview.data.previewHash };
  const imported = await Promise.all([app.request(`${bills}/import`, 'POST', importBody), app.request(`${bills}/import`, 'POST', importBody)]);
  assert.deepEqual(imported.map(row => row.status), [200, 200]);
  assert.deepEqual(imported.map(row => row.data.created).sort(), [false, true]);
  const correction = await app.request(`${bills}/reconcile`, 'POST', { callId: call.id, reference: 'correction-1', currency: 'USD', amount: '20' });
  assert.equal(correction.data.entry.status, 'mismatch');
  const after = await analytics(app);
  assert.equal(after.cost.reconciled.count, 1);
  assert.equal(after.cost.reconciled.mismatches, 1);
  assert.equal(after.cost.reconciled.amounts.USD.maximum, 20);

  await app.close();
  const restarted = await startGateway({ directory: app.directory, port: 0, developmentDetails: false });
  try {
    const headers = { authorization: `Bearer ${app.admin}` };
    const history = await (await fetch(`${restarted.origin}${bills}/calls/${call.id}`, { headers })).json();
    assert.deepEqual(history.entries.map(entry => entry.amount), [20, 19]);
    const imports = await (await fetch(`${restarted.origin}${bills}`, { headers })).json();
    assert.equal(imports.imports.length, 1);
    assert.equal((await fetch(`${restarted.origin}${privateUrl}`, { headers })).status, 404);
  } finally { await restarted.close(); }
});
