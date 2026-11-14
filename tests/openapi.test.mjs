import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { openapi } from '@readme/openapi-schemas';
import specification from '../docs/openapi.json' with { type: 'json' };
import { IMAGE_PARAMS, PARAMS, VERSION } from '../packages/protocol/index.mjs';
import { RESPONSES_PARAMS } from '../packages/protocol/responses.mjs';
import { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes,
  maxImageRequestBytes, maxImageResultBytes } from '../packages/protocol/image-options.mjs';
import { sse } from '../packages/protocol/events.mjs';
import { fixtureUpstream, setup } from './helpers.mjs';

const { paths, components } = specification;
const chat = paths['/v1/chat/completions'].post;
const responses = paths['/v1/responses'].post;
const images = paths['/v1/images/generations'].post;
const json = 'application/json';
const events = 'text/event-stream';
const ajv = new Ajv2020({ strict: false, validateFormats: false });

function validator(schema) {
  const validate = ajv.compile({ ...schema, components: { schemas: components.schemas } });
  return value => assert.ok(validate(value), ajv.errorsText(validate.errors, { separator: '\n' }));
}

function responseSpec(operation, status) {
  const response = operation.responses[status];
  return response.$ref ? components.responses[response.$ref.split('/').at(-1)] : response;
}

const validateChunk = validator(chat.responses[200].content[events]['x-sse-data-schema']);
function parseEvent(frame) {
  const value = frame === '[DONE]' ? frame : JSON.parse(frame);
  validateChunk(value);
  return value;
}

test('the OpenAPI 3.1 document, payload examples and exported request fields agree', () => {
  // Use the base OAS schema's own Schema Object anchor. Ajv otherwise resolves
  // #meta against the enclosing response during conditional validation.
  const meta = JSON.parse(JSON.stringify(openapi.v31)
    .replaceAll('"$dynamicRef":"#meta"', '"$ref":"#/$defs/schema"'));
  const validate = ajv.compile(meta);
  assert.ok(validate(specification), ajv.errorsText(validate.errors, { separator: '\n' }));
  assert.equal(specification.info.version, VERSION);
  assert.deepEqual(Object.keys(paths).sort(), ['/v1/chat/completions', '/v1/images/generations', '/v1/models', '/v1/responses']);
  const { ChatRequest, ImageRequest, ImageResult, ResponsesRequest } = components.schemas;
  assert.deepEqual(Object.keys(ChatRequest.properties).sort(), [...PARAMS].sort());
  assert.deepEqual(Object.keys(ResponsesRequest.properties).sort(), [...RESPONSES_PARAMS].sort());
  assert.deepEqual(Object.keys(ImageRequest.properties).sort(), [...IMAGE_PARAMS].sort());
  assert.deepEqual(ImageRequest.properties.aspect_ratio.enum, imageAspectRatios);
  const references = ImageRequest.properties.reference_images;
  assert.equal(references.maxItems, maxImageReferences);
  assert.equal(references['x-max-decoded-bytes-per-image'], maxImageReferenceBytes);
  assert.equal(references['x-max-decoded-bytes-total'], maxImageReferenceTotalBytes);
  assert.equal(images.requestBody['x-max-body-bytes'], maxImageRequestBytes);
  assert.equal(ImageResult.properties.data.items.properties.b64_json['x-max-decoded-bytes'], maxImageResultBytes);

  const operations = [paths['/v1/models'].get, chat, responses, images];
  for (const operation of operations) {
    const payloads = Object.keys(operation.responses).map(status => responseSpec(operation, status).content[json]);
    if (operation.requestBody) payloads.push(operation.requestBody.content[json]);
    for (const { schema, examples = {} } of payloads) {
      const check = validator(schema);
      for (const { value } of Object.values(examples)) check(value);
    }
  }
  for (const [name, { value }] of Object.entries(chat.responses[200].content[events].examples)) {
    const frames = value.split('\n\n').filter(Boolean).map(frame => {
      assert.ok(frame.startsWith('data: '));
      return parseEvent(frame.slice(6));
    });
    if (name === 'failed') assert.equal(frames.at(-1).error.code, 'upstream_protocol_error');
    else assert.equal(frames.at(-1), '[DONE]');
  }
});

test('the public spec examples execute against a scoped gateway and match real response shapes', async t => {
  const app = await setup(t), upstream = await fixtureUpstream(t);
  const textModel = (await app.connection('openai', upstream.origin + '/v1')) + '/shared';
  const imageModel = (await app.connection('codex')) + '/codex-imagegen';
  await app.enable(textModel);
  await app.enable(imageModel);
  const { token } = (await app.mutate('/admin/keys', 'POST', { name: 'OpenAPI fixtures', models: [textModel, imageModel] })).data;
  const download = await fetch(app.origin + '/openapi.json');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await download.json(), specification);

  const catalog = await app.request('/v1/models', 'GET', undefined, token);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.response.headers.get('x-request-id'));
  validator(paths['/v1/models'].get.responses[200].content[json].schema)(catalog.data);
  assert.deepEqual(catalog.data.data.map(model => model.id), [textModel, imageModel]);
  const unauthorized = await app.request('/v1/models', 'GET', undefined, '');
  assert.equal(unauthorized.status, 401);
  validator(responseSpec(paths['/v1/models'].get, 401).content[json].schema)(unauthorized.data);

  for (const [endpoint, operation, model] of [
    ['/v1/chat/completions', chat, textModel], ['/v1/responses', responses, textModel], ['/v1/images/generations', images, imageModel]
  ]) {
    const { examples, schema } = operation.requestBody.content[json];
    const validateRequest = validator(schema);
    const validateResponse = validator(operation.responses[200].content[json].schema);
    for (const { value } of Object.values(examples)) {
      const body = { ...value, model };
      validateRequest(body);
      const response = await fetch(app.origin + endpoint, { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': json }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('x-request-id'));
      if (body.stream) {
        assert.match(response.headers.get('content-type'), /^text\/event-stream/);
        if (operation === responses) {
          const validateEvent = validator(operation.responses[200].content[events]['x-sse-data-schema']);
          const frames = (await response.text()).trimEnd().split('\n\n').map(frame => {
            const [name, data] = frame.split('\n');
            assert.ok(name.startsWith('event: ') && data?.startsWith('data: '));
            const event = JSON.parse(data.slice(6));
            assert.equal(name.slice(7), event.type);
            validateEvent(event);
            return event;
          });
          assert.equal(frames.at(-1).type, 'response.completed');
          assert.equal(frames.at(-1).response.usage.total_tokens, 12);
        } else {
          const frames = [];
          for await (const frame of sse(response.body)) frames.push(parseEvent(frame));
          assert.equal(frames.pop(), '[DONE]');
          assert.ok(frames.every(frame => !frame.error));
          assert.deepEqual(frames.at(-1).choices, []);
          assert.equal(frames.at(-1).usage.total_tokens, 12);
        }
      } else {
        const result = await response.json();
        validateResponse(result);
        if (body.response_format?.type === 'json_object') assert.equal(JSON.parse(result.choices[0].message.content).greeting, 'Hello!');
      }
    }
  }
});
