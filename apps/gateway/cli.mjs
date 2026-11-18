#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { startGateway } from './server.mjs';
import { VERSION } from '../../packages/protocol/index.mjs';

const configRoot = new URL('../../', import.meta.url);
const fileSettings = [
  'MODEL_DOCK_PORT', 'MODEL_DOCK_HOME', 'MODEL_DOCK_CODEX_QUEUE_WAIT_MS',
  'MODEL_DOCK_MFLUX_PORT', 'MODEL_DOCK_MFLUX_RUNTIME_DIR', 'MODEL_DOCK_MFLUX_PYTHON',
  'MODEL_DOCK_TTS_PORT', 'MODEL_DOCK_ASR_PORT', 'MODEL_DOCK_TTS_MODEL',
  'MODEL_DOCK_MLX_AUDIO_RUNTIME_DIR', 'MODEL_DOCK_MLX_AUDIO_PYTHON',
  'MODEL_DOCK_TTS_MOSS_WORKERS', 'MODEL_DOCK_TTS_MOSS_QUEUE', 'MODEL_DOCK_TTS_MOSS_IDLE_SECONDS',
  'MODEL_DOCK_EDGE_PORT', 'MODEL_DOCK_EDGE_RUNTIME_DIR', 'MODEL_DOCK_EDGE_PYTHON', 'MODEL_DOCK_EDGE_PROXY',
  'MODEL_DOCK_LTX_PORT', 'MODEL_DOCK_LTX_RUNTIME_DIR',
  'MODEL_DOCK_GREYSCOPE_PORT', 'MODEL_DOCK_GREYSCOPE_RUNTIME_DIR',
  'MODEL_DOCK_OLLAMA_PORT', 'MODEL_DOCK_OLLAMA_RUNTIME_DIR',
  'CODEX_CLI_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'
];

export async function loadGatewayEnvironment(env = process.env) {
  const directory = env.MODEL_DOCK_CONFIG_DIR || configRoot;
  const defaults = Object.create(null);
  for (const name of ['.env', '.env.local']) {
    const file = directory instanceof URL ? new URL(name, directory) : path.join(directory, name);
    try { Object.assign(defaults, parseEnv(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot load Model Dock ${name}.`, { cause: error }); }
  }
  for (const name of fileSettings) if (env[name] === undefined && defaults[name] !== undefined) env[name] = defaults[name];
  return env;
}

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
    console.log(`Model Dock ${VERSION}\n\nmodel-dock serve [--port 4317] [--no-open]\nmodel-dock open [--port 4317] [--print]\nmodel-dock token\nmodel-dock mflux <setup|preload|start|stop|restart|health>\nmodel-dock tts <setup|preload|start|stop|restart|health>\nmodel-dock asr <setup|preload|start|stop|restart|health>\nmodel-dock edge <setup|start|stop|restart|health>\nmodel-dock ltx <register|start|stop|restart|health>\nmodel-dock greyscope <setup|start|stop|restart|health>\nmodel-dock ollama <register|start|stop|restart|health>\n\nStarting the server automatically opens and signs in to the console.\nUse --no-open to run without opening a browser.\nMODEL_DOCK_HOME chooses the private data directory.\nInference: /v1/models, /v1/chat/completions, /v1/images/generations\nThe server listens on 127.0.0.1 only.`); return;
  }
  if (['--version', '-v'].includes(command)) { console.log(VERSION); return; }
  await loadGatewayEnvironment();
  if (command === 'mflux') {
    const { runMfluxCommand } = await import('../../runtimes/mflux/cli.mjs');
    return runMfluxCommand(args.slice(1), dataDirectory());
  }
  if (command === 'tts' || command === 'asr') {
    const { runAudioCommand } = await import('../../runtimes/mlx-audio/cli.mjs');
    return runAudioCommand(command, args.slice(1), dataDirectory());
  }
  if (command === 'edge') {
    const { runEdgeCommand } = await import('../../runtimes/edge/cli.mjs');
    return runEdgeCommand(args.slice(1), dataDirectory());
  }
  if (command === 'ltx') {
    const { runLtxCommand } = await import('../../runtimes/ltx/cli.mjs');
    return runLtxCommand(args.slice(1), dataDirectory());
  }
  if (command === 'greyscope') {
    const { runGreyscopeCommand } = await import('../../runtimes/greyscope/cli.mjs');
    return runGreyscopeCommand(args.slice(1), dataDirectory());
  }
  if (command === 'ollama') {
    const { runOllamaCommand } = await import('../../runtimes/ollama/cli.mjs');
    return runOllamaCommand(args.slice(1), dataDirectory());
  }
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
  const codexQueueWaitMs = Number(process.env.MODEL_DOCK_CODEX_QUEUE_WAIT_MS || 0);
  if (!Number.isInteger(codexQueueWaitMs) || codexQueueWaitMs < 0 || codexQueueWaitMs > 120_000) {
    throw new Error('MODEL_DOCK_CODEX_QUEUE_WAIT_MS must be an integer between 0 and 120000.');
  }
  const app = await startGateway({ directory: dataDirectory(), port, codexQueueWaitMs });
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
