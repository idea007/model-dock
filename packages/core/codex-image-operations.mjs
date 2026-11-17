import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './store.mjs';
import { GatewayError } from '../protocol/index.mjs';

const route = '/integrations/codex-image-store';
const sizes = { '1:1': '2048x2048', '4:5': '1792x2240', '9:16': '1512x2688', '16:9': '2560x1440' };
const invalid = () => new GatewayError('An operation_id must be 64 lowercase hexadecimal characters.', 422, 'CODEX_IMAGE_OPERATION_INVALID');
const missing = () => new GatewayError('Image operation not found.', 404, 'CODEX_IMAGE_OPERATION_NOT_FOUND');
const unavailable = () => new GatewayError('The project image store is unavailable.', 503, 'CODEX_IMAGE_STORE_UNAVAILABLE');
const conflict = () => new GatewayError('The image operation already has different input.', 409, 'CODEX_IMAGE_OPERATION_CONFLICT');
const terminalCodes = new Map([
  ['codex_auth_required', 'CODEX_AUTH_REQUIRED'], ['codex_rate_limited', 'CODEX_RATE_LIMITED'],
  ['codex_image_unavailable', 'CODEX_IMAGE_MODEL_UNAVAILABLE'],
  ['codex_image_result_missing', 'CODEX_IMAGE_RESULT_MISSING']
]);
const terminal = row => ['succeeded', 'failed'].includes(row.status);

export async function openCodexImageStores(directory, fetchImpl = fetch) {
  let values;
  try {
    const file = path.join(directory, 'codex-image-stores.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64_000 || process.platform !== 'win32' && (stat.mode & 0o077)) throw unavailable();
    values = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error('Cannot read the Model Dock Codex image stores file.');
  }
  const stores = new Map(), origins = new Set();
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid Codex image stores configuration.');
  for (const [id, entry] of Object.entries(values)) {
    if (!/^key_[a-f0-9]{16}$/.test(id) || typeof entry?.origin !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(entry.origin) ||
        typeof entry.token !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(entry.token)) throw new Error('Invalid Codex image store configuration.');
    let origin;
    try { origin = new URL(entry.origin).origin; } catch { throw new Error('Invalid Codex image store origin.'); }
    if (origins.has(origin)) throw new Error('Each image store must belong to a single Model Dock project.');
    origins.add(origin);
    stores.set(id, createRemoteImageStore(origin, entry.token, fetchImpl));
  }
  return stores;
}

function createRemoteImageStore(origin, token, fetchImpl) {
  return async (action, fields = {}) => {
    let response, value;
    try {
      response = await fetchImpl(origin + route, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...fields })
      });
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 41 * 1024 * 1024) throw unavailable();
        chunks.push(chunk);
      }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw unavailable(); }
    if (!response.ok || value?.ok !== true) {
      if (/^CODEX_[A-Z0-9_]{1,100}$/.test(value?.code || '') && response.status >= 400) {
        throw new GatewayError('The project image store rejected the operation.', response.status, value.code);
      }
      throw unavailable();
    }
    return value.result;
  };
}

function publish(row) {
  return { id: row.id, status: row.status, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
    phase: row.status === 'succeeded' ? 'completed' : row.status === 'failed' ? 'failed' : row.status === 'running' ? 'generating_image' : 'reconciling',
    recoverable: row.status === 'outcome_unknown',
    nextAction: row.status === 'succeeded' ? 'fetch_result' : row.status === 'failed' ? 'correct_request' : 'query_same_operation' };
}

export class CodexImageOperations {
  #active = new Map();
  #submissions = new Map();
  #recoveries = new Map();
  #closing = false;

