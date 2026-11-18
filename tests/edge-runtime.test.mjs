import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEdgeService } from '../runtimes/edge/server.mjs';

test('Edge service preserves speech timings and redacts upstream failure details', async t => {
  const token = 'test-service-token';
  const voice = 'zh-CN-XiaoxiaoNeural';
  const words = [{ text: '旁白', startSeconds: 0.2, endSeconds: 0.8 }];
  const audio = Buffer.from('mock speech');
  const server = createEdgeService({ python: 'unused', token, workspaceId: 'test', async run(_python, args) {
    if (args[0] === 'check') return;
    const input = JSON.parse(await readFile(args[0], 'utf8'));
    assert.equal(input.voice, voice);
    if (input.text === 'rejected') {
      throw Object.assign(new Error(), {
        stderr: 'private upstream value\nEDGE_TTS_ERROR:{"kind":"handshake-rejected","providerOutcomeKnown":true,"status":403}'
      });
    }
    await writeFile(args[1], audio);
    await writeFile(args[2], JSON.stringify({ words }));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(origin + '/health')).status, 401);
  const health = await fetch(origin + '/health', { headers: auth });
  assert.deepEqual(await health.json(), { ready: true, provider: 'edge-tts', model: 'edge-tts', workspaceId: 'test', pid: process.pid });
  const synthesize = text => fetch(origin + '/v1/audio/speech-with-timestamps', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text, voice, speed: 1 })
  });
  assert.equal((await synthesize('')).status, 422);
  const accepted = await synthesize('旁白');
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { audio: audio.toString('base64'), words });
  const rejected = await synthesize('rejected');
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), {
    error: { code: 'edge_tts_failed', detail: { kind: 'handshake-rejected', providerOutcomeKnown: true, status: 403 } }
  });
});
