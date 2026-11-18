import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadGatewayEnvironment } from '../apps/gateway/cli.mjs';
import { audioHealth, audioSettings } from '../runtimes/mlx-audio/cli.mjs';

const directory = path.join(os.tmpdir(), 'model-dock-fixture');

test('Machine settings configure runtime ports with explicit environment values taking precedence', async t => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'model-dock-audio-config-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  await writeFile(path.join(configDirectory, '.env'), 'MODEL_DOCK_TTS_PORT=7820\nMODEL_DOCK_ASR_PORT=7832\n');
  await writeFile(path.join(configDirectory, '.env.local'), 'MODEL_DOCK_TTS_PORT=7920\nMODEL_DOCK_ASR_PORT=7932\n');
  const env = await loadGatewayEnvironment({ MODEL_DOCK_CONFIG_DIR: configDirectory, MODEL_DOCK_ASR_PORT: '8032' });
  assert.equal(audioSettings('tts', directory, env).port, 7920);
  assert.equal(audioSettings('asr', directory, env).port, 8032);
});

test('MLX Audio services share package and model data with separate port and process ownership', () => {
  const tts = audioSettings('tts', directory, {});
  const asr = audioSettings('asr', directory, {});
  assert.equal(tts.origin, 'http://127.0.0.1:7720');
  assert.equal(asr.origin, 'http://127.0.0.1:7732');
  assert.equal(tts.root, path.join(directory, 'runtimes', 'mlx-audio'));
  assert.equal(tts.root, asr.root);
  assert.equal(tts.python, asr.python);
  for (const key of ['label', 'id', 'plist', 'logName']) assert.notEqual(tts[key], asr[key]);
  const custom = audioSettings('asr', directory, {
    MODEL_DOCK_MLX_AUDIO_RUNTIME_DIR: directory, MODEL_DOCK_ASR_PORT: '7733'
  });
  assert.equal(custom.origin, 'http://127.0.0.1:7733');
  assert.notEqual(custom.label, asr.label);
  assert.throws(() => audioSettings('tts', directory, { MODEL_DOCK_TTS_PORT: '0' }), /TTS_PORT/);
  assert.throws(() => audioSettings('asr', directory, { MODEL_DOCK_MLX_AUDIO_RUNTIME_DIR: 'relative' }), /absolute path/);
  assert.throws(() => audioSettings('tts', directory, { MODEL_DOCK_TTS_MODEL: 'mismatched-model' }), /supported Kokoro/);
});

test('MLX Audio health requires the registered process and the loaded model for each service', async () => {
  for (const service of ['tts', 'asr']) {
    const settings = audioSettings(service, directory, {});
    const ready = {
      pid: 12345, runtimeId: settings.id, provider: 'mlx-audio', model: settings.model, status: 'ready', ready: true
    };
    const check = payload => audioHealth(settings, ready.pid, async (url, options) => {
      assert.equal(url, settings.origin + '/health');
      assert.equal(options.redirect, 'error');
      return Response.json(payload);
    });
    assert.deepEqual(await check(ready), { pid: ready.pid, model: settings.model });
    assert.equal(await check({ ...ready, pid: 12346 }), null);
    assert.equal(await check({ ...ready, runtimeId: 'old-runtime' }), null);
    assert.equal(await check({ ...ready, model: 'different-model' }), null);
    assert.equal(await check({ ...ready, ready: false, status: 'not_loaded' }), null);
    assert.equal(await audioHealth(settings, ready.pid, async () => new Response('', { status: 503 })), null);
    let queried = false;
    const unmanaged = await audioHealth(settings, undefined, () => {
      queried = true;
      return Response.json(ready);
    });
    assert.equal(unmanaged, null);
    assert.equal(queried, false);
  }
});
