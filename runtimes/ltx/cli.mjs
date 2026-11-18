import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { managedJob, stageSources, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';
import { serviceSettings, serviceToken } from '../service-settings.mjs';
import { modelReady, readLtxRegistration, registry, validRegistration } from './installation.mjs';

const usage = 'model-dock ltx <register|start|stop|restart|health>\n' +
  'model-dock ltx register --python <absolute executable> --models-root <absolute directory> [--model <id>]';
const worker = path.join(import.meta.dirname, 'worker.py');

export function ltxSettings(directory, env) {
  const settings = serviceSettings(directory, { kind: 'ltx', name: 'LTX', defaultPort: 7930 }, env);
  return { ...settings, installation: path.join(settings.root, 'installation.json'), jobsRoot: path.join(settings.root, 'jobs') };
}

function runtimeEnvironment(settings, env) {
  return {
    PATH: env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HF_HOME: path.join(settings.root, 'huggingface'),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    ...(env.TMPDIR && { TMPDIR: env.TMPDIR })
  };
}

function run(executable, args, env, failure) {
  const result = spawnSync(executable, args, { stdio: 'ignore', env, timeout: 45_000 });
  if (result.error || result.status !== 0) throw new Error(failure);
}

function checkPrepared(registration, environment) {
  for (const executable of ['ffmpeg', 'ffprobe']) {
    run(executable, ['-version'], environment, `LTX requires ${executable} on PATH.`);
  }
  for (const id of registration.modelIds) {
    if (!modelReady(registration.modelsRoot, id)) throw new Error(`LTX model files are missing or invalid for ${id}.`);
    run(registration.pythonExecutable, [worker, '--doctor', '--model-id', id,
      '--model-dir', path.join(registration.modelsRoot, registry.models[id].directory),
      '--gemma-dir', path.join(registration.modelsRoot, registry.gemma.directory)
    ], environment, `LTX offline preflight failed for ${id}. Check the pinned MLX packages and runtime revision.`);
  }
}

function register(settings, args, environment) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      python: { type: 'string' }, 'models-root': { type: 'string' }, model: { type: 'string', multiple: true }
    } }));
  } catch { throw new Error(usage); }
  const registration = { version: 1, pythonExecutable: values.python, modelsRoot: values['models-root'],
    modelIds: values.model || [registry.defaultModel] };
  if (!validRegistration(registration)) throw new Error(usage);
  if (managedJob(settings)) throw new Error('Stop managed LTX before changing its registration.');
  checkPrepared(registration, environment);
  serviceToken(settings.root, { create: true });
  const temporary = path.join(settings.root, `.installation-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(registration) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, settings.installation);
  } finally { rmSync(temporary, { force: true }); }
  console.log(`Registered offline LTX models: ${registration.modelIds.join(', ')}`);
}

export async function ltxHealth(settings, pid, modelIds, { fetchImpl = fetch } = {}) {
  if (!pid) return null;
  const token = serviceToken(settings.root);
  try {
    const response = await fetchImpl(settings.origin + '/health', {
      headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    if (body.provider !== registry.provider || body.protocolVersion !== registry.protocolVersion ||
        body.workspaceId !== settings.id || body.pid !== pid || body.status !== 'ready' || !Array.isArray(body.data)) return null;
    const ready = modelIds.every(id => body.data.some(row =>
      row?.id === id && row.revision === registry.models[id].revision && row.status === 'ready'));
    return ready ? { pid, models: modelIds } : null;
  } catch { return null; }
}

export async function runLtxCommand(args, directory, env = process.env) {
  const [command, ...options] = args;
  if (!command || (!options.length && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (command !== 'register' && (options.length || !['start', 'stop', 'restart', 'health'].includes(command))) throw new Error(usage);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('LTX requires Apple Silicon macOS.');
  const settings = ltxSettings(directory, env);
  const environment = runtimeEnvironment(settings, env);
  if (command === 'register') return register(settings, options, environment);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock LTX stopped.');
    return;
  }
  const registration = readLtxRegistration(settings.installation);
  const probe = pid => ltxHealth(settings, pid, registration.modelIds);
  let ready;
  if (command === 'health') {
    ready = await probe(managedJob(settings)?.pid);
  } else {
    serviceToken(settings.root);
    checkPrepared(registration, environment);
    const source = stageSources(settings.root, path.dirname(import.meta.dirname), [
      'ltx/server.mjs', 'ltx/installation.mjs', 'ltx/models.json', 'ltx/worker.py', 'ltx/memory.py', 'service-settings.mjs'
    ]);
    if (command === 'restart') await stopLaunchAgent(settings);
    ready = await startLaunchAgent(settings, {
      args: [process.execPath, path.join(source, 'ltx/server.mjs'), settings.root, String(settings.port), settings.id],
      env: environment, probe
    });
  }
  if (!ready) throw new Error('The Model Dock LTX runtime is not healthy for the registered models.');
  console.log(`Model Dock LTX ready at ${settings.origin} (PID ${ready.pid}). Models: ${ready.models.join(', ')}`);
}
