import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { GatewayError } from '../../packages/protocol/index.mjs';
import { initialFeatures } from './features.mjs';

// Application-owned settings. The project key stays in this private backend file.
export class DemoStore {
  constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await fs.chmod(this.directory, 0o700);
    this.file = path.join(this.directory, 'client.json'); this.lockFile = path.join(this.directory, 'client.lock');
    for (let attempt = 0; ; attempt++) {
      try { this.lock = await fs.open(this.lockFile, 'wx', 0o600); await this.lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
      catch (error) {
        if (error.code !== 'EEXIST' || attempt) throw new Error('Demo data directory is already in use.');
        const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
        try { process.kill(lock.pid, 0); throw new Error('Demo data directory is already in use.'); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        await fs.unlink(this.lockFile);
      }
    }
    try {
      const existing = await fs.readFile(this.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const tokenFile = path.join(this.directory, 'access.token');
      if (existing) this.accessToken = (await fs.readFile(tokenFile, 'utf8')).trim();
      else {
        try { await fs.writeFile(tokenFile, `demo_local_${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        this.accessToken = (await fs.readFile(tokenFile, 'utf8')).trim();
      }
      if (!this.accessToken.startsWith('demo_local_')) throw new Error('Invalid demo access token. Restore its data directory.');
      this.state = existing ? JSON.parse(existing) : { schemaVersion: 1, revision: 0, connection: null, catalog: [], catalogError: '', models: [], routes: initialFeatures() };
      if (this.state.schemaVersion !== 1 || !Number.isSafeInteger(this.state.revision) || !['models', 'routes', 'catalog'].every(key => Array.isArray(this.state[key]))) throw new Error('Unsupported demo configuration.');
      if (!existing) await this.write(this.state);
      await fs.chmod(tokenFile, 0o600); await fs.chmod(this.file, 0o600);
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  read() { return structuredClone(this.state); }
  mutate(revision, fn) {
    const result = this.queue.then(async () => {
      if (revision !== this.state.revision) throw new GatewayError('应用设置已更新，请撤销更改后重新编辑。', 409, 'revision_conflict');
      const next = this.read(); const value = fn(next);
      if (value?.then) throw new Error('Mutations must be synchronous.');
      next.revision++; await this.write(next); this.state = next; return value;
    }); this.queue = result.catch(() => {}); return result;
  }
  async write(state) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, this.file); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async close() { await this.queue; if (this.lock) { await this.lock.close(); this.lock = null; await fs.unlink(this.lockFile).catch(() => {}); } }
}
