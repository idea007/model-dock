import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile), npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run pack:check.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-package-'));
let app;
try {
  const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporary], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  const [manifest] = JSON.parse(packed.stdout);
  for (const file of manifest.files) if (/node_modules|\.env(?:\.|$)|admin\.token|master\.key|state\.json|server\.lock|(^|\/)tests\//.test(file.path)) throw new Error(`Private/development file in package: ${file.path}`);
  const archive = path.join(temporary, manifest.filename);
  await run(process.execPath, [npm, 'install', '--prefix', temporary, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive], { maxBuffer: 4 * 1024 * 1024 });
  const installed = path.join(temporary, 'node_modules', 'lab-model-dock');
  const help = await run(process.execPath, [path.join(installed, 'apps/gateway/cli.mjs'), '--help'], { cwd: temporary });
  if (!help.stdout.includes('Model Dock')) throw new Error('Installed CLI failed.');
  const { startGateway } = await import(pathToFileURL(path.join(installed, 'apps/gateway/server.mjs')));
  app = await startGateway({ directory: path.join(temporary, 'data'), port: 0 });
  for (const endpoint of ['/', '/assets/app.mjs', '/assets/style.css', '/assets/events.mjs', '/healthz']) {
    const response = await fetch(app.origin + endpoint);
    if (!response.ok) throw new Error(`Installed artifact missing ${endpoint}`);
    await response.arrayBuffer();
  }
  console.log(`Package verified: ${manifest.filename}, ${manifest.files.length} files, ${manifest.size} bytes. Installed CLI and HTTP assets work outside the source tree.`);
} finally { await app?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
