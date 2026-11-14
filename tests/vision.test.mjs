import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import OpenAI from 'openai';
import { maxInferenceRequestBytes } from '../packages/protocol/image-options.mjs';
import { fixtureUpstream, setup } from './helpers.mjs';

// Decodable images with different bytes so the upstream assertions detect reordering.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQS9kHAAHkAUESjHgQAAAAAElFTkSuQmCC';
const jpeg = '/9j//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAABhABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAgACAMBEgACEgADEgD/2gAMAwEAAhEDEQA/AJgXAlB//9k=';
const webp = 'UklGRlQAAABXRUJQVlA4IEgAAACwBACdASqAAEAAPm02mUmkIqKhIQgAgA2JaQB2AAARaiVea2vp06dOnTp06b4AAP7hw3//4ILaj0w48P/8W0joUngAAAAAAAA=';
const dataUrl = (format, encoded) => `data:image/${format};base64,${encoded}`;
const pngUrl = dataUrl('png', png), jpegUrl = dataUrl('jpeg', jpeg), webpUrl = dataUrl('webp', webp);
const text = text => ({ type: 'text', text });
const image = (url, detail) => ({ type: 'image_url', image_url: { url, detail } });
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const digest = base64 => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

function responseInput(messages) {
  return messages.map(message => typeof message.content === 'string' ? message : { ...message, content: message.content.map(part => (
    part.type === 'text' ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail }
  )) });
}

async function responsesStream(client, request) {
  const stream = client.responses.stream(request);
  let text = '', completed = false;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.type === 'response.completed') completed = true;
  }
  assert.ok(completed);
  assert.equal((await stream.finalResponse()).output_text, text);
  return text;
}

test('SDK image inputs reach OpenAI-compatible and Ollama upstreams in both endpoints', async t => {
  const app = await setup(t), upstream = await fixtureUpstream(t, [{ id: 'shared' }], { ollamaVision: true });
  const openai = (await app.connection('openai', upstream.origin + '/v1')) + '/shared';
  const ollama = (await app.connection('ollama', upstream.origin)) + '/local:vision';
  await app.enable(openai);
  await app.enable(ollama);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'Vision clients', models: [openai, ollama] })).data;
  const sdk = new OpenAI({ baseURL: app.origin + '/v1', apiKey: token, maxRetries: 0 });
  const catalog = new Map((await sdk.models.list()).data.map(model => [model.id, model.capabilities.image_input]));
  assert.equal(catalog.get(openai), null);
  assert.equal(catalog.get(ollama), true);

  const first = [user([text('Describe '), image(pngUrl), text(' it.')])];
  const latest = user([text('Compare '), image(jpegUrl, 'auto'), text(' and '), image(webpUrl), text(' now.')]);
  for (const [model, expected, endpoint] of [
    [openai, '你好，来自测试上游。', '/v1/chat/completions'], [ollama, '本机回答', '/api/chat']
  ]) {
    const chat = await sdk.chat.completions.create({ model, messages: first });
    assert.equal(chat.choices[0].message.content, expected);
    const responses = await sdk.responses.create({ model, input: responseInput(first) });
    assert.equal(responses.output_text, expected);
    assert.equal(responses.store, false);
    const messages = [...first, assistant(expected), latest];
    const stream = await sdk.chat.completions.create({ model, messages, stream: true });
    let reply = '', finish;
    for await (const chunk of stream) {
      reply += chunk.choices[0]?.delta.content || '';
      finish ||= chunk.choices[0]?.finish_reason;
    }
    assert.equal(reply, expected);
    assert.equal(finish, 'stop');
    const input = [...responseInput(first), ...responses.output, ...responseInput([latest])];
    assert.equal(await responsesStream(sdk, { model, input }), expected);

    const actual = upstream.calls.filter(call => call.url === endpoint).map(call => call.body);
    const expectedMessages = model === openai ? messages : [
      { ...user('Describe  it.'), images: [png] }, assistant(expected),
      { ...user('Compare  and  now.'), images: [jpeg, webp] }
    ];
    // The SDK omits undefined detail fields on the wire.
    const wire = JSON.parse(JSON.stringify(expectedMessages));
    assert.deepEqual(actual.map(body => body.messages), [wire.slice(0, 1), wire.slice(0, 1), wire, wire]);
    if (model === openai) assert.deepEqual(actual.map(body => body.store), [undefined, false, undefined, false]);
  }
});

