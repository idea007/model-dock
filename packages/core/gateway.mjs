import { GatewayError, exact, string, slug, validateChat } from '../protocol/index.mjs';
import { digest, equalSecret, newId, newToken } from './store.mjs';
import { createProviders } from '../providers/index.mjs';

const missing = kind => { throw new GatewayError(`${kind} not found.`, 404, 'not_found'); };
const activeModel = (state, model) => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);
export function normalizeConnection(input, previous) {
  exact(input, ['revision', 'name', 'type', 'baseUrl', 'apiKey', 'enabled', 'maxConcurrency', 'timeoutSeconds']);
  const type = previous?.type || input.type;
  if (!['openai', 'ollama', 'codex'].includes(type) || previous && input.type !== undefined && input.type !== previous.type) throw new GatewayError('Invalid provider type.');
  const connection = { ...previous, id: previous?.id || newId('conn'), type,
    name: input.name === undefined && previous ? previous.name : string(input.name, 'connection name', 100),
    enabled: input.enabled ?? previous?.enabled ?? true,
    maxConcurrency: input.maxConcurrency ?? previous?.maxConcurrency ?? (type === 'codex' ? 1 : 2),
    timeoutSeconds: input.timeoutSeconds ?? previous?.timeoutSeconds ?? 600,
    status: 'unknown', checkedAt: null, errorCode: null };
  if (typeof connection.enabled !== 'boolean') throw new GatewayError('enabled must be boolean.');
  if (!Number.isInteger(connection.maxConcurrency) || connection.maxConcurrency < 1 || connection.maxConcurrency > (type === 'codex' ? 1 : 16)) throw new GatewayError('Invalid concurrency limit. Codex permits one active request.');
  if (!Number.isInteger(connection.timeoutSeconds) || connection.timeoutSeconds < 5 || connection.timeoutSeconds > 1800) throw new GatewayError('timeoutSeconds must be between 5 and 1800.');
  if (type === 'codex') {
    if (input.baseUrl || input.apiKey) throw new GatewayError('Codex uses the locally authenticated CLI; do not submit its tokens.');
    connection.baseUrl = '';
  } else {
    const value = input.baseUrl ?? previous?.baseUrl ?? (type === 'ollama' ? 'http://127.0.0.1:11434' : '');
    let url; try { url = new URL(value); } catch { throw new GatewayError('Invalid provider base URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && local)) throw new GatewayError('Use HTTPS, or HTTP on loopback. Credentials belong in the API key field.');
    connection.baseUrl = url.toString().replace(/\/+$/, '');
  }
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16000 || /[\r\n]/.test(input.apiKey))) throw new GatewayError('Invalid API key.');
  return connection;
}

