import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { managedJob, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';

const sourceDirectory = import.meta.dirname;
const registry = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));
const usage = 'model-dock mflux <setup|preload|start|stop|restart|health> [--model <id>]';

export function mfluxSettings(directory, env = process.env) {
  const runtime = env.MODEL_DOCK_MFLUX_RUNTIME_DIR;
  if (runtime && !path.isAbsolute(runtime)) throw new Error('MODEL_DOCK_MFLUX_RUNTIME_DIR must be an absolute path.');
  const root = path.resolve(runtime || path.join(directory, 'runtimes', 'mflux'));
  const port = Number(env.MODEL_DOCK_MFLUX_PORT || 8016);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('MODEL_DOCK_MFLUX_PORT must be an integer from 1024 to 65535.');
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return {
    root, port, id, origin: `http://127.0.0.1:${port}`, models: path.join(root, 'models'),
    python: path.join(root, 'venv', 'bin', 'python'), tokenFile: path.join(root, 'service-token'),
    name: 'MFLUX', label: 'com.model-dock.mflux.' + id, plist: path.join(root, 'mflux.plist'), logName: 'service.stderr.log'
  };
}

function readServiceToken(file) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('MFLUX service token file is missing or lacks private permissions. Run model-dock mflux setup.');
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('MFLUX service token file is invalid.');
  return token;
}

function installedModels(settings) {
  return Object.entries(registry.models).filter(([, model]) => {
    const folder = path.join(settings.models, model.directory);
    try {
      return readFileSync(path.join(folder, '.ready'), 'utf8').trim() === model.revision &&
        registry.requiredFiles.every(name => existsSync(path.join(folder, name)));
    } catch { return false; }
  }).map(([id]) => id);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('MFLUX preparation command failed.');
}

function setup(settings, env) {
  mkdirSync(settings.root, { recursive: true, mode: 0o700 });
  if (!existsSync(settings.python)) {
    run(env.MODEL_DOCK_MFLUX_PYTHON || 'python3', ['-m', 'venv', path.dirname(path.dirname(settings.python))]);
  }
  const requirements = path.join(sourceDirectory, 'requirements.txt');
  if (spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0) {
    run('uv', ['pip', 'install', '--python', settings.python, '-r', requirements]);
  } else {
    run(settings.python, ['-m', 'pip', 'install', '-r', requirements]);
  }
  if (!lstatSync(settings.tokenFile, { throwIfNoEntry: false })) {
    writeFileSync(settings.tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  readServiceToken(settings.tokenFile);
  console.log('MFLUX dependencies are ready. Use model-dock mflux preload to prepare model weights.');
}

function preload(settings, modelId, env) {
  if (!existsSync(settings.python)) throw new Error('Run model-dock mflux setup first.');
  const model = registry.models[modelId];
  run(settings.python, ['-c', [
    'from huggingface_hub import snapshot_download',
    'from pathlib import Path',
    'import sys',
    'snapshot_download(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], max_workers=4)',
    "Path(sys.argv[3], '.ready').write_text(sys.argv[2])"
  ].join('\n'), model.repo, model.revision, path.join(settings.models, model.directory)], {
    env: { ...env, HF_HOME: path.join(settings.root, 'huggingface'), HF_HUB_OFFLINE: '0', TRANSFORMERS_OFFLINE: '0' }
  });
  console.log(`Prepared MFLUX model ${modelId}.`);
}

export async function mfluxHealth(settings, pid, { fetchImpl = fetch, modelId } = {}) {
  if (!pid) return null;
  const token = readServiceToken(settings.tokenFile);
  try {
    const response = await fetchImpl(settings.origin + '/health', {
      headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    if (body.provider !== 'local-mflux' || body.protocolVersion !== registry.protocolVersion ||
        body.workspaceId !== settings.id || body.pid !== pid || body.status !== 'ready' || !Array.isArray(body.data)) return null;
    const models = Object.entries(registry.models).filter(([id, model]) =>
      body.data.some(row => row?.id === id && row.revision === model.revision && row.status === 'ready')
    ).map(([id]) => id);
    return models.length && (!modelId || models.includes(modelId)) ? { pid, models } : null;
  } catch { return null; }
}

function preparedModels(settings) {
  if (!existsSync(settings.python)) throw new Error('Run model-dock mflux setup first.');
  const expected = installedModels(settings);
  if (!expected.length) throw new Error('Run model-dock mflux preload before starting MFLUX.');
  readServiceToken(settings.tokenFile);
  return expected;
}

export async function runMfluxCommand(args, directory, env = process.env) {
  const [command, flag, modelId] = args;
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (!['setup', 'preload', 'start', 'stop', 'restart', 'health'].includes(command) ||
      (args.length !== 1 && (args.length !== 3 || flag !== '--model' ||
        !['preload', 'health'].includes(command) || !Object.hasOwn(registry.models, modelId)))) {
    throw new Error(usage);
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MFLUX requires Apple Silicon macOS.');
  const settings = mfluxSettings(directory, env);
  if (command === 'setup') return setup(settings, env);
  if (command === 'preload') return preload(settings, modelId || registry.defaultModel, env);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock MFLUX stopped.');
    return;
  }
  let ready;
  if (command === 'health') {
    ready = await mfluxHealth(settings, managedJob(settings)?.pid, { modelId });
  } else {
    const expected = preparedModels(settings);
    if (command === 'restart') await stopLaunchAgent(settings);
    ready = await startLaunchAgent(settings, {
      args: [settings.python, path.join(sourceDirectory, 'server.py'), '--port', settings.port,
        '--runtime-dir', settings.root, '--workspace-id', settings.id],
      probe: async pid => {
        const result = await mfluxHealth(settings, pid);
        return result && expected.every(model => result.models.includes(model)) ? result : null;
      }
    });
  }
  if (!ready) throw new Error('The Model Dock MFLUX runtime is not healthy for the requested models.');
  console.log(`Model Dock MFLUX ready at ${settings.origin} (PID ${ready.pid}). Models: ${ready.models.join(', ')}`);
}