test('Codex SDK image input keeps current and historical images in their original order', async t => {
  const app = await setup(t), model = (await app.connection('codex')) + '/codex-fixture';
  await app.enable(model);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'Codex vision', models: [model] })).data;
  const sdk = new OpenAI({ baseURL: app.origin + '/v1', apiKey: token, maxRetries: 0 });
  assert.equal((await sdk.models.list()).data[0].capabilities.image_input, true);
  const first = [user([text('vision-check first '), image(pngUrl), text(' end')])];
  const firstReceived = { current: [['text', 'vision-check first '], ['image', digest(png), null], ['text', ' end']], history: [] };
  const chat = await sdk.chat.completions.create({ model, messages: first });
  assert.deepEqual(JSON.parse(chat.choices[0].message.content), firstReceived);
  const response = await sdk.responses.create({ model, input: responseInput(first) });
  assert.deepEqual(JSON.parse(response.output_text), firstReceived);

  const latest = user([text('vision-check follow up '), image(jpegUrl, 'auto'), text(' and '), image(webpUrl)]);
  const stream = await sdk.chat.completions.create({ model, messages: [...first, chat.choices[0].message, latest], stream: true });
  let output = '';
  for await (const chunk of stream) output += chunk.choices[0]?.delta.content || '';
  const received = { current: [['text', 'vision-check follow up '], ['image', digest(jpeg), 'auto'], ['text', ' and '], ['image', digest(webp), null]],
    history: [firstReceived.current] };
  assert.deepEqual(JSON.parse(output), received);
  assert.deepEqual(JSON.parse(await responsesStream(sdk, { model, input: [...responseInput(first), ...response.output, ...responseInput([latest])] })), received);
});

test('both endpoints reject invalid images, unsupported models and oversized JSON before inference', async t => {
  const app = await setup(t);
  const upstream = await fixtureUpstream(t, [{ id: 'shared' }, { id: 'text-only', capabilities: { image_input: false } }]);
  const openai = await app.connection('openai', upstream.origin + '/v1'), model = openai + '/shared';
  const ollama = await app.connection('ollama', upstream.origin);
  const codex = await app.connection('codex');
  const textModels = [openai + '/text-only', ollama + '/local:small', codex + '/codex-text-only'];
  const imageModel = codex + '/codex-imagegen';
  for (const id of [model, ...textModels, imageModel]) await app.enable(id);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'Vision validation', models: [model, ...textModels, imageModel] })).data;
  const sdk = new OpenAI({ baseURL: app.origin + '/v1', apiKey: token, maxRetries: 0 });
  const catalog = new Map((await sdk.models.list()).data.map(model => [model.id, model.capabilities.image_input]));
  assert.deepEqual(textModels.map(id => catalog.get(id)), [false, false, false]);

  const badPng = Buffer.from(png, 'base64');
  badPng[badPng.length - 1] ^= 1;
  const malformed = [
    [image('https://example.com/image.png'), 'unsupported_content'],
    [image('file:///tmp/image.png'), 'unsupported_content'],
    [image('data:image/gif;base64,R0lGODlh'), 'invalid_image_input'],
    [image('data:image/png;base64,!!!!'), 'invalid_image_input'],
    [image(dataUrl('jpeg', png)), 'invalid_image_input'],
    [image(dataUrl('jpeg', Buffer.from(jpeg, 'base64').subarray(0, -2).toString('base64'))), 'invalid_image_input'],
    [image(dataUrl('webp', Buffer.from(webp, 'base64').subarray(0, -2).toString('base64'))), 'invalid_image_input'],
    [image(dataUrl('png', badPng.toString('base64'))), 'invalid_image_input'],
    [image(pngUrl, 'low'), 'unsupported_parameter'],
    [image(pngUrl, null), 'unsupported_parameter']
  ];
  const check = (status, code, param) => error => error.status === status && error.code === code && (!param || error.param === param);
  const jsonCalls = upstream.calls.length;
  for (const [part, code] of malformed) {
    await assert.rejects(sdk.chat.completions.create({ model, messages: [user([part])], stream: true }), check(400, code, 'messages'));
    await assert.rejects(sdk.responses.create({ model, input: responseInput([user([part])]), stream: true }), check(400, code, 'input'));
  }
  const messages = [user([image(pngUrl)])];
  const input = responseInput(messages);
  await assert.rejects(sdk.responses.create({ model, input: [user([{ type: 'input_image', file_id: 'file_example' }])] }), check(400, 'unsupported_parameter', 'file_id'));
  await assert.rejects(sdk.chat.completions.create({ model, messages: [user([text('Read this.'), image()])] }), check(400, 'invalid_image_input', 'messages'));
  await assert.rejects(sdk.responses.create({ model, input: [user([{ type: 'input_text', text: 'Read this.' }, { type: 'input_image' }])] }), check(400, 'invalid_image_input', 'input'));
  await assert.rejects(sdk.chat.completions.create({ model, messages: [assistant([image(pngUrl)])] }), check(400, 'unsupported_content', 'messages'));
  await assert.rejects(sdk.responses.create({ model, input: responseInput([assistant([image(pngUrl)])]) }), check(400, 'unsupported_content', 'input'));
  for (const model of [...textModels, imageModel]) {
    await assert.rejects(sdk.chat.completions.create({ model, messages }), check(400, 'unsupported_model_capability'));
    await assert.rejects(sdk.responses.create({ model, input }), check(400, 'unsupported_model_capability'));
  }
  const oversized = dataUrl('png', 'A'.repeat(maxInferenceRequestBytes));
  await assert.rejects(sdk.chat.completions.create({ model, messages: [user([image(oversized)])] }), check(413, 'request_too_large'));
  await assert.rejects(sdk.responses.create({ model, input: responseInput([user([image(oversized)])]) }), check(413, 'request_too_large'));
  assert.equal(upstream.calls.length, jsonCalls);
  assert.equal(app.gateway.history.length, 0);
});
