import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { GatewayError, SCHEMA_VERSION } from '../protocol/index.mjs';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function equalSecret(value, expectedHash) {
  return typeof value === 'string' && typeof expectedHash === 'string' && expectedHash.length === 64 && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expectedHash));
}
export const newToken = prefix => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

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
        this.state = { schemaVersion: SCHEMA_VERSION, revision: 0, connections: [], models: [], routes: [], keys: [] };
        await this.#write(this.state);
      }
      if (![1, SCHEMA_VERSION].includes(this.state.schemaVersion) || !Number.isSafeInteger(this.state.revision) || !['connections', 'models', 'routes', 'keys'].every(key => Array.isArray(this.state[key]))) throw new Error('Unsupported or damaged state schema.');
      // Fail closed if encrypted state and the key no longer match.
      for (const connection of this.state.connections) if (connection.secret) this.decrypt(connection.secret);
      if (this.state.schemaVersion === 1) {
        // v2 adds optional reasoning policies and alias groups. Retain every v1
        // binding, credential and enabled flag, and back up before the atomic write.
        const backup = path.join(this.directory, `state.v1.${randomUUID()}.backup.json`);
        await fs.writeFile(backup, `${JSON.stringify(this.state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        const migrated = { ...this.state, schemaVersion: SCHEMA_VERSION, revision: this.state.revision + 1 };
        await this.#write(migrated); this.state = migrated;
      }
      return this;
    } catch (error) { await this.close(); throw error; }
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
  read() { return structuredClone(this.state); }
  mutate(revision, operation) {
    const result = this.queue.then(async () => {
      if (!Number.isSafeInteger(revision) || revision !== this.state.revision) throw new GatewayError('Settings changed. Refresh and try again.', 409, 'revision_conflict');
      const next = this.read(); const value = operation(next);
      if (value?.then) throw new Error('State mutations must be synchronous.');
      next.revision += 1; await this.#write(next); this.state = next; return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  async #write(state) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, this.file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async close() {
    await this.queue;
    if (this.lock) { await this.lock.close(); this.lock = null; await fs.unlink(this.lockFile).catch(() => {}); }
  }
}
