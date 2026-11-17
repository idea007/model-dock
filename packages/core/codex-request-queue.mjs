import { GatewayError } from '../protocol/index.mjs';

export const connectionBusy = () => new GatewayError('This connection is at capacity. Retry after the active request finishes.', 429, 'connection_busy', null, { retryAfter: '2' });

const maxWaiting = 8;

export class CodexRequestQueue {
  #occupied = false;
  #waiting = new Map();

  constructor(waitMs) {
    this.waitMs = waitMs;
  }

  get waitingCount() {
    return this.#waiting.size;
  }

  acquire(id, signal, principalId, connectionId) {
    signal.throwIfAborted();
    if (!this.#occupied) {
      this.#occupied = true;
      return this.#release;
    }
    if (this.#waiting.size >= maxWaiting) throw connectionBusy();
    return new Promise((resolve, reject) => {
      const finish = error => {
        this.#waiting.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(this.#release);
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(connectionBusy()), this.waitMs);
      this.#waiting.set(id, { principalId, connectionId, finish });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  cancelMatching(matches, error) {
    for (const entry of this.#waiting.values()) {
      if (matches(entry)) entry.finish(error);
    }
  }

  #release = () => {
    const next = this.#waiting.values().next().value;
    if (next) next.finish();
    else this.#occupied = false;
  };
}
