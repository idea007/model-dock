import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function serviceSettings(directory, { kind, name, defaultPort }, env) {
  const prefix = `MODEL_DOCK_${kind.toUpperCase()}`;
  const runtime = env[`${prefix}_RUNTIME_DIR`];
  if (runtime && !path.isAbsolute(runtime)) throw new Error(`${prefix}_RUNTIME_DIR must be an absolute path.`);
  const port = Number(env[`${prefix}_PORT`] || defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${prefix}_PORT must be an integer from 1024 to 65535.`);
  }
  const root = path.resolve(runtime || path.join(directory, 'runtimes', kind));
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return { root, id, port, origin: `http://127.0.0.1:${port}`, name,
    label: `com.model-dock.${kind}.${id}`, plist: path.join(root, `${kind}.plist`), logName: 'service.stderr.log' };
}

export function serviceToken(root, { create = false } = {}) {
  const file = path.join(root, 'service-token');
  if (create) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('The runtime service token file is missing or lacks private permissions.');
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('The runtime service token is invalid.');
  return token;
}
