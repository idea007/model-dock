import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { managedJob, stageSources, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';
import { serviceSettings, serviceToken } from '../service-settings.mjs';

const usage = 'model-dock edge <setup|start|stop|restart|health>';
const worker = path.join(import.meta.dirname, 'speech.py');

function edgeSettings(directory, env) {
  const settings = serviceSettings(directory, { kind: 'edge', name: 'Edge TTS', defaultPort: 8018 }, env);
  return { ...settings, python: path.join(settings.root, 'venv', 'bin', 'python') };
}

function edgeEnvironment(env) {
  const proxy = env.MODEL_DOCK_EDGE_PROXY?.trim();
  if (!proxy) return {};
  let url;
  try { url = new URL(proxy); } catch { /* invalid proxy */ }
  if (!['http:', 'https:'].includes(url?.protocol) || !url.hostname ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('MODEL_DOCK_EDGE_PROXY must be an HTTP or HTTPS proxy URL.');
  return { MODEL_DOCK_EDGE_PROXY: proxy };
}

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'ignore', timeout: 180_000 });
  if (result.error || result.status !== 0) throw new Error('Edge TTS preparation failed. Check Python, package access and the pinned dependencies.');
}

function setup(settings, env) {
  serviceToken(settings.root, { create: true });
  if (!existsSync(settings.python)) {
    run(env.MODEL_DOCK_EDGE_PYTHON || 'python3', ['-m', 'venv', path.join(settings.root, 'venv')]);
  }
  const requirements = path.join(import.meta.dirname, 'requirements.txt');
  if (spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0) {
    run('uv', ['pip', 'install', '--python', settings.python, '-r', requirements]);
  } else {
    run(settings.python, ['-m', 'pip', 'install', '-r', requirements]);
  }
  run(settings.python, [worker, 'check']);
  console.log('Model Dock Edge TTS dependencies are ready.');
}

async function edgeHealth(settings, pid) {
  if (!pid) return null;
  const token = serviceToken(settings.root);
  try {
    const response = await fetch(settings.origin + '/health', {
      headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    return body.ready === true && body.provider === 'edge-tts' && body.model === 'edge-tts' &&
      body.workspaceId === settings.id && body.pid === pid ? { pid } : null;
  } catch { return null; }
}

export async function runEdgeCommand(args, directory, env = process.env) {
  const [command] = args;
  if (!command || (args.length === 1 && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || !['setup', 'start', 'stop', 'restart', 'health'].includes(command)) throw new Error(usage);
  if (process.platform !== 'darwin') throw new Error('The managed Edge TTS runtime requires macOS.');
  const settings = edgeSettings(directory, env);
  if (command === 'setup') return setup(settings, env);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock Edge TTS stopped.');
    return;
  }
  let ready;
  if (command === 'health') {
    ready = await edgeHealth(settings, managedJob(settings)?.pid);
  } else {
    const environment = edgeEnvironment(env);
    serviceToken(settings.root);
    run(settings.python, [worker, 'check']);
    const source = stageSources(settings.root, path.dirname(import.meta.dirname), [
      'edge/server.mjs', 'edge/speech.py', 'service-settings.mjs'
    ]);
    if (command === 'restart') await stopLaunchAgent(settings);
    ready = await startLaunchAgent(settings, {
      args: [process.execPath, path.join(source, 'edge/server.mjs'), settings.root, String(settings.port), settings.id],
      env: environment, probe: pid => edgeHealth(settings, pid)
    });
  }
  if (!ready) throw new Error('The Model Dock Edge TTS runtime is not healthy.');
  console.log(`Model Dock Edge TTS ready at ${settings.origin} (PID ${ready.pid}).`);
}
