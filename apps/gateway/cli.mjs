#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { startGateway } from './server.mjs';
import { VERSION } from '../../packages/protocol/index.mjs';

export function dataDirectory() {
  return process.env.MODEL_DOCK_HOME || path.join(os.homedir(), '.model-dock');
}

function requestConsoleLink(origin, token) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/admin/console-links`, {
      method: 'POST', agent: false, headers: { authorization: `Bearer ${token}` }, timeout: 3000
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const { url } = JSON.parse(data);
          const link = new URL(url);
          if (response.statusCode !== 200 || link.origin !== origin || link.pathname !== '/' || !link.hash.startsWith('#session=')) {
            throw new Error();
          }
          resolve(link.href);
        } catch {
          reject(new Error('The gateway could not create a console session. Check the port and private data directory.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Timed out connecting to the local gateway.')));
    request.on('error', reject);
    request.end();
  });
}

function openConsole(url) {
  const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
  child.on('error', () => console.error('Open a console link with model-dock open --print.'));
  child.unref();
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'serve';
  if (['--help', '-h', 'help'].includes(command)) {
    console.log(`Model Dock ${VERSION}\n\nmodel-dock serve [--port 4317] [--no-open]\nmodel-dock open [--port 4317] [--print]\nmodel-dock token\n\nStarting the server automatically opens and signs in to the console.\nUse --no-open to run without opening a browser.\nMODEL_DOCK_HOME chooses the private data directory.\nInference: /v1/models, /v1/chat/completions, /v1/images/generations\nThe server listens on 127.0.0.1 only.`); return;
  }
  if (['--version', '-v'].includes(command)) { console.log(VERSION); return; }
  if (command === 'token' && args.length === 1) {
    try { process.stdout.write(await fs.readFile(path.join(dataDirectory(), 'admin.token'), 'utf8')); }
    catch { throw new Error('Start Model Dock first to create a local administrator token.'); }
    return;
  }
  if (!['serve', 'open'].includes(command)) throw new Error('Unknown command. Run model-dock --help.');
  let port = Number(process.env.MODEL_DOCK_PORT || 4317), open = true, print = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (command === 'serve' && args[i] === '--open') open = true;
    else if (command === 'serve' && args[i] === '--no-open') open = false;
    else if (command === 'open' && args[i] === '--print') print = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  if (command === 'open') {
    const token = (await fs.readFile(path.join(dataDirectory(), 'admin.token'), 'utf8')).trim();
    const url = await requestConsoleLink(`http://127.0.0.1:${port}`, token);
    if (print) console.log(url);
    else openConsole(url);
    return;
  }
  const app = await startGateway({ directory: dataDirectory(), port });
  const consoleStatus = open
    ? 'Opening the console in your default browser with automatic sign-in.'
    : `Open the console later with: model-dock open --port ${port} (or npm run console -- --port ${port})`;
  console.log(`\nModel Dock ${VERSION}\nConsole  ${app.origin}\nAPI      ${app.origin}/v1\n\nService ready. ${consoleStatus}\nPrivate data: ${dataDirectory()}\n`);
  if (open) openConsole(app.consoleLink());
  const stop = () => { void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with --port.' : error.message); process.exitCode = 1; });
}
