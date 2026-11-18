import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { managedJob, startLaunchAgent, stopLaunchAgent } from '../launch-agent.mjs';
import { serviceSettings } from '../service-settings.mjs';

const usage = 'model-dock ollama <register|start|stop|restart|health>\n' +
  'model-dock ollama register --executable <absolute file> --models-root <absolute directory> --model <id> --digest <sha256> --dimensions <n>';

function ollamaSettings(directory, env) {
  const settings = serviceSettings(directory, { kind: 'ollama', name: 'Ollama', defaultPort: 7734 }, env);
  return { ...settings, logName: null, installation: path.join(settings.root, 'installation.json') };
}

export function validOllamaRegistration(value) {
  return value?.version === 1 && [value.executable, value.modelsRoot].every(item =>
    typeof item === 'string' && path.isAbsolute(item)) &&
    typeof value.model === 'string' && /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*(?::[A-Za-z0-9_.-]+)?$/.test(value.model) &&
    typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) && Number.isInteger(value.dimensions) &&
    value.dimensions >= 1 && value.dimensions <= 8192;
}

function readRegistration(settings) {
  try {
    const info = lstatSync(settings.installation);
    if (info.isFile() && (info.mode & 0o077) === 0) {
      const stored = JSON.parse(readFileSync(settings.installation, 'utf8'));
      if (validOllamaRegistration(stored)) return stored;
    }
  } catch { /* missing or invalid registration */ }
  throw new Error('Ollama registration is missing or invalid. Run model-dock ollama register.');
}

function checkPaths(registration) {
  try {
    accessSync(registration.executable, constants.X_OK);
    if (statSync(registration.executable).isFile() && statSync(registration.modelsRoot).isDirectory()) return;
  } catch { /* missing executable or model store */ }
  throw new Error('Ollama requires an installed executable and a prepared model directory.');
}

function register(settings, args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      executable: { type: 'string' }, 'models-root': { type: 'string' }, model: { type: 'string' },
      digest: { type: 'string' }, dimensions: { type: 'string' }
    } }));
  } catch { throw new Error(usage); }
  const registration = { version: 1, executable: values.executable, modelsRoot: values['models-root'],
    model: values.model, digest: values.digest, dimensions: /^\d+$/.test(values.dimensions || '') ? Number(values.dimensions) : 0 };
  if (!validOllamaRegistration(registration)) throw new Error(usage);
  if (managedJob(settings)) throw new Error('Stop managed Ollama before changing its registration.');
  checkPaths(registration);
  mkdirSync(settings.root, { recursive: true, mode: 0o700 });
  const temporary = path.join(settings.root, `.installation-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(registration) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, settings.installation);
  } finally { rmSync(temporary, { force: true }); }
  console.log(`Registered Ollama embedding model ${registration.model} (${registration.dimensions} dimensions).`);
}

function ownsLoopbackListener(pid, port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'],
    { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 && result.stdout.split('\n').includes(`n127.0.0.1:${port}`);
}

export async function ollamaHealth(settings, pid, expected, { fetchImpl = fetch, ownsListener = ownsLoopbackListener } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !ownsListener(pid, settings.port)) return null;
  const request = async (endpoint, init) => {
    const response = await fetchImpl(settings.origin + endpoint, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    return response.json();
  };
  try {
    const tags = await request('/api/tags');
    if (!Array.isArray(tags?.models) || !tags.models.some(row =>
      (row?.name === expected.model || row?.model === expected.model) && row.digest === expected.digest)) return null;
    const info = await request('/api/show', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: expected.model }) });
    if (!Array.isArray(info?.capabilities) || !info.capabilities.includes('embedding') ||
        !Object.entries(info.model_info || {}).some(([name, value]) =>
          name.endsWith('.embedding_length') && value === expected.dimensions)) return null;
    return { pid, model: expected.model, dimensions: expected.dimensions };
  } catch { return null; }
}

export async function runOllamaCommand(args, directory, env = process.env) {
  const [command, ...options] = args;
  if (!command || (!options.length && ['--help', '-h', 'help'].includes(command))) {
    console.log(usage);
    return;
  }
  if (command !== 'register' && (options.length || !['start', 'stop', 'restart', 'health'].includes(command))) throw new Error(usage);
  if (process.platform !== 'darwin') throw new Error('The managed Ollama runtime requires macOS.');
  const settings = ollamaSettings(directory, env);
  if (command === 'register') return register(settings, options);
  if (command === 'stop') {
    await stopLaunchAgent(settings);
    console.log('Model Dock Ollama stopped.');
    return;
  }
  const registration = readRegistration(settings);
  const probe = pid => ollamaHealth(settings, pid, registration);
  let ready;
  if (command === 'health') {
    ready = await probe(managedJob(settings)?.pid);
  } else {
    checkPaths(registration);
    if (command === 'restart') await stopLaunchAgent(settings);
    ready = await startLaunchAgent(settings, {
      args: [registration.executable, 'serve'],
      env: { OLLAMA_HOST: `127.0.0.1:${settings.port}`, OLLAMA_MODELS: registration.modelsRoot,
        OLLAMA_NO_CLOUD: '1', OLLAMA_NOPRUNE: '1' }, probe
    });
  }
  if (!ready) throw new Error('The Model Dock Ollama runtime did not confirm the registered model digest and dimensions.');
  console.log(`Model Dock Ollama ready at ${settings.origin} (PID ${ready.pid}). ${ready.model}, ${ready.dimensions} dimensions.`);
}
