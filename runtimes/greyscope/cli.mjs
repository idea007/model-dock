import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { managedJob, stageSources, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';
import { serviceSettings, serviceToken } from '../service-settings.mjs';

const manifest = JSON.parse(readFileSync(new URL('./greyscope-model.json', import.meta.url), 'utf8'));
const usage = 'model-dock greyscope <setup|start|stop|restart|health>\n' +
  'model-dock greyscope setup [--source <prepared model directory>]';

function greyscopeSettings(directory, env) {
  const settings = serviceSettings(directory, { kind: 'greyscope', name: 'Greyscope', defaultPort: 7746 }, env);
  return { ...settings, model: path.join(settings.root, 'model'), python: path.join(settings.root, 'venv', 'bin', 'python') };
}

function run(executable, args, { env, timeout = 180_000, name }) {
  const result = spawnSync(executable, args, { env, stdio: 'ignore', timeout });
  if (result.error || result.status !== 0) throw new Error(`Greyscope ${name} failed.`);
}

async function verifyModel(directory) {
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(directory, name);
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    const hash = createHash('sha256');
    for await (const part of createReadStream(file)) hash.update(part);
    if (hash.digest('hex') !== expected) return false;
  }
  return true;
}

async function setup(settings, source, env) {
  if (managedJob(settings)) throw new Error('Stop managed Greyscope before setting up its model and dependencies.');
  mkdirSync(settings.root, { recursive: true, mode: 0o700 });
  if (!existsSync(settings.python)) {
    run('uv', ['venv', '--quiet', '--python', '3.12', path.join(settings.root, 'venv')], { env, name: 'Python setup' });
  }
  run('uv', ['pip', 'sync', '--quiet', '--python', settings.python, path.join(import.meta.dirname, 'requirements.txt')],
    { env, timeout: 300_000, name: 'dependency setup' });
  if (source && !await verifyModel(source)) throw new Error('The Greyscope source files do not match the pinned model.');
  if (!await verifyModel(settings.model)) {
    mkdirSync(settings.model, { recursive: true, mode: 0o700 });
    if (source) {
      for (const name of Object.keys(manifest.files)) copyFileSync(path.join(source, name), path.join(settings.model, name));
    } else {
      run(settings.python, ['-c', [
        'import json, sys', 'from huggingface_hub import snapshot_download',
        'snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], allow_patterns=json.loads(sys.argv[4]), max_workers=3)'
      ].join('\n'), manifest.modelId, manifest.revision, settings.model, JSON.stringify(Object.keys(manifest.files))], {
        env: { ...env, HF_HUB_OFFLINE: '0', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
        timeout: 900_000, name: 'model download'
      });
    }
    if (!await verifyModel(settings.model)) throw new Error('Greyscope model checksum verification failed.');
  }
  serviceToken(settings.root, { create: true });
  console.log(`Prepared Model Dock Greyscope model ${manifest.engine} at revision ${manifest.revision}.`);
}

async function health(settings, pid) {
  if (!pid) return null;
  try {
    const response = await fetch(`${settings.origin}/health`, {
      headers: { authorization: `Bearer ${serviceToken(settings.root)}` }, redirect: 'error', signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    return body.ready === true && body.engine === manifest.engine && body.modelRevision === manifest.revision &&
      body.runtimeId === settings.id && body.pid === pid ? { pid } : null;
  } catch { return null; }
}

export async function runGreyscopeCommand(args, directory, env = process.env) {
  const [command, ...options] = args;
  if (!command || (!options.length && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (command !== 'setup' && (options.length || !['start', 'stop', 'restart', 'health'].includes(command))) throw new Error(usage);
  let source;
  try { ({ values: { source } } = parseArgs({ args: options, options: { source: { type: 'string' } } })); }
  catch { throw new Error(usage); }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Greyscope requires Apple Silicon macOS.');
  const settings = greyscopeSettings(directory, env);
  if (command === 'setup') return setup(settings, source, env);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock Greyscope stopped.');
    return;
  }

  const probe = pid => health(settings, pid);
  let ready;
  if (command === 'health') {
    ready = await probe(managedJob(settings)?.pid);
  } else {
    if (!existsSync(settings.python) || !existsSync(path.join(settings.model, 'model.safetensors'))) {
      throw new Error('Run model-dock greyscope setup first.');
    }
    serviceToken(settings.root);
    const sourceRoot = stageSources(settings.root, import.meta.dirname,
      ['engine.py', 'greyscope-model.json', 'server.py', 'text_processing.py']);
    if (command === 'restart') await stopLaunchAgent(settings);
    ready = await startLaunchAgent(settings, {
      args: [settings.python, path.join(sourceRoot, 'server.py'), '--model-dir', settings.model,
        '--token-file', path.join(settings.root, 'service-token'), '--port', String(settings.port), '--runtime-id', settings.id],
      env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' },
      probe, timeoutMs: 90_000
    });
  }
  if (!ready) throw new Error('The Model Dock Greyscope runtime is not healthy for the pinned model revision.');
  console.log(`Model Dock Greyscope ready at ${settings.origin} (PID ${ready.pid}). Model: ${manifest.engine}`);
}
