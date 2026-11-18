import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { managedJob, stageSources, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';

const whisperModel = 'mlx-community/whisper-base-asr-fp16';
const kokoroModels = ['8bit', '4bit', 'bf16'].map(variant => 'mlx-community/Kokoro-82M-' + variant);
const ttsPreloads = new Map([
  ...kokoroModels.map(model => [model, [model]]),
  ['mlx-community/MOSS-TTS-Nano-100M', ['mlx-community/MOSS-TTS-Nano-100M', 'mlx-community/MOSS-Audio-Tokenizer-Nano', whisperModel]],
  ...['0.6B', '1.7B'].map(size => {
    const model = 'mlx-community/Qwen3-TTS-12Hz-' + size + '-Base-8bit';
    return [model, [model, whisperModel]];
  })
]);
const serviceConfigs = {
  tts: { name: 'TTS', port: 7720, script: 'mlx-server.py', models: ttsPreloads },
  asr: { name: 'ASR', port: 7732, script: 'transcription-server.py', models: new Map([[whisperModel, [whisperModel]]]) }
};

export function audioSettings(service, directory, env = process.env) {
  const config = serviceConfigs[service];
  const runtime = env.MODEL_DOCK_MLX_AUDIO_RUNTIME_DIR;
  if (runtime && !path.isAbsolute(runtime)) throw new Error('MODEL_DOCK_MLX_AUDIO_RUNTIME_DIR must be an absolute path.');
  const root = path.resolve(runtime || path.join(directory, 'runtimes', 'mlx-audio'));
  const portVariable = 'MODEL_DOCK_' + config.name + '_PORT';
  const port = Number(env[portVariable] || config.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(portVariable + ' must be an integer from 1024 to 65535.');
  }
  const model = service === 'tts' ? env.MODEL_DOCK_TTS_MODEL || kokoroModels[0] : whisperModel;
  if (service === 'tts' && !kokoroModels.includes(model)) throw new Error('MODEL_DOCK_TTS_MODEL must select a supported Kokoro model.');
  const id = createHash('sha256').update(root).update('/' + service).digest('hex').slice(0, 24);
  return {
    ...config, root, port, model, id, origin: 'http://127.0.0.1:' + port,
    python: path.join(root, 'venv', 'bin', 'python'),
    label: 'com.model-dock.' + service + '.' + id,
    plist: path.join(root, service + '.plist'),
    logName: service + '.stderr.log'
  };
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('MLX Audio preparation command failed.');
}

function setup(settings, env) {
  mkdirSync(settings.root, { recursive: true, mode: 0o700 });
  if (!existsSync(settings.python)) {
    run(env.MODEL_DOCK_MLX_AUDIO_PYTHON || 'python3.12', ['-m', 'venv', path.dirname(path.dirname(settings.python))]);
  }
  run(settings.python, ['-m', 'pip', 'install', '-r', path.join(import.meta.dirname, 'requirements.txt')]);
  console.log('Shared MLX Audio dependencies are ready.');
}

function preload(settings, model, env) {
  run(settings.python, ['-c', [
    'import sys',
    'from huggingface_hub import snapshot_download',
    'for model in sys.argv[1:]:',
    '    snapshot_download(model)'
  ].join('\n'), ...settings.models.get(model)], {
    env: { ...env, HF_HOME: path.join(settings.root, 'huggingface'), HF_HUB_OFFLINE: '0', HF_HUB_DISABLE_XET: '1' }
  });
  console.log('Prepared MLX Audio model ' + model + '.');
}

export async function audioHealth(settings, pid, fetchImpl = fetch) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const response = await fetchImpl(settings.origin + '/health', {
      redirect: 'error', signal: AbortSignal.timeout(1500), headers: { connection: 'close' }
    });
    if (!response.ok) return null;
    const ready = await response.json();
    if (ready?.pid !== pid || ready.runtimeId !== settings.id || ready.provider !== 'mlx-audio' ||
        ready.model !== settings.model || ready.status !== 'ready' || ready.ready !== true) return null;
    return { pid, model: ready.model };
  } catch { return null; }
}

export async function runAudioCommand(service, args, directory, env = process.env) {
  const [command, flag, model] = args;
  const usage = 'model-dock ' + service + ' <setup|preload|start|stop|restart|health> [--model <id>]';
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (!['setup', 'preload', 'start', 'stop', 'restart', 'health'].includes(command) ||
      (args.length !== 1 && (command !== 'preload' || args.length !== 3 || flag !== '--model' ||
        !serviceConfigs[service].models.has(model)))) throw new Error(usage);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MLX Audio requires Apple Silicon macOS.');
  const settings = audioSettings(service, directory, env);
  if (command === 'setup') return setup(settings, env);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock ' + settings.name + ' stopped.');
    return;
  }
  let ready;
  if (command === 'health') {
    ready = await audioHealth(settings, managedJob(settings)?.pid);
  } else {
    if (!existsSync(settings.python)) throw new Error('Run model-dock ' + service + ' setup first.');
    if (command === 'preload') return preload(settings, model || settings.model, env);
    const files = readdirSync(import.meta.dirname).filter(name => name.endsWith('.py')).sort();
    const source = stageSources(settings.root, import.meta.dirname, files);
    if (command === 'restart') await stopLaunchAgent(settings);
    const launchEnvironment = {
      PATH: env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HF_HOME: path.join(settings.root, 'huggingface'),
      HF_HUB_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      MODEL_DOCK_RUNTIME_ID: settings.id
    };
    if (service === 'tts') Object.assign(launchEnvironment, {
      MODEL_DOCK_TTS_MODEL: settings.model,
      MODEL_DOCK_TTS_MOSS_WORKERS: env.MODEL_DOCK_TTS_MOSS_WORKERS || '2',
      MODEL_DOCK_TTS_MOSS_QUEUE: env.MODEL_DOCK_TTS_MOSS_QUEUE || '4',
      MODEL_DOCK_TTS_MOSS_IDLE_SECONDS: env.MODEL_DOCK_TTS_MOSS_IDLE_SECONDS || '60'
    });
    ready = await startLaunchAgent(settings, {
      args: [settings.python, path.join(source, settings.script), '--port', settings.port],
      env: launchEnvironment,
      probe: pid => audioHealth(settings, pid),
      timeoutMs: 90_000
    });
  }
  if (!ready) throw new Error('The Model Dock ' + settings.name + ' runtime is not healthy.');
  console.log('Model Dock ' + settings.name + ' ready at ' + settings.origin + ' (PID ' + ready.pid + '). Model: ' + ready.model);
}
