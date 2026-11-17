import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import OpenAI, { toFile } from 'openai';
import { startGateway } from '../apps/gateway/server.mjs';
import { setup } from './helpers.mjs';

async function publishService(app, baseUrl, service, options) {
  const created = await app.mutate('/admin/connections', 'POST', { type: 'service', service, name: service, baseUrl, ...options });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const { id } = created.data;
  assert.equal((await app.mutate(`/admin/connections/${id}/discover`, 'POST')).status, 200);
  const deployment = `${id}/${service}`;
  await app.enable(deployment);
  return deployment;
}

async function mediaFixture(t, handle) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = { path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    const result = await handle(call);
    if (!result) { response.writeHead(404); response.end(); return; }
    if (result.binary) { response.writeHead(200, { 'content-type': result.type }); response.end(result.binary); return; }
    response.writeHead(result.code ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(result.value));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, origin: `http://127.0.0.1:${server.address().port}` };
}

test('API credentials group equal keys on the same origin and rotate linked sources atomically', async t => {
  const app = await setup(t);
  const origin = 'https://provider.example';
  const key = 'shared-fixture-token';
  const otherKey = 'separate-fixture-token';
  const rotated = 'rotated-fixture-token';
  const credentialInput = { name: 'MiniMax', baseUrl: origin + '/v1', apiKey: key };
  const created = await app.mutate('/admin/api-credentials', 'POST', credentialInput);
  assert.equal(created.status, 200);
  const credentialId = created.data.id;
  assert.deepEqual(created.data.state.apiCredentials, [{ id: credentialId, name: 'MiniMax', baseUrl: origin + '/v1',
    origin, connectionIds: [], hasKey: true }]);
  assert.deepEqual(created.data.state.connections, []);
  const duplicate = await app.mutate('/admin/api-credentials', 'POST', { ...credentialInput, baseUrl: origin });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'duplicate_api_credential');
  async function addConnection(fields) {
    const { status, data } = await app.mutate('/admin/connections', 'POST', fields);
    assert.equal(status, 200);
    return data.id;
  }
  const chat = await addConnection({ type: 'service', service: 'minimax-chat', name: 'Chat', credentialId });
  const image = await addConnection({ type: 'service', service: 'minimax-image', name: 'Image', apiKey: key, baseUrl: origin });
  const separate = await addConnection({ type: 'openai', name: 'Separate key', apiKey: otherKey, baseUrl: origin + '/v1' });
  const foreign = await addConnection({ type: 'openai', name: 'Other origin', apiKey: key, baseUrl: 'https://other.example/v1' });
  const keyless = await addConnection({ type: 'service', service: 'speech', name: 'Keyless', baseUrl: origin });
  const otherKeyless = await addConnection({ type: 'service', service: 'embedding', name: 'Other keyless', baseUrl: origin });
  async function snapshot() {
    const { status, data } = await app.request('/admin/state');
    assert.equal(status, 200);
    for (const secret of [key, otherKey, rotated]) assert.ok(!JSON.stringify(data).includes(secret));
    return data;
  }
  const credentials = (await snapshot()).apiCredentials;
  assert.equal(credentials[0].id, credentialId);
  assert.deepEqual(credentials.map(({ origin, connectionIds, hasKey }) => ({ origin, connectionIds, hasKey })), [
    { origin, connectionIds: [chat, image], hasKey: true },
    { origin, connectionIds: [separate], hasKey: true },
    { origin: 'https://other.example', connectionIds: [foreign], hasKey: true },
    { origin, connectionIds: [keyless], hasKey: false },
    { origin, connectionIds: [otherKeyless], hasKey: false }
  ]);
  const endpoint = `/admin/api-credentials/${credentialId}`;
  assert.equal((await app.mutate(endpoint, 'DELETE')).data.error.code, 'credential_in_use');
  assert.equal((await app.mutate(endpoint, 'PATCH', { baseUrl: 'https://other.example', apiKey: rotated })).data.error.code, 'credential_in_use');
  assert.equal((await app.mutate(`/admin/connections/${chat}/discover`, 'POST')).status, 200);
  const deployment = `${chat}/minimax-chat`;
  await app.enable(deployment);
  const { data: project } = await app.mutate('/admin/keys', 'POST', { name: 'Scoped project', models: [deployment] });
  const before = app.store.read();
  assert.equal((await app.request(endpoint, 'PATCH', { revision: before.revision, apiKey: rotated }, project.token)).status, 401);
  assert.equal((await app.mutate(endpoint, 'PATCH', { apiKey: rotated })).status, 200);
  const after = app.store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.models, before.models);
  assert.deepEqual(after.keys, before.keys);
  assert.deepEqual(after.connections.map(connection => [connection.id, app.store.decrypt(app.store.connectionKey(connection, after))]), [
    [chat, rotated], [image, rotated], [separate, otherKey], [foreign, key], [keyless, ''], [otherKeyless, '']
  ]);
  const authorized = await app.request('/v1/models', 'GET', undefined, project.token);
  assert.deepEqual(authorized.data.data.map(model => model.id), [deployment]);

  const reuse = { type: 'service', service: 'minimax-speech', name: 'Speech', credentialId };
  const denied = await app.mutate('/admin/connections', 'POST', { ...reuse, baseUrl: 'https://other.example' });
  assert.equal(denied.status, 400);
  assert.equal(denied.data.error.code, 'credential_origin_mismatch');
  const speech = await addConnection({ ...reuse, baseUrl: origin });
  assert.deepEqual((await snapshot()).apiCredentials[0].connectionIds, [chat, image, speech]);
  for (const id of [chat, image, speech]) assert.equal((await app.mutate(`/admin/connections/${id}`, 'DELETE')).status, 200);
  assert.deepEqual((await snapshot()).apiCredentials[0].connectionIds, []);
  assert.equal((await app.mutate(endpoint, 'DELETE')).status, 200);
});

