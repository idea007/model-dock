import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexEnvironment, loopbackSystemProxies } from '../packages/providers/codex/environment.mjs';

const systemProxy = '<dictionary> {\n HTTPEnable : 1\n HTTPPort : 7890\n HTTPProxy : 127.0.0.1\n HTTPSEnable : 1\n HTTPSPort : 7890\n HTTPSProxy : 127.0.0.1\n}';

test('Codex inherits enabled macOS loopback proxies without forwarding application secrets', async () => {
  const env = await createCodexEnvironment({ source: { HOME: '/fixture/home', PATH: '/fixture/bin', APPLICATION_SECRET: 'private', OPENAI_API_KEY: 'private' }, platform: 'darwin', readProxy: async () => systemProxy });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(env.HOME, '/fixture/home');
  assert.equal(env.APPLICATION_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.deepEqual(loopbackSystemProxies(systemProxy.replaceAll('127.0.0.1', 'proxy.example')), {});
  assert.deepEqual(loopbackSystemProxies(systemProxy.replaceAll('Enable : 1', 'Enable : 0')), {});
  assert.deepEqual(loopbackSystemProxies(systemProxy.replaceAll('7890', '70000')), {});
});

test('explicit proxy configuration takes precedence and failed detection remains optional', async () => {
  for (const HTTPS_PROXY of ['http://explicit.example:8080', '']) {
    const env = await createCodexEnvironment({ source: { HTTPS_PROXY, NO_PROXY: 'custom.example' }, platform: 'darwin', readProxy: async () => { assert.fail('Explicit proxy must bypass detection'); } });
    assert.equal(env.HTTPS_PROXY, HTTPS_PROXY); assert.equal(env.NO_PROXY, 'custom.example');
  }
  assert.deepEqual(await createCodexEnvironment({ source: {}, platform: 'linux', readProxy: async () => { assert.fail('Do not inspect other platforms'); } }), {});
  assert.deepEqual(await createCodexEnvironment({ source: {}, platform: 'darwin', readProxy: async () => { throw new Error('not available'); } }), {});
});
