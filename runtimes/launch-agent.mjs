import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function stageSources(root, sourceDirectory, files) {
  const sources = files.map(name => [name, readFileSync(path.join(sourceDirectory, name))]);
  const hash = createHash('sha256');
  for (const [name, source] of sources) hash.update(name).update('\0').update(source).update('\0');
  // A macOS login job may lack access to a checkout in a protected directory.
  const directory = path.join(root, 'code');
  const revision = path.join(directory, hash.digest('hex'));
  if (existsSync(revision)) return revision;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(directory, '.setup-'));
  try {
    for (const [name, source] of sources) {
      const target = path.join(staging, name);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, source, { mode: 0o600 });
    }
    try { renameSync(staging, revision); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return revision;
}

function launchctl(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 40_000 });
}

const domain = () => `gui/${process.getuid()}`;
const target = settings => `${domain()}/${settings.label}`;

export function managedJob(settings) {
  const result = launchctl(['print', target(settings)]);
  if (result.status !== 0) {
    if (result.stderr?.includes('Could not find service')) return null;
    throw new Error(`Cannot inspect the ${settings.name} LaunchAgent in the active macOS login.`);
  }
  if (!result.stdout.split('\n').some(line => line.trim() === 'path = ' + settings.plist)) {
    throw new Error(`The registered ${settings.name} job belongs to a different runtime directory.`);
  }
  return { pid: Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]) || null };
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plistString = value => '<string>' + xml(value) + '</string>';

function writeLaunchAgent(settings, args, env) {
  const errors = settings.logName ? path.join(settings.root, settings.logName) : '/dev/null';
  if (settings.logName) writeFileSync(errors, '', { flag: 'a', mode: 0o600 });
  const environment = Object.entries(env || {}).map(([key, value]) => `<key>${xml(key)}</key>${plistString(value)}`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${plistString(settings.label)}
  <key>ProgramArguments</key><array>${args.map(plistString).join('')}</array>
  <key>EnvironmentVariables</key><dict>${environment.join('')}</dict>
  <key>WorkingDirectory</key>${plistString(settings.root)}
  <key>StandardErrorPath</key>${plistString(errors)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
</dict></plist>
`;
  const temporary = path.join(settings.root, `.launch-agent-${randomUUID()}`);
  try {
    writeFileSync(temporary, plist, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, settings.plist);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await delay(250);
  } while (Date.now() < deadline);
  return null;
}

export async function stopLaunchAgent(settings) {
  if (!managedJob(settings)) return;
  const result = launchctl(['bootout', target(settings)]);
  if (result.status !== 0 && managedJob(settings)) throw new Error(`${settings.name} LaunchAgent could not be stopped.`);
  if (!await waitFor(async () => !managedJob(settings) && await portAvailable(settings.port), 30_000)) {
    throw new Error(`The ${settings.name} port did not become available after stopping the LaunchAgent.`);
  }
}

export async function startLaunchAgent(settings, { args, env, probe, timeoutMs = 30_000 }) {
  const registered = managedJob(settings);
  if (!registered) {
    if (!await portAvailable(settings.port)) throw new Error(`${settings.name} port ${settings.port} is already in use.`);
    writeLaunchAgent(settings, args, env);
    const result = launchctl(['bootstrap', domain(), settings.plist]);
    if (result.status !== 0 && !managedJob(settings)) throw new Error(`${settings.name} LaunchAgent could not be started.`);
  }
  const healthy = await waitFor(() => probe(managedJob(settings)?.pid), timeoutMs);
  if (!healthy) {
    if (!registered) await stopLaunchAgent(settings);
    throw new Error(`The Model Dock ${settings.name} runtime did not become healthy.`);
  }
  return healthy;
}