test('the SDK routes speech, multipart transcription and embeddings by the published ID', async t => {
  const audio = Buffer.from('fixture audio bytes');
  let catalogIds = ['speaker-v1'];
  const fixture = await mediaFixture(t, async call => {
    switch (call.path) {
      case '/tts/models': return { value: { data: catalogIds.map(id => ({ id })) } };
      case '/tts/audio/speech': return { binary: audio, type: 'audio/mpeg' };
      case '/minimax/v1/t2a_v2': return { value: { data: { audio: audio.toString('hex') }, base_resp: { status_code: 0 } } };
      case '/edge/audio/speech-with-timestamps': return { value: { audio: audio.toString('base64'), words: [] } };
      case '/stt/audio/transcriptions': return { value: { text: 'fixture transcript' } };
      case '/vectors/embeddings': return { value: { object: 'list', model: 'embedding-v1', data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }], usage: { prompt_tokens: 1, total_tokens: 1 } } };
    }
  });
  const app = await setup(t);
  const apiKey = 'fixture-key';
  const speech = await publishService(app, `${fixture.origin}/tts`, 'speech', { apiKey });
  const minimax = await publishService(app, `${fixture.origin}/minimax`, 'minimax-speech', { apiKey });
  const edge = await publishService(app, `${fixture.origin}/edge`, 'edge-tts', { apiKey });
  const transcription = await publishService(app, `${fixture.origin}/stt`, 'transcription', { upstreamModel: 'whisper-fixture', apiKey });
  const embedding = await publishService(app, `${fixture.origin}/vectors`, 'embedding', { upstreamModel: 'embedding-v1', apiKey });
  const { data } = await app.mutate('/admin/keys', 'POST', { name: 'Media', models: [speech, minimax, edge, transcription, embedding] });
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: data.token, maxRetries: 0 });
  for (const [model, voice] of [[speech, 'provider-voice'], [minimax, 'male-qn-qingse'], [edge, 'zh-CN-XiaoxiaoNeural']]) {
    const result = await client.audio.speech.create({ model, input: '你好', voice, response_format: 'mp3' });
    assert.equal(result.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), audio);
  }
  assert.equal(JSON.parse(fixture.calls[1].body).model, 'speaker-v1');
  assert.equal(JSON.parse(fixture.calls[2].body).model, 'speech-2.8-hd');
  assert.deepEqual(JSON.parse(fixture.calls[3].body), { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', speed: 1 });
  const file = await toFile(audio, 'speech.mp3', { type: 'audio/mpeg' });
  const transcript = await client.audio.transcriptions.create({ file, model: transcription, language: 'zh', response_format: 'json' });
  assert.equal(transcript.text, 'fixture transcript');
  const upload = fixture.calls.at(-1);
  const form = await new Response(upload.body, { headers: { 'content-type': upload.headers['content-type'] } }).formData();
  assert.equal(form.get('model'), 'whisper-fixture');
  assert.equal(form.get('language'), 'zh');
  assert.equal(form.get('file').name, 'speech.mp3');
  assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), audio);
  const vectors = await client.embeddings.create({ model: embedding, input: ['Model Dock'], encoding_format: 'float' });
  assert.deepEqual(vectors.data[0].embedding, [0.25, -0.5]);
  assert.equal(JSON.parse(fixture.calls.at(-1).body).model, 'embedding-v1');
  assert.ok(fixture.calls.every(call => call.headers.authorization === `Bearer ${apiKey}` && !call.headers['x-model-dock-service']));

  const denied = (await app.mutate('/admin/keys', 'POST', { name: 'Embeddings only', models: [embedding] })).data.token;
  const before = fixture.calls.length;
  const forbidden = await app.request('/v1/audio/speech', 'POST', { model: speech, input: 'Test', voice: 'provider-voice' }, denied);
  assert.equal(forbidden.status, 403);
  assert.equal(fixture.calls.length, before);
  catalogIds = ['speaker-v1', 'speaker-v2'];
  const ambiguous = await app.request('/v1/audio/speech', 'POST', { model: speech, input: 'Test', voice: 'provider-voice' }, data.token);
  assert.equal(ambiguous.data.error.code, 'upstream_model_required');
  const binding = await app.mutate(`/admin/connections/${speech.split('/')[0]}`, 'PATCH', { upstreamModel: 'speaker-v2' });
  assert.equal(binding.status, 200);
  await (await client.audio.speech.create({ model: speech, input: 'Test', voice: 'provider-voice' })).arrayBuffer();
  assert.equal(JSON.parse(fixture.calls.at(-1).body).model, 'speaker-v2');
});

