import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run pack:check.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-package-'));
let app, demo, mock;
try {
  const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporary], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  const [manifest] = JSON.parse(packed.stdout);
  for (const file of manifest.files) if (/node_modules|\.env(?:\.|$)|admin\.token|access\.token|master\.key|state\.json|client\.json|(?:client|server)\.lock|(^|\/)tests\//.test(file.path)) throw new Error(`Private/development file in package: ${file.path}`);
  const archive = path.join(temporary, manifest.filename);
  await run(process.execPath, [npm, 'install', '--prefix', temporary, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], { maxBuffer: 4 * 1024 * 1024 });
  const installed = path.join(temporary, 'node_modules', 'lab-model-dock');
  const help = await run(process.execPath, [path.join(installed, 'apps/gateway/cli.mjs'), '--help'], { cwd: temporary });
  if (!help.stdout.includes('Model Dock')) throw new Error('Installed CLI failed.');
  const { startGateway } = await import(pathToFileURL(path.join(installed, 'apps/gateway/server.mjs')));
  app = await startGateway({ directory: path.join(temporary, 'data'), port: 0 });
  for (const endpoint of ['/', '/assets/app.mjs', '/assets/style.css', '/assets/models.css', '/assets/events.mjs', '/healthz']) {
    const response = await fetch(app.origin + endpoint);
    if (!response.ok) throw new Error(`Installed artifact missing ${endpoint}`);
    await response.arrayBuffer();
  }
  const demoHelp = await run(process.execPath, [path.join(installed, 'apps/demo/cli.mjs'), '--help'], { cwd: temporary });
  if (!demoHelp.stdout.includes('client demo')) throw new Error('Installed demo CLI failed.');
  const { startDemo } = await import(pathToFileURL(path.join(installed, 'apps/demo/server.mjs')));
  const { startMockGateway } = await import(pathToFileURL(path.join(installed, 'apps/demo/mock.mjs')));
  mock = await startMockGateway();
  demo = await startDemo({ directory: path.join(temporary, 'demo-data'), port: 0, mockConnection: mock.connection });
  for (const endpoint of ['/', '/assets/app.mjs', '/assets/base.css', '/assets/models.css', '/assets/models.mjs', '/assets/demo.css', '/assets/events.mjs', '/healthz']) {
    const response = await fetch(demo.origin + endpoint);
    if (!response.ok) throw new Error(`Installed demo artifact missing ${endpoint}`);
    await response.arrayBuffer();
  }
  const response = await fetch(demo.origin + '/api/run', { method: 'POST', headers: { authorization: `Bearer ${demo.store.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ featureId: 'chat', prompt: 'Package smoke test', stream: false }) });
  const result = await response.json();
  if (!response.ok || !result.choices[0].message.content.includes('模拟回复')) throw new Error('Installed client-to-gateway call failed.');
  console.log(`Package verified: ${manifest.filename}, ${manifest.files.length} files, ${manifest.size} bytes. Installed server and client CLIs, HTTP assets and isolated demo inference work outside the source tree.`);
} finally { await demo?.close(); await mock?.close(); await app?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
