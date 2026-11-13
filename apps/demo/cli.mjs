#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startDemo } from './server.mjs';
import { startMockGateway } from './mock.mjs';
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Model Dock client demo\n\nmodel-dock-demo [--mock] [--open] [--port 4318]\nmodel-dock-demo token [--mock]\n\nMODEL_DOCK_DEMO_HOME chooses the private app data directory.\nMock mode uses a separate mock/ subdirectory and never contacts real models.'); return;
  }
  let port = 4318, mock = false, open = false, printToken = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') port = Number(args[++index]);
    else if (args[index] === '--mock') mock = true;
    else if (args[index] === '--open') open = true;
    else if (args[index] === 'token') printToken = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  const root = process.env.MODEL_DOCK_DEMO_HOME || path.join(os.homedir(), '.model-dock-demo');
  const directory = mock ? path.join(root, 'mock') : root;
  if (printToken) { process.stdout.write(await fs.readFile(path.join(directory, 'access.token'), 'utf8')); return; }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  let fixture, app;
  try {
    if (mock) fixture = await startMockGateway();
    app = await startDemo({ directory, port, mockConnection: fixture?.connection });
  } catch (error) { await fixture?.close(); throw error; }
  console.log(`\nModel Dock · Client demo${mock ? ' (SIMULATED MODELS)' : ''}\nDemo     ${app.origin}\nPrivate app data: ${directory}\nLocal session token: npm run demo -- token${mock ? ' --mock' : ''}\n`);
  if (open) {
    const url = `${app.origin}/#token=${encodeURIComponent(app.store.accessToken)}`;
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
    child.on('error', () => console.error('Open the demo URL in your browser.')); child.unref();
  }
  let stopping;
  const stop = () => { stopping ||= app.close().finally(() => fixture?.close()).catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message); process.exitCode = 1; });
