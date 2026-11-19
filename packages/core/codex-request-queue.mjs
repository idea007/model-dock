import { GatewayError } from '../protocol/index.mjs';

export const connectionBusy = () => new GatewayError('This connection is at capacity. Retry after the active request finishes.', 429, 'connection_busy', null, { retryAfter: '2' });

export const MAX_CODEX_CONCURRENCY = 16;
const maxWaiting = 8;

export class CodexRequestQueue {
  #active = 0;
  #connections = new Map();
  #waiting = new Map();

  constructor(waitMs, maxActive = 1) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > MAX_CODEX_CONCURRENCY) {
      throw new RangeError(`Codex concurrency must be an integer from 1 to ${MAX_CODEX_CONCURRENCY}.`);
    }
    this.waitMs = waitMs;
    this.maxActive = maxActive;
  }

  get waitingCount() {
    return this.#waiting.size;
  }

  acquire(id, signal, principalId, connectionId, limit = this.maxActive) {
    signal.throwIfAborted();
    if (!this.#waiting.size && this.#hasCapacity(connectionId, limit)) {
      return this.#reserve(connectionId);
    }
    if (!this.waitMs || this.#waiting.size >= maxWaiting) throw connectionBusy();
    return new Promise((resolve, reject) => {
      const finish = error => {
        this.#waiting.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(this.#reserve(connectionId));
      };
      const discard = error => {
        finish(error);
        this.#drain();
      };
      const abort = () => discard(signal.reason);
      const timer = setTimeout(() => discard(connectionBusy()), this.waitMs);
      this.#waiting.set(id, { principalId, connectionId, limit, finish });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  cancelMatching(matches, error) {
    for (const entry of this.#waiting.values()) {
      if (matches(entry)) entry.finish(error);
    }
    this.#drain();
  }

  #hasCapacity(connectionId, limit) {
    return this.#active < this.maxActive && (this.#connections.get(connectionId) || 0) < limit;
  }

  #reserve(connectionId) {
    this.#active++;
    this.#connections.set(connectionId, (this.#connections.get(connectionId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      const remaining = this.#connections.get(connectionId) - 1;
      if (remaining) this.#connections.set(connectionId, remaining);
      else this.#connections.delete(connectionId);
      this.#drain();
    };
  }

  #drain() {
    for (const entry of this.#waiting.values()) {
      if (!this.#hasCapacity(entry.connectionId, entry.limit)) break;
      entry.finish();
    }
  }
}
