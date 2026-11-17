import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { GatewayError, SCHEMA_VERSION } from '../protocol/index.mjs';
import { apiCredentialName, isApiConnection, providerUrl, validateMfluxToken } from './api-credentials.mjs';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function equalSecret(value, expectedHash) {
  return typeof value === 'string' && typeof expectedHash === 'string' && expectedHash.length === 64 && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expectedHash));
}
export const newToken = prefix => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

export async function writePrivateJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export class Store {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); this.queue = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    this.lockFile = path.join(this.directory, 'server.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        this.lock = await fs.open(this.lockFile, 'wx', 0o600);
        await this.lock.writeFile(JSON.stringify({ pid: process.pid })); break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt > 0) throw new Error('Data directory is locked by another gateway.');
        const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
        try { process.kill(lock.pid, 0); throw new Error('Data directory is already in use.'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        await fs.unlink(this.lockFile);
      }
    }
    try {
      const existingState = await fs.stat(this.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (existingState) {
        for (const name of ['master.key', 'admin.token']) {
          await fs.access(path.join(this.directory, name)).catch(() => { throw new Error(`Missing ${name}. Restore the matching private data backup; credentials will not be regenerated.`); });
        }
      }
      this.key = await this.#secretFile('master.key', () => randomBytes(32).toString('base64'));
      this.adminToken = await this.#secretFile('admin.token', () => newToken('md_admin'));
      this.key = Buffer.from(this.key, 'base64');
      if (this.key.length !== 32) throw new Error('Invalid master key. Restore the matching key; do not overwrite state.');
      try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Cannot read state.json. Restore a valid backup.');
        this.state = { schemaVersion: SCHEMA_VERSION, revision: 0, apiCredentials: [], connections: [], models: [], routes: [], keys: [] };
        await writePrivateJson(this.file, this.state);
      }
      if (![1, 2, 3, SCHEMA_VERSION].includes(this.state.schemaVersion) || !Number.isSafeInteger(this.state.revision)
        || !['connections', 'models', 'routes', 'keys'].every(key => Array.isArray(this.state[key]))
        || this.state.pools !== undefined && !Array.isArray(this.state.pools)) throw new Error('Unsupported or damaged state schema.');
      for (const connection of this.state.connections) if (connection.secret) this.decrypt(connection.secret);
      if (this.state.schemaVersion < SCHEMA_VERSION) await this.#migrateApiCredentials();
      else this.#validateApiCredentials(this.state);
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async #migrateApiCredentials() {
    const hasCredentialStore = this.state.schemaVersion === 3;
    if (hasCredentialStore) this.#validateApiCredentials(this.state);
    const current = hasCredentialStore ? this.state.apiCredentials : [];
    const ids = new Set(current.map(credential => credential.id));
    const groups = new Map(current.filter(credential => credential.secret)
      .map(credential => [this.#credentialIdentity(credential), { id: credential.id }]));
    const additions = [];
    const connections = this.state.connections.map(connection => {
      if (hasCredentialStore ? connection.type !== 'mflux' : !isApiConnection(connection)) return connection;
      const { secret, ...linked } = connection;
      // Legacy API rows with no key keep their own identities.
      const key = secret ? this.#credentialIdentity(connection) : connection.id;
      let group = groups.get(key);
      if (!group) {
        const id = ids.has(connection.id) ? newId('cred') : connection.id;
        group = { id, sources: [] };
        ids.add(id);
        groups.set(key, group);
        additions.push(group);
      }
      group.sources?.push(connection);
      return { ...linked, credentialId: group.id };
    });
    const newCredentials = additions.map(({ id, sources }) => {
      const { baseUrl, secret } = sources[0];
      return { id, baseUrl, name: apiCredentialName(sources), secret: secret ?? null };
    });
    const migrated = { ...this.state, schemaVersion: SCHEMA_VERSION, revision: this.state.revision + 1,
      connections, apiCredentials: [...current, ...newCredentials] };
    this.#validateApiCredentials(migrated);
    const backup = path.join(this.directory, `state.v${this.state.schemaVersion}.${randomUUID()}.backup.json`);
    await fs.writeFile(backup, `${JSON.stringify(this.state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writePrivateJson(this.file, migrated);
    this.state = migrated;
  }
  #credentialIdentity({ baseUrl, secret }) {
    return `${providerUrl(baseUrl).origin}\0${digest(this.decrypt(secret))}`;
  }
  #validateApiCredentials(state) {
    const invalid = () => { throw new Error('Unsupported or damaged API credential configuration.'); };
    if (!Array.isArray(state.apiCredentials)) invalid();
    const credentials = new Map();
    for (const credential of state.apiCredentials) {
      if (!credential || typeof credential.id !== 'string' || !credential.id || credentials.has(credential.id)
        || typeof credential.name !== 'string' || !credential.name.trim()) invalid();
      credentials.set(credential.id, { origin: providerUrl(credential.baseUrl).origin, secret: credential.secret });
      if (credential.secret) this.decrypt(credential.secret);
    }
    for (const connection of state.connections.filter(isApiConnection)) {
      if (state.schemaVersion === 3 && connection.type === 'mflux') continue;
      const credential = credentials.get(connection.credentialId);
      if (connection.secret || credential?.origin !== providerUrl(connection.baseUrl).origin) invalid();
      if (connection.type === 'mflux') validateMfluxToken(this.decrypt(credential.secret));
    }
  }
  async #secretFile(name, create) {
    const file = path.join(this.directory, name);
    try { await fs.writeFile(file, `${create()}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await fs.chmod(file, 0o600);
    return (await fs.readFile(file, 'utf8')).trim();
  }
  encrypt(secret) {
    if (!secret) return null;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
  }
  decrypt(secret) {
    if (!secret) return '';
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8');
  }
  connectionKey(connection, state = this.state) {
    if (!isApiConnection(connection)) return connection.secret;
    const credential = state.apiCredentials.find(item => item.id === connection.credentialId);
    if (!credential || new URL(credential.baseUrl).origin !== new URL(connection.baseUrl).origin) {
      throw new GatewayError('The connection requires a saved credential for its origin.', 409, 'credential_unavailable');
    }
    return credential.secret;
  }
  read() { return structuredClone(this.state); }
  mutate(revision, operation) {
    const result = this.queue.then(async () => {
      if (!Number.isSafeInteger(revision) || revision !== this.state.revision) throw new GatewayError('Settings changed. Refresh and try again.', 409, 'revision_conflict');
      const next = this.read(); const value = operation(next);
      if (value?.then) throw new Error('State mutations must be synchronous.');
      next.revision += 1; await writePrivateJson(this.file, next); this.state = next; return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  async close() {
    await this.queue;
    if (this.lock) { await this.lock.close(); this.lock = null; await fs.unlink(this.lockFile).catch(() => {}); }
  }
}
