import fs from 'node:fs/promises';
import path from 'node:path';
import { GatewayError, exact } from '../protocol/index.mjs';
import { digest, writePrivateJson } from './store.mjs';

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isNativeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const busy = () => new GatewayError('Another request is using this Codex session.', 409, 'session_busy', null, { retryAfter: '1' });
const invalid = () => new GatewayError('Invalid Codex session.', 400, 'invalid_request', 'model_dock_session');
const damaged = () => new GatewayError('The Codex session index is unavailable.', 503, 'session_index_unavailable');

export function validateCodexSession(value) {
  if (value === undefined) return null;
  exact(value, ['id', 'parent_id', 'mode']);
  if (!isHash(value.id) || value.parent_id !== undefined && (!isHash(value.parent_id) || value.id === value.parent_id) ||
      value.mode !== undefined && value.mode !== 'snapshot') throw invalid();
  return value;
}

export function scopeCodexSession(principal, deployment, value) {
  const scope = id => digest(JSON.stringify([principal.id, deployment, id]));
  return { id: scope(value.id), parentId: value.parent_id && scope(value.parent_id), mode: value.mode };
}

const validTurn = row => isHash(row?.requestHash) && isNativeId(row.threadId) && (row.turnId == null || isNativeId(row.turnId));

export class CodexSessions {
  #active = new Set();
  #unwritten = new Set();
  #directoryReady;
  #indexQueue = Promise.resolve();

  constructor(directory) { this.directory = path.join(directory, 'codex-sessions'); }

  async #open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
  }
  #file(id) { return path.join(this.directory, `${id}.json`); }
  async read(id) {
    if (!isHash(id)) return null;
    try {
      const file = this.#file(id);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 512_000) throw damaged();
      const row = JSON.parse(await fs.readFile(file, 'utf8'));
      if (row.version !== 1 || !validTurn(row) || !isHash(row.compatibility) || !isHash(row.instructionsHash) ||
          !Array.isArray(row.hashes) || row.hashes.length > 2049 || row.hashes.some(hash => !isHash(hash)) ||
          !['pending', 'complete', 'failed', 'handoff'].includes(row.status) || !Number.isSafeInteger(row.updatedAt) ||
          !Array.isArray(row.recent) || row.recent.length > 32 || row.recent.some(turn => !validTurn(turn) || !isNativeId(turn.turnId))) throw damaged();
      return row;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw damaged();
    }
  }
  async #makeRoom() {
    const protectedIds = new Set(this.#active);
    const reservations = [...this.#unwritten];
    const files = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const rows = [];
    for (const file of files) {
      const id = file.slice(0, -5), row = await this.read(id);
      if (row) rows.push({ id, row });
    }
    const indexedIds = new Set(rows.map(({ id }) => id));
    let retained = rows.length;
    for (const id of reservations) {
      // A reserved record may have been written after readdir, then released.
      if (!indexedIds.has(id) && (this.#unwritten.has(id) || await this.read(id))) retained++;
    }
    const cutoff = Date.now() - 30 * 86400_000;
    for (const { id, row } of rows.sort((a, b) => a.row.updatedAt - b.row.updatedAt)) {
      if (protectedIds.has(id) || this.#active.has(id) || row.status === 'pending' || (retained < 512 && row.updatedAt >= cutoff)) continue;
      await fs.unlink(this.#file(id));
      retained--;
    }
    if (retained >= 512) throw busy();
  }
  async acquire(id) {
    if (!isHash(id)) throw invalid();
    if (this.#active.has(id)) throw busy();
    this.#active.add(id);
    try {
      this.#directoryReady ||= this.#open().catch(error => { this.#directoryReady = null; throw error; });
      await this.#directoryReady;
      const indexed = this.#indexQueue.then(async () => {
        const row = await this.read(id);
        if (!row) {
          await this.#makeRoom();
          this.#unwritten.add(id);
        }
        return row;
      });
      this.#indexQueue = indexed.catch(() => {});
      const row = await indexed;
      return { row, write: async record => {
        const next = { ...record, version: 1, updatedAt: Date.now() };
        try { await writePrivateJson(this.#file(id), next); } catch { throw damaged(); }
        this.#unwritten.delete(id);
        return next;
      }, release: () => {
        this.#unwritten.delete(id);
        this.#active.delete(id);
      } };
    } catch (error) { this.#active.delete(id); throw error; }
  }
}