export class Gateway {
  constructor(store, options = {}) {
    this.store = store; this.providers = options.providers || createProviders(options);
    this.active = new Map(); this.history = []; this.discovering = new Set();
  }
  authenticate(token, adminOnly = false) {
    if (equalSecret(token, digest(this.store.adminToken))) return { admin: true, id: 'admin', name: 'Local administrator' };
    if (!adminOnly && token) {
      const key = this.store.read().keys.find(item => equalSecret(token, item.hash));
      if (key) return { admin: false, id: key.id, name: key.name };
    }
    throw new GatewayError('A valid access token is required.', 401, 'unauthorized');
  }
  keyAllows(principal, name) {
    if (principal.admin) return true;
    const key = this.store.read().keys.find(item => item.id === principal.id);
    return Boolean(key && (key.models.includes('*') || key.models.includes(name)));
  }
  catalog(principal) {
    const state = this.store.read();
    const models = state.models.filter(model => activeModel(state, model) && this.keyAllows(principal, model.id)).map(model => ({ id: model.id, object: 'model', created: 0, owned_by: model.connectionId }));
    const routes = state.routes.filter(route => this.keyAllows(principal, route.id) && state.models.some(model => model.id === route.modelId && activeModel(state, model))).map(route => ({ id: route.id, object: 'model', created: 0, owned_by: 'model-dock' }));
    return { object: 'list', data: [...routes, ...models] };
  }
  snapshot() {
    const state = this.store.read();
    return { ...state,
      connections: state.connections.map(({ secret, ...connection }) => ({ ...connection, hasKey: Boolean(secret) })),
      keys: state.keys.map(({ hash, ...key }) => key),
      active: [...this.active.values()].map(({ controller, ...row }) => row),
      requests: this.history,
      providers: [
        { id: 'openai', label: 'OpenAI-compatible API', capabilities: 'Provider-defined', parameters: 'Chat Completions subset; see compatibility documentation.' },
        { id: 'ollama', label: 'Ollama', capabilities: 'Text, model-dependent tools and thinking, JSON' },
        { id: 'codex', label: 'Codex CLI', capabilities: 'Text, JSON, one application tool call per turn', experimental: true }
      ] };
  }
  async saveConnection(input, id) {
    return this.store.mutate(input.revision, state => {
      const previous = id ? state.connections.find(item => item.id === id) || missing('Connection') : null;
      const connection = normalizeConnection(input, previous);
      if (input.apiKey !== undefined) connection.secret = this.store.encrypt(input.apiKey);
      if (previous) {
        state.connections[state.connections.indexOf(previous)] = connection;
        // A new endpoint is a new execution source; rediscover or register its models explicitly.
        if (previous.baseUrl !== connection.baseUrl) for (const model of state.models.filter(item => item.connectionId === id)) { model.available = false; model.enabled = false; }
      } else state.connections.push(connection);
      return { id: connection.id };
    });
  }
  async deleteConnection(id, revision) {
    const result = await this.store.mutate(revision, state => {
      if (!state.connections.some(item => item.id === id)) missing('Connection');
      const ids = new Set(state.models.filter(item => item.connectionId === id).map(item => item.id));
      state.connections = state.connections.filter(item => item.id !== id);
      state.models = state.models.filter(item => !ids.has(item.id));
      // Keep broken aliases visible so an explicit choice cannot silently change source.
    });
    for (const row of this.active.values()) if (row.connectionId === id) row.controller.abort(new GatewayError('Connection removed.', 409, 'connection_removed'));
    return result;
  }
  async discover(id, revision, signal) {
    const before = this.store.read();
    if (revision !== before.revision) throw new GatewayError('Settings changed. Refresh first.', 409, 'revision_conflict');
    const connection = before.connections.find(item => item.id === id) || missing('Connection');
    if (this.discovering.has(id)) throw new GatewayError('Model discovery is already running.', 409, 'discovery_busy');
    this.discovering.add(id);
    try {
      let discovered, discoveryError;
      try {
        discovered = await this.providers[connection.type].discover(connection, {
          secret: this.store.decrypt(connection.secret), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        });
      } catch (error) { discoveryError = error instanceof GatewayError ? error : new GatewayError('Model discovery timed out or failed.', 502, 'discovery_failed'); }
      signal.throwIfAborted();
      await this.store.mutate(revision, state => {
        const current = state.connections.find(item => item.id === id) || missing('Connection');
        current.checkedAt = new Date().toISOString(); current.status = discoveryError ? 'error' : 'connected'; current.errorCode = discoveryError?.code || null;
        if (discoveryError) return;
        const seen = new Set();
        for (const item of discovered) {
          const nativeId = string(item.nativeId, 'model id', 300), modelId = `${id}/${nativeId}`;
          if (seen.has(modelId)) continue; seen.add(modelId);
          const existing = state.models.find(model => model.id === modelId);
          const model = { ...existing, ...item, nativeId, id: modelId, connectionId: id, enabled: existing?.enabled ?? false, available: true, manual: false };
          if (existing) state.models[state.models.indexOf(existing)] = model; else state.models.push(model);
        }
        for (const model of state.models) if (model.connectionId === id && !seen.has(model.id) && !model.manual) model.available = false;
      });
      if (discoveryError) throw discoveryError;
    } finally { this.discovering.delete(id); }
  }
  async addModel(input) {
    exact(input, ['revision', 'connectionId', 'nativeId', 'name']);
    return this.store.mutate(input.revision, state => {
      const connection = state.connections.find(item => item.id === input.connectionId) || missing('Connection');
      if (connection.type !== 'openai') throw new GatewayError('Discover models from the local runtime instead.');
      const nativeId = string(input.nativeId, 'model ID', 300), id = `${connection.id}/${nativeId}`;
      if (state.models.some(model => model.id === id)) throw new GatewayError('This model already exists.', 409, 'duplicate_model');
      state.models.push({ id, connectionId: connection.id, nativeId, name: input.name ? string(input.name, 'model name') : nativeId, enabled: false, available: true, manual: true, capabilities: { text: null, tools: null, structured: null } });
      return { id };
    });
  }
  async updateModel(id, input) {
    exact(input, ['revision', 'enabled']);
    if (typeof input.enabled !== 'boolean') throw new GatewayError('enabled must be boolean.');
    return this.store.mutate(input.revision, state => { const model = state.models.find(item => item.id === id) || missing('Model'); model.enabled = input.enabled; });
  }
  async saveRoute(input) {
    exact(input, ['revision', 'id', 'name', 'modelId']); const id = slug(input.id);
    return this.store.mutate(input.revision, state => {
      if (!state.models.some(model => model.id === input.modelId)) missing('Model');
      const route = { id, name: input.name ? string(input.name, 'function name') : id, modelId: input.modelId };
      const existing = state.routes.find(item => item.id === id);
      if (existing) state.routes[state.routes.indexOf(existing)] = route; else state.routes.push(route);
      return { id };
    });
  }
  async deleteRoute(id, revision) {
    return this.store.mutate(revision, state => { if (!state.routes.some(item => item.id === id)) missing('Function'); state.routes = state.routes.filter(item => item.id !== id); });
  }
  async createKey(input) {
    exact(input, ['revision', 'name', 'models']);
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 1000 || !input.models.every(value => typeof value === 'string')) throw new GatewayError('Choose at least one allowed model or function.');
    return this.store.mutate(input.revision, state => {
      const known = new Set(['*', ...state.models.map(item => item.id), ...state.routes.map(item => item.id)]);
      if (input.models.some(value => !known.has(value))) missing('Allowed model');
      const token = newToken('md_key'), id = newId('key');
      state.keys.push({ id, name: string(input.name, 'key name', 100), models: [...new Set(input.models)], hash: digest(token), prefix: token.slice(0, 13), createdAt: new Date().toISOString() });
      return { id, token };
    });
  }
  async deleteKey(id, revision) {
    await this.store.mutate(revision, state => { if (!state.keys.some(item => item.id === id)) missing('Key'); state.keys = state.keys.filter(item => item.id !== id); });
    for (const row of this.active.values()) if (row.principalId === id) row.controller.abort(new GatewayError('Access key revoked.', 401, 'key_revoked'));
  }
  cancel(id) {
    const row = this.active.get(id) || missing('Request');
    row.controller.abort(new GatewayError('Request cancelled.', 499, 'request_cancelled'));
  }
  recordResponseFailure(id, error) {
    const row = this.history.find(item => item.id === id);
    if (!row || row.errorCode) return;
    row.status = error?.status === 499 ? 'cancelled' : 'failed';
    row.errorCode = error instanceof GatewayError ? error.code : 'response_failed';
  }
  async *generate(body, principal, { signal, id }) {
    validateChat(body);
    if (!this.keyAllows(principal, body.model)) throw new GatewayError('This key cannot use the selected model.', 403, 'model_forbidden');
    const state = this.store.read(), route = state.routes.find(item => item.id === body.model);
    const model = state.models.find(item => item.id === (route?.modelId || body.model));
    if (!model || !activeModel(state, model)) throw new GatewayError('The selected model is disabled or unavailable. Choose it explicitly in model management.', 404, 'model_unavailable');
    const connection = state.connections.find(item => item.id === model.connectionId);
    const concurrent = [...this.active.values()].filter(row => row.connectionId === connection.id || connection.type === 'codex' && row.provider === 'codex').length;
    if (concurrent >= connection.maxConcurrency || this.active.size >= 32) throw new GatewayError('This connection is at capacity. Retry after the active request finishes.', 429, 'connection_busy');
    const controller = new AbortController(), started = Date.now();
    const row = { id, model: body.model, nativeModel: model.nativeId, connectionId: connection.id, provider: connection.type, principalId: principal.id, startedAt: new Date(started).toISOString(), controller };
    this.active.set(id, row); let status = 'failed', code = null, measurement = null, done = false, output = 0;
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(connection.timeoutSeconds * 1000)]);
    try {
      for await (const event of this.providers[connection.type].generate(connection, { ...body, model: model.nativeId }, {
        secret: this.store.decrypt(connection.secret), signal: combined, model
      })) {
        combined.throwIfAborted();
        if (event.type === 'delta') { output += Buffer.byteLength(JSON.stringify(event.delta)); if (output > 8 * 1024 * 1024) throw new GatewayError('Output exceeds the 8 MiB limit.', 502, 'output_limit'); }
        if (event.type === 'usage') measurement = event.usage;
        if (event.type === 'done') done = true;
        yield event;
      }
      if (!done) throw new GatewayError('Provider ended without a terminal response.', 502, 'upstream_protocol_error');
      status = 'succeeded';
    } catch (error) {
      if (combined.aborted) {
        const timeout = combined.reason?.name === 'TimeoutError';
        const abort = combined.reason instanceof GatewayError ? combined.reason : new GatewayError(timeout ? 'Request timed out.' : 'Request cancelled.', timeout ? 504 : 499, timeout ? 'request_timeout' : 'request_cancelled');
        status = timeout ? 'failed' : 'cancelled'; code = abort.code; throw abort;
      }
      code = error instanceof GatewayError ? error.code : 'provider_failed'; throw error;
    } finally {
      // A closed consumer must also stop the native model request.
      controller.abort(new GatewayError('Request completed or consumer disconnected.', 499, 'request_cancelled'));
      this.active.delete(id);
      const { controller: ignored, ...metadata } = row;
      this.history.unshift({ ...metadata, status, errorCode: code, durationMs: Date.now() - started, usage: measurement });
      this.history = this.history.slice(0, 100);
    }
  }
  async close() {
    for (const row of this.active.values()) row.controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
    await Promise.allSettled(Object.values(this.providers).map(provider => provider.close?.()));
  }
}