  constructor(stores, provider) {
    this.stores = stores;
    this.provider = provider;
  }
  has(principal) { return this.stores.has(principal.id); }
  #target(principal, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw invalid();
    const store = this.stores.get(principal.id);
    if (!store) throw missing();
    return { store, key: `${principal.id}/${id}` };
  }
  async submit(principal, id, input, dispatch) {
    const { store, key } = this.#target(principal, id);
    if (this.#closing) throw unavailable();
    while (this.#submissions.has(key)) await this.#submissions.get(key);
    const unlocked = Promise.withResolvers();
    this.#submissions.set(key, unlocked.promise);
    try {
      const legacy = { prompt: input.prompt, referenceImages: input.references, size: sizes[input.aspectRatio || '1:1'] };
      const hash = digest(JSON.stringify({ model: input.model, background: input.background || 'auto', ...legacy }));
      const current = await store('read', { id });
      if (current) {
        const sameLegacyInput = input.model.endsWith('/codex-imagegen') && (!input.background || input.background === 'auto') &&
          current.input_hash === digest(JSON.stringify(legacy));
        if (current.input_hash !== hash && !sameLegacyInput) throw conflict();
        return { ...await this.inspect(principal, id), reused: true };
      }
      if (this.#closing) throw unavailable();
      const controller = new AbortController(), ready = Promise.withResolvers();
      let claimed = false, timer;
      let saved;
      const save = result => saved ||= store('save', { id, result: { b64Json: result.b64_json, usage: result.usage } })
        .catch(error => { saved = null; throw error; });
      const execution = { controller, task: null, save, lastRecoveryAt: 0 };
      execution.task = (async () => {
        try {
          await dispatch({
            signal: controller.signal,
            async start(timeoutMs) {
              const claim = await store('claim', { id, hash });
              if (!claim?.created) throw conflict();
              claimed = true;
              ready.resolve({ ...publish(claim.row), reused: false });
              timer = setTimeout(() => {
                store('markUnknown', { id, code: 'CODEX_IMAGE_GENERATION_TIMEOUT' }).catch(() => {});
              }, timeoutMs);
              timer.unref();
            },
            onIdentity: identity => store('recordIdentity', { id, identity }),
            save
          });
        } catch (error) {
          if (!claimed) ready.reject(error);
          else {
            const code = terminalCodes.get(error.code);
            const update = code ? ['markFailed', code] : ['markUnknown', controller.signal.aborted ? 'CODEX_REQUEST_ABORTED' : 'CODEX_IMAGE_GENERATION_UNKNOWN'];
            await store(update[0], { id, code: update[1] }).catch(() => {});
          }
        } finally {
          clearTimeout(timer);
          this.#active.delete(key);
        }
      })();
      this.#active.set(key, execution);
      return await ready.promise;
    } finally {
      this.#submissions.delete(key);
      unlocked.resolve();
    }
  }
  async inspect(principal, id) {
    const { store, key } = this.#target(principal, id);
    let row = await store('read', { id });
    if (!row) throw missing();
    const execution = this.#active.get(key);
    if (terminal(row) || execution && row.status === 'running') return publish(row);
    if (row.status === 'running') {
      await store('markUnknown', { id, code: 'CODEX_IMAGE_INTERRUPTED' });
      row = await store('read', { id });
    }
    if (row.status === 'outcome_unknown' && row.thread_id && this.provider?.recoverImage) {
      let recovering = this.#recoveries.get(key);
      if (!recovering) {
        if (execution && Date.now() - execution.lastRecoveryAt < 5_000) return publish(row);
        if (execution) execution.lastRecoveryAt = Date.now();
        recovering = (async () => {
          const { thread_id: threadId, turn_id: turnId } = row;
          try {
            const result = await this.provider.recoverImage({ threadId, turnId }, AbortSignal.timeout(10_000));
            if (result) {
              if (execution) await execution.save(result);
              else await store('save', { id, result: { b64Json: result.b64_json } });
            }
          } catch (error) {
            const code = terminalCodes.get(error.code);
            if (code) await store('markFailed', { id, code });
          }
          return store('read', { id });
        })().finally(() => this.#recoveries.delete(key));
        this.#recoveries.set(key, recovering);
      }
      row = await recovering;
    }
    return publish(row);
  }
  async result(principal, id) {
    const { store } = this.#target(principal, id);
    if ((await this.inspect(principal, id)).status !== 'succeeded') {
      throw new GatewayError('The image result is not ready.', 409, 'CODEX_IMAGE_RESULT_PENDING');
    }
    const result = await store('result', { id });
    const encoded = result?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded.length) throw unavailable();
    return { created: Math.floor(Date.now() / 1000), data: [{ b64_json: encoded }], ...(result.usage && { usage: result.usage }) };
  }
  async cancel(principal, id) {
    const { key, store } = this.#target(principal, id);
    const row = await store('read', { id });
    if (!row) throw missing();
    if (terminal(row)) return publish(row);
    this.#active.get(key)?.controller.abort(new GatewayError('Image operation cancelled.', 499, 'request_cancelled'));
    await store('markUnknown', { id, code: 'CODEX_REQUEST_ABORTED' });
    return publish(await store('read', { id }));
  }
  async close() {
    this.#closing = true;
    for (const { controller } of this.#active.values()) controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
    await Promise.allSettled([...this.#active.values()].map(entry => entry.task));
  }
}
