import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run pack:check.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-package-'));
let app, demo;
try {
  const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporary], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  const [manifest] = JSON.parse(packed.stdout);
  for (const file of manifest.files) if (/node_modules|\.env(?:\.|$)|admin\.token|access\.token|master\.key|state\.json|client\.json|(?:client|server)\.lock|(^|\/)tests\//.test(file.path)) throw new Error(`Private/development file in package: ${file.path}`);
  if (manifest.files.some(file => file.path === 'apps/demo/mock.mjs')) throw new Error('Simulated providers must remain in tests.');
  const archive = path.join(temporary, manifest.filename);
  await run(process.execPath, [npm, 'install', '--prefix', temporary, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], { maxBuffer: 4 * 1024 * 1024 });
  const installed = path.join(temporary, 'node_modules', 'lab-model-dock');
  const help = await run(process.execPath, [path.join(installed, 'apps/gateway/cli.mjs'), '--help'], { cwd: temporary });
  if (!help.stdout.includes('Model Dock')) throw new Error('Installed CLI failed.');
  const { startGateway } = await import(pathToFileURL(path.join(installed, 'apps/gateway/server.mjs')));
  app = await startGateway({ directory: path.join(temporary, 'data'), port: 0, providers: { openai: {
    async *generate() { yield { type: 'delta', delta: { content: 'Package smoke response' } }; yield { type: 'done', finishReason: 'stop' }; }
  } } });
  for (const endpoint of ['/', '/assets/app.mjs', '/assets/style.css', '/assets/models.css', '/assets/api-docs.mjs', '/assets/api-docs.css', '/assets/events.mjs', '/assets/image-options.mjs', '/healthz']) {
    const response = await fetch(app.origin + endpoint);
    if (!response.ok) throw new Error(`Installed artifact missing ${endpoint}`);
    await response.arrayBuffer();
  }
  const demoHelp = await run(process.execPath, [path.join(installed, 'apps/demo/cli.mjs'), '--help'], { cwd: temporary });
  if (!demoHelp.stdout.includes('client app') || demoHelp.stdout.includes('--mock')) throw new Error('Installed demo CLI failed.');
  const { startDemo } = await import(pathToFileURL(path.join(installed, 'apps/demo/server.mjs')));
  demo = await startDemo({ directory: path.join(temporary, 'demo-data'), port: 0 });
  for (const endpoint of ['/', '/assets/app.mjs', '/assets/base.css', '/assets/models.css', '/assets/models.mjs', '/assets/demo.css', '/assets/events.mjs', '/assets/api-docs.mjs', '/assets/api-docs.css', '/assets/image-options.mjs', '/healthz']) {
    const response = await fetch(demo.origin + endpoint);
    if (!response.ok) throw new Error(`Installed demo artifact missing ${endpoint}`);
    await response.arrayBuffer();
  }
  const sessionResponse = await fetch(demo.origin + '/api/session', { method: 'POST', headers: { 'x-model-dock-client': '1' } });
  const { session } = await sessionResponse.json();
  if (!sessionResponse.ok || !session) throw new Error('Installed client session bootstrap failed.');
  const api = async (endpoint, body) => {
    const response = await fetch(demo.origin + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); if (!response.ok) throw new Error(`Installed client ${endpoint} failed.`); return data;
  };
  const initial = await api('/api/state');
  if (initial.connection.configured || initial.models.length) throw new Error('Installed client must start without simulated models.');
  await app.store.mutate(app.store.read().revision, state => {
    state.connections.push({ id: 'smoke', name: 'Package test', type: 'openai', baseUrl: 'http://127.0.0.1', enabled: true, status: 'connected', maxConcurrency: 4, timeoutSeconds: 60 });
    state.models.push({ id: 'smoke/chat', nativeId: 'chat', name: 'Package chat', connectionId: 'smoke', enabled: true, available: true, capabilities: { text: true }, reasoningEfforts: [] });
  });
  const { token } = await app.gateway.createKey({ revision: app.store.read().revision, name: 'Package client', models: ['smoke/chat'] });
  const { state } = await api('/api/connection', { revision: initial.revision, baseUrl: `${app.origin}/v1`, apiKey: token });
  const models = state.models.map(({ id, reasoningPolicy, groupPolicies }) => ({ id, enabled: true, reasoningPolicy, groupPolicies }));
  const routes = state.routes.map(route => route.id === 'chat' ? { ...route, modelId: 'smoke/chat', allowedModelIds: ['smoke/chat'] } : route);
  await api('/api/settings', { revision: state.revision, models, routes });
  const result = await api('/api/run', { featureId: 'chat', prompt: 'Package smoke test', stream: false });
  if (result.choices[0].message.content !== 'Package smoke response') throw new Error('Installed client-to-gateway call failed.');
  console.log(`Package verified: ${manifest.filename}, ${manifest.files.length} files, ${manifest.size} bytes. Installed CLIs, HTTP assets, direct client entry, project-key connection and isolated test inference work outside the source tree.`);
} finally { await demo?.close(); await app?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
