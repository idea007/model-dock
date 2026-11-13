import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startGateway } from '../apps/gateway/server.mjs';
import { startDemo } from '../apps/demo/server.mjs';

for (const [name, start, asset, statePath, getToken] of [
  ['gateway', startGateway, 'style.css', '/admin/state', app => app.store.adminToken],
  ['client demo', startDemo, 'base.css', '/api/state', app => app.store.accessToken]
]) test(`${name}: a port-stripped same-origin header loads assets without trusting other origins or bypassing authentication`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-origin-'));
  const app = await start({ directory, port: 0 });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const portless = 'http://127.0.0.1';
  const sameOrigin = { origin: portless, 'sec-fetch-site': 'same-origin' };
  for (const [endpoint, expected] of [[`/assets/${asset}`, /text\/css/], ['/assets/models.css', /text\/css/], ['/assets/app.mjs', /text\/javascript/]]) {
    const response = await fetch(app.origin + endpoint, { headers: sameOrigin });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), expected);
    assert.ok((await response.text()).length > 100);
  }
  const favicon = await fetch(app.origin + '/favicon.ico', { headers: sameOrigin });
  assert.equal(favicon.status, 204);
  const token = getToken(app);
  const stateResponse = await fetch(app.origin + statePath, { headers: { ...sameOrigin, authorization: `Bearer ${token}` } });
  assert.equal(stateResponse.status, 200); await stateResponse.json();
  const anonymous = await fetch(app.origin + statePath, { headers: sameOrigin });
  assert.equal(anonymous.status, 401); await anonymous.json();
  const otherPort = new URL(app.origin).port === '4320' ? '4321' : '4320';
  for (const headers of [
    { origin: portless },
    { origin: portless, 'sec-fetch-site': 'same-site' },
    { origin: portless, 'sec-fetch-site': 'cross-site' },
    { origin: portless, 'sec-fetch-site': 'none' },
    { origin: `${portless}:${otherPort}`, 'sec-fetch-site': 'same-site' },
    { origin: `${portless}:${otherPort}`, 'sec-fetch-site': 'same-origin' },
    { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin: app.origin, 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }
  ]) {
    const response = await fetch(app.origin + statePath, { headers: { ...headers, authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403, JSON.stringify(headers)); await response.json();
  }
  const normal = await fetch(app.origin + statePath, { headers: { origin: app.origin, 'sec-fetch-site': 'same-origin', authorization: `Bearer ${token}` } });
  assert.equal(normal.status, 200); await normal.json();
});
