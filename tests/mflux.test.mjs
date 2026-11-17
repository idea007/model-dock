import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { setup, until } from './helpers.mjs';

const endpoint = '/v1/images/generations';
const serviceToken = 'synthetic_mflux_service_token_example';
const flux = 'flux2-klein-4b';
const zImage = 'z-image-turbo';

function png(width, height) {
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('MFLUX shares one image service with project-scoped discovery, generation and request isolation', async t => {
  const models = [
    { id: flux, revision: 'a'.repeat(40), status: 'ready', maxReferenceImages: 4, sizes: ['1024x1024', '768x768'] },
    { id: zImage, revision: 'b'.repeat(40), status: 'ready', maxReferenceImages: 0, sizes: ['1024x1024', '768x768'] }
  ];
  let ready = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const upstream = createServer(async (request, response) => {
    const send = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${serviceToken}`) return send(401, { error: 'private message' });
    if (request.url === '/v1/models') return ready
      ? send(200, { provider: 'local-mflux', protocolVersion: 2, status: 'ready', data: models })
      : send(503, {});
    if (request.url !== endpoint) return send(404, {});
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    await gate;
    const [width, height] = body.size.split('x').map(Number);
    return send(200, { model: body.model, data: [{ b64_json: png(width, height) }] });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { release(); upstream.close(); });
  const app = await setup(t);
  const config = { name: 'Shared MFLUX', type: 'mflux', apiKey: serviceToken, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
  for (const body of [{ ...config, baseUrl: 'https://example.com/v1' }, { ...config, apiKey: '' }, { ...config, maxConcurrency: 5 }]) {
    assert.equal((await app.mutate('/admin/connections', 'POST', body)).status, 400);
  }
  const { name, apiKey, baseUrl, type } = config;
  const saved = await app.mutate('/admin/api-credentials', 'POST', { name, apiKey, baseUrl });
  assert.equal(saved.status, 200);
  const credentialId = saved.data.id;
  const keyless = await app.mutate('/admin/api-credentials', 'POST', { name: 'Keyless', baseUrl });
  const rejected = await app.mutate('/admin/connections', 'POST', { name, type, credentialId: keyless.data.id });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error.param, 'apiKey');

  const created = await app.mutate('/admin/connections', 'POST', { name, type, credentialId });
  assert.equal(created.status, 200);
  const connection = created.data.id;
  assert.deepEqual(created.data.state.apiCredentials.find(item => item.id === credentialId).connectionIds, [connection]);
  assert.equal((await app.mutate(`/admin/api-credentials/${credentialId}`, 'PATCH', { apiKey: '' })).status, 400);
  assert.equal((await app.mutate(`/admin/connections/${connection}/discover`, 'POST')).status, 200);
  const fluxId = `${connection}/${flux}`, zId = `${connection}/${zImage}`;
  await app.enable(fluxId);
  await app.enable(zId);
  const codex = await app.connection('codex'), textId = `${codex}/codex-fixture`;
  await app.enable(textId);
  const createKey = async (name, models) => (await app.mutate('/admin/keys', 'POST', { name, models })).data.token;
  const first = await createKey('First app', [fluxId, textId]), second = await createKey('Second app', [zId]);
  const firstCatalog = await app.request('/v1/models', 'GET', undefined, first);
  assert.deepEqual(firstCatalog.data.data.map(model => model.id).sort(), [fluxId, textId].sort());
  const imageModel = firstCatalog.data.data.find(model => model.id === fluxId);
  assert.deepEqual(imageModel.image_sizes, models[0].sizes);
  assert.equal(imageModel.max_reference_images, 4);
  assert.equal(imageModel.model_revision, models[0].revision);
  assert.equal(imageModel.image_operations, undefined);
  assert.equal(app.gateway.hasDedicatedCodexCatalog(app.gateway.authenticate(first)), true);
  assert.equal((await app.request('/v1/models', 'GET', undefined, second)).data.data[0].id, zId);
  const reference = `data:image/png;base64,${png(1, 1)}`;
  const fluxBody = { model: fluxId, prompt: 'Edit the test image', size: '768x768', reference_images: [reference] };
  const zBody = { model: zId, prompt: 'A test image', aspect_ratio: '1:1' };
  assert.equal((await app.request(endpoint, 'POST', fluxBody, second)).status, 403);
  assert.equal((await app.request(endpoint, 'POST', zBody, '')).status, 401);
  for (const [key, body, param] of [
    [first, { ...fluxBody, size: '1536x1024' }, 'size'],
    [first, { ...fluxBody, aspect_ratio: '1:1' }, 'size'],
    [first, { ...fluxBody, background: 'transparent' }, 'background'],
    [first, { ...fluxBody, operation_id: 'a'.repeat(64) }, 'operation_id'],
    [second, { ...zBody, reference_images: [reference] }, 'reference_images']
  ]) {
    const { status, data } = await app.request(endpoint, 'POST', body, key);
    assert.equal(status, 400);
    assert.equal(data.error.param, param);
  }
  assert.equal(calls.length, 0);
  const work = Promise.all([app.request(endpoint, 'POST', fluxBody, first), app.request(endpoint, 'POST', zBody, second)]);
  try {
    await until(() => calls.length === 2);
    assert.ok(calls.some(body => body.model === flux && body.reference_images[0] === reference));
    assert.ok(calls.some(body => body.model === zImage && body.reference_images.length === 0));
  } finally { release(); }
  const [edited, generated] = await work;
  assert.equal(edited.status, 200);
  assert.equal(generated.status, 200);
  assert.equal(edited.data.output_format, 'png');
  assert.equal(edited.data.data[0].width, 768);
  assert.equal(generated.data.data[0].height, 1024);
  ready = false;
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, first)).data.data.map(model => model.id), [textId]);
  assert.deepEqual((await app.request('/v1/models', 'GET', undefined, second)).data.data, []);
  const state = JSON.stringify((await app.request('/admin/state')).data);
  assert.ok(!state.includes(serviceToken) && !state.includes(first) && !state.includes(second));
});
