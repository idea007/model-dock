import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ollamaHealth, validOllamaRegistration } from '../runtimes/ollama/cli.mjs';

const model = 'qwen3-embedding:0.6b';
const digest = 'd'.repeat(64);
const registration = { version: 1, executable: '/absolute/bin/ollama', modelsRoot: '/absolute/models',
  model, digest, dimensions: 1024 };

test('Ollama registration pins an absolute installation, model digest and dimension', () => {
  assert.equal(validOllamaRegistration(registration), true);
  for (const patch of [{ executable: 'ollama' }, { modelsRoot: 'models' }, { model: 42 }, { digest: 'wrong' }, { dimensions: 1.5 }]) {
    assert.equal(validOllamaRegistration({ ...registration, ...patch }), false);
  }
});

test('Ollama readiness requires the managed listener, exact model digest and embedding dimensions', async () => {
  const settings = { origin: 'http://127.0.0.1:7734', port: 7734 };
  let count = 0;
  const probe = (pid, { modelDigest = digest, dimensions = 1024, capabilities = ['embedding'] } = {}) => ollamaHealth(settings, pid, registration, {
    ownsListener: (owner, port) => owner === 123 && port === settings.port,
    fetchImpl: async (url, init) => {
      count++;
      assert.equal(init.redirect, 'error');
      if (url === settings.origin + '/api/tags') return Response.json({ models: [{ name: model, digest: modelDigest }] });
      assert.equal(url, settings.origin + '/api/show');
      assert.deepEqual(JSON.parse(init.body), { model });
      return Response.json({ model_info: { 'qwen3.embedding_length': dimensions }, capabilities });
    }
  });
  assert.equal(await probe(456), null);
  assert.equal(count, 0);
  assert.deepEqual(await probe(123), { pid: 123, model, dimensions: 1024 });
  assert.equal(await probe(123, { modelDigest: '0'.repeat(64) }), null);
  assert.equal(await probe(123, { dimensions: 768 }), null);
  assert.equal(await probe(123, { capabilities: ['completion'] }), null);
});
