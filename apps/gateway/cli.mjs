#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { startGateway } from './server.mjs';
import { VERSION } from '../../packages/protocol/index.mjs';

export function dataDirectory() {
  return process.env.MODEL_DOCK_HOME || path.join(os.homedir(), '.model-dock');
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'serve';
  if (['--help', '-h', 'help'].includes(command)) {
    console.log(`Model Dock ${VERSION}\n\nmodel-dock serve [--port 4317] [--open]\nmodel-dock token\n\nMODEL_DOCK_HOME chooses the private data directory.\nInference: /v1/models, /v1/chat/completions\nThe server listens on 127.0.0.1 only.`); return;
  }
  if (['--version', '-v'].includes(command)) { console.log(VERSION); return; }
  if (command === 'token' && args.length === 1) {
    try { process.stdout.write(await fs.readFile(path.join(dataDirectory(), 'admin.token'), 'utf8')); }
    catch { throw new Error('Start Model Dock first to create a local administrator token.'); }
    return;
  }
  if (command !== 'serve') throw new Error('Unknown command. Run model-dock --help.');
  let port = Number(process.env.MODEL_DOCK_PORT || 4317), open = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--open') open = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  const app = await startGateway({ directory: dataDirectory(), port });
  console.log(`\nModel Dock ${VERSION}\nConsole  ${app.origin}\nAPI      ${app.origin}/v1\n\nGet your administrator token with: model-dock token (or npm run token)\nPrivate data: ${dataDirectory()}\n`);
  if (open) {
    const url = `${app.origin}/#token=${encodeURIComponent(app.store.adminToken)}`;
    // The fragment never reaches HTTP logs; the console removes it immediately.
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
    child.on('error', () => console.error('Open the console URL in your browser.')); child.unref();
  }
  const stop = () => { void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message); process.exitCode = 1; });
}