test('standard video jobs use the SDK, scope downloads and retain LTX receipts across restart', async t => {
  const mp4 = Buffer.from('fixture mp4');
  let localStatus = 'queued';
  let seedanceUrl = 'https://example.tos-cn-beijing.volces.com/video.mp4';
  const fixture = await mediaFixture(t, async call => {
    switch (call.path) {
      case '/ltx/models': return { value: { data: [{ id: 'ltx-fixture' }] } };
      case '/ltx/video/generations': return { value: { id: 'ltx-task', status: localStatus } };
      case '/ltx/video/generations/ltx-task': return { value: { id: 'ltx-task', status: localStatus } };
      case '/ltx/video/generations/ltx-task/content': return localStatus === 'succeeded'
        ? { binary: mp4, type: 'video/mp4' } : { code: 409, value: { error: 'not_ready' } };
      case '/ark/contents/generations/tasks': return { value: { id: 'ark-task' } };
      case '/ark/contents/generations/tasks/ark-task': return { value: { id: 'ark-task', status: 'succeeded', content: { video_url: seedanceUrl } } };
      case '/minimax/v2/video_generation': return { value: { task_id: 'minimax-task', base_resp: { status_code: 0 } } };
      case '/minimax/v2/query/video_generation/minimax-task': return { value: { task: { task_id: 'minimax-task', status: 'success', content: { url: 'https://cdn.hailuoai.com/video.mp4' } } } };
      case '/wan/services/aigc/video-generation/video-synthesis': return { value: { output: { task_id: 'wan-task', task_status: 'PENDING' } } };
      case '/wan/tasks/wan-task': return { value: { output: { task_id: 'wan-task', task_status: 'SUCCEEDED', video_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video.mp4' } } };
    }
  });
  const app = await setup(t);
  const ltx = await publishService(app, `${fixture.origin}/ltx`, 'local-ltx');
  const seedance = await publishService(app, `${fixture.origin}/ark`, 'seedance', { upstreamModel: 'ark-fixture' });
  const minimax = await publishService(app, `${fixture.origin}/minimax`, 'minimax-video');
  const wan = await publishService(app, `${fixture.origin}/wan`, 'wan', { upstreamModel: 'wan2.6-i2v-flash' });
  const models = [ltx, seedance, minimax, wan];
  const owner = (await app.mutate('/admin/keys', 'POST', { name: 'Video A', models })).data.token;
  const other = (await app.mutate('/admin/keys', 'POST', { name: 'Video B', models })).data.token;
  const client = new OpenAI({ baseURL: `${app.origin}/v1`, apiKey: owner, maxRetries: 0 });
  const input = { model: ltx, prompt: 'A sailboat', seconds: '4' };
  const headers = { 'Idempotency-Key': 'clip-1' };
  const video = await client.videos.create(input, { headers });
  const repeated = await app.request('/v1/videos', 'POST', input, owner, headers);
  assert.equal(video.status, 'queued');
  assert.match(video.id, /^video_[a-f0-9]{32}$/);
  assert.equal(repeated.data.id, video.id);
  assert.equal(repeated.data.created_at, video.created_at);
  assert.equal(repeated.response.headers.get('location'), `/v1/videos/${video.id}`);
  const submissions = fixture.calls.filter(call => call.path === '/ltx/video/generations');
  assert.deepEqual(JSON.parse(submissions[0].body), { model: 'ltx-fixture', prompt: input.prompt, width: 768, height: 448, fps: 24, num_frames: 97, reference_images: [], seed: 42 });
  assert.match(submissions[0].headers['idempotency-key'], /^[a-f0-9]{64}$/);
  assert.equal(submissions[0].headers['idempotency-key'], submissions[1].headers['idempotency-key']);
  const before = fixture.calls.length;
  assert.equal((await app.request(`/v1/videos/${video.id}`, 'GET', undefined, other)).status, 404);
  assert.equal((await app.request(`/v1/videos/${video.id}/content`, 'GET', undefined, other)).status, 404);
  assert.equal(fixture.calls.length, before);
  await assert.rejects(client.videos.downloadContent(video.id), error => error.status === 409 && error.code === 'video_not_ready');
  localStatus = 'succeeded';
  assert.equal((await client.videos.retrieve(video.id)).status, 'completed');
  const ltxContent = await client.videos.downloadContent(video.id, { variant: 'video' });
  assert.equal(ltxContent.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await ltxContent.arrayBuffer()), mp4);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
  const frame = await toFile(png, 'frame.png', { type: 'image/png' });
  const cloud = [];
  for (const [model, upstreamModel] of [[seedance, 'ark-fixture'], [minimax, 'MiniMax-H3'], [wan, 'wan2.6-i2v-flash']]) {
    const task = await client.videos.create({ model, prompt: 'A lake', seconds: '5', input_reference: frame });
    const submit = fixture.calls.at(-1);
    const native = JSON.parse(submit.body);
    assert.equal(native.model, upstreamModel);
    const firstFrame = native.input?.img_url ?? native.content[1].image_url.url;
    assert.equal(firstFrame, `data:image/png;base64,${png.toString('base64')}`);
    if (model === wan) assert.equal(submit.headers['x-dashscope-async'], 'enable');
    assert.equal((await client.videos.retrieve(task.id)).status, 'completed');
    const download = await fetch(`${app.origin}/v1/videos/${task.id}/content`, { headers: { authorization: `Bearer ${owner}` }, redirect: 'manual' });
    assert.equal(download.status, 303);
    assert.match(download.headers.get('location'), /^https:\/\/.+\/video\.mp4$/);
    cloud.push(task);
  }
  const originalFetch = globalThis.fetch;
  const assetCalls = [];
  const assetPath = 'https://example.tos-cn-beijing.volces.com/final.mp4';
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url === seedanceUrl || url === assetPath) {
      assetCalls.push({ url, options });
      return Promise.resolve(url === assetPath
        ? new Response(mp4, { headers: { 'content-type': 'application/octet-stream' } })
        : new Response(null, { status: 302, headers: { location: '/final.mp4' } }));
    }
    return originalFetch(url, options);
  });
  const browserDownload = await fetch(`${app.origin}/v1/videos/${cloud[0].id}/content`, {
    headers: { authorization: `Bearer ${owner}`, accept: 'video/mp4' }, redirect: 'error'
  });
  assert.equal(browserDownload.status, 200);
  assert.equal(browserDownload.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await browserDownload.arrayBuffer()), mp4);
  assert.deepEqual(assetCalls.map(call => call.url), [seedanceUrl, assetPath]);
  assert.ok(assetCalls.every(call => !new Headers(call.options.headers).has('authorization') && call.options.redirect === 'manual'));
  seedanceUrl = 'https://unapproved.example/video.mp4';
  await assert.rejects(client.videos.downloadContent(cloud[0].id), error => error.status === 502 && error.code === 'upstream_protocol_error');

  await app.close();
  const restarted = await startGateway({ directory: app.directory, port: 0 });
  try {
    const response = await fetch(`${restarted.origin}/v1/videos/${video.id}`, { headers: { authorization: `Bearer ${owner}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'completed');
  } finally { await restarted.close(); }
});

test('project-scoped service calls preserve native requests and isolate video task ownership', async t => {
  const upstreamKey = 'native-service-fixture';
  const seen = [];
  const native = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    seen.push({ url: request.url, method: request.method, credential: request.headers.authorization,
      async: request.headers['x-dashscope-async'], contentType: request.headers['content-type'], body });
    assert.equal(request.headers.authorization, `Bearer ${upstreamKey}`);
    const send = value => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.url === '/chat/completions') {
      return response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"fixture":"thinking"}\n\ndata: [DONE]\n\n');
    }
    if (request.url === '/audio/transcriptions') return send({ text: 'test audio' });
    if (request.url === '/tools/search') return send({ results: [{ title: 'fixture' }] });
    if (request.url.endsWith('/video-synthesis')) return send({ output: { task_id: 'fixture-task' } });
    return send({ status: 'succeeded' });
  }).listen(0, '127.0.0.1');
  await once(native, 'listening');
  t.after(() => native.close());
  const app = await setup(t);
  const baseUrl = `http://127.0.0.1:${native.address().port}`;
  async function publish(service) {
    const connection = (await app.mutate('/admin/connections', 'POST', {
      type: 'service', service, name: service, baseUrl, apiKey: upstreamKey
    })).data.id;
    assert.match(connection, /^conn_/);
    assert.equal((await app.mutate(`/admin/connections/${connection}/discover`, 'POST')).status, 200);
    const deployment = `${connection}/${service}`;
    await app.enable(deployment);
    return deployment;
  }
  const text = await publish('deepseek'), video = await publish('wan'), transcription = await publish('transcription');
  const search = await publish('deepseek-search');
  const key = async (name, models) => (await app.mutate('/admin/keys', 'POST', { name, models })).data.token;
  const first = await key('app A', [text, video, transcription, search]), second = await key('app B', [video]);
  const scoped = await app.request('/v1/models', 'GET', undefined, second);
  assert.deepEqual(scoped.data.data.map(model => [model.id, model.service]), [[video, 'wan']]);
  const endpoint = model => `/v1/services/${encodeURIComponent(model)}`;
  const send = (model, path, token, method, body) => fetch(app.origin + endpoint(model) + path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) })
  });
  const prompt = { model: 'deepseek-fixture', thinking: { type: 'enabled' }, stream: true };
  const denied = await send(text, '/chat/completions', second, 'POST', prompt);
  assert.equal(denied.status, 403);
  assert.equal(seen.length, 0);
  const sse = await fetch(app.origin + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${first}`, 'x-model-dock-service': text, 'content-type': 'application/json' },
    body: JSON.stringify(prompt)
  });
  assert.match(await sse.text(), /thinking/);
  assert.deepEqual(JSON.parse(seen[0].body), prompt);
  const create = await send(video, '/services/aigc/video-generation/video-synthesis', first, 'POST', { model: 'video-fixture' });
  assert.equal((await create.json()).output.task_id, 'fixture-task');
  assert.equal(seen[1].async, 'enable');
  assert.equal((await send(video, '/tasks/fixture-task', first, 'GET')).status, 200);
  assert.equal((await send(video, '/tasks/fixture-task', second, 'GET')).status, 404);
  assert.equal((await send(video, '/tasks/fixture-task/cancel', second, 'POST')).status, 404);
  assert.equal((await send(video, '/tasks/fixture-task?url=https://example.test', first, 'GET')).status, 400);
  assert.equal((await send(video, '/arbitrary', first, 'GET')).status, 404);
  assert.equal(seen.length, 3);
  const form = new FormData();
  form.set('file', new Blob([Buffer.from('test-audio')], { type: 'audio/mpeg' }), 'test.mp3');
  form.set('model', 'whisper-1');
  form.append('timestamp_granularities[]', 'word');
  const transcribed = await fetch(app.origin + '/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${first}`, 'x-model-dock-service': transcription }, body: form
  });
  assert.deepEqual(await transcribed.json(), { text: 'test audio' });
  assert.match(seen[3].contentType, /^multipart\/form-data; boundary=/);
  const received = await new Response(seen[3].body, { headers: { 'content-type': seen[3].contentType } }).formData();
  assert.equal(await received.get('file').text(), 'test-audio');
  assert.deepEqual(received.getAll('timestamp_granularities[]'), ['word']);
  assert.equal((await send(video, '/tasks/fixture-task/cancel', first, 'POST')).status, 200);
  const query = { query: 'fixture', count: 1, need_content: false };
  const searched = await send(search, '/tools/search', first, 'POST', query);
  assert.deepEqual(await searched.json(), { results: [{ title: 'fixture' }] });
  assert.deepEqual(JSON.parse(seen.at(-1).body), query);
  assert.equal((await send(search, '/tools/search', second, 'POST', query)).status, 403);
});
