import { GatewayError, exact, string, slug, validateChat, validateImageGeneration, decodeImageReferences } from '../protocol/index.mjs';
import { digest, equalSecret, newId, newToken } from './store.mjs';
import { createProviders } from '../providers/index.mjs';
import { saveModelSettings, applyReasoningPolicy } from './model-settings.mjs';
import { estimateUsage, normalizeUsagePrice } from './usage.mjs';
import { budgetQuote, normalizeBudget, ProjectBudgets } from './budgets.mjs';
import { activeModel, cooldownUntil, modelMetadata, normalizeModelPool, poolMembers, poolMetadata, poolSupports } from './model-pools.mjs';

const missing = kind => { throw new GatewayError(`${kind} not found.`, 404, 'not_found'); };
const connectionBusy = () => new GatewayError('This connection is at capacity. Retry after the active request finishes.', 429, 'connection_busy', null, { retryAfter: '2' });

function normalizeKeyLimits(value) {
  if (value === null) return null;
  const fields = ['requestsPerMinute', 'maxConcurrentRequests'];
  exact(value, fields);
  const limits = {};
  for (const field of fields) {
    const limit = value[field];
    if (limit == null) continue;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new GatewayError('Project limits must be positive integers.', 400, 'invalid_key_limits', field);
    }
    limits[field] = limit;
  }
  return Object.keys(limits).length ? limits : null;
}
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
    this.projectWindows = new Map();
    this.clock = options.clock ?? Date.now;
    this.budgets = new ProjectBudgets(store.directory, this.clock);
    this.cooldowns = new Map();
    this.poolCursors = new Map();
  }
  authenticate(token, adminOnly = false) {
    if (equalSecret(token, digest(this.store.adminToken))) return { admin: true, id: 'admin', name: 'Local administrator' };
    if (!adminOnly && token) {
      const key = this.store.read().keys.find(item => equalSecret(token, item.hash));
      if (key) return { admin: false, id: key.id, name: key.name };
    }
    throw new GatewayError('A valid access token is required.', 401, 'unauthorized');
  }
  #keyAllows(principal, key, name) {
    if (principal.admin) return true;
    return Boolean(key && (key.models.includes('*') || key.models.includes(name)));
  }
  catalog(principal) {
    const state = this.store.read();
    const key = state.keys.find(item => item.id === principal.id);
    const allows = name => this.#keyAllows(principal, key, name);
    const models = state.models.filter(model => activeModel(state, model) && allows(model.id)).map(model => {
      const connection = state.connections.find(item => item.id === model.connectionId);
      return { id: model.id, object: 'model', created: 0, owned_by: model.connectionId, name: model.name,
        source: { id: connection.id, name: connection.name, type: connection.type }, ...modelMetadata(model) };
    });
    const routes = state.routes.filter(route => allows(route.id) && state.models.some(model => model.id === route.modelId && activeModel(state, model))).map(route => ({ id: route.id, object: 'model', created: 0, owned_by: 'model-dock', legacy_alias: true }));
    const pools = [];
    for (const pool of state.pools || []) {
      if (!pool.enabled || !allows(pool.id)) continue;
      const members = poolMembers(state, pool);
      if (!members.some(member => member.available)) continue;
      pools.push({ id: pool.id, object: 'model', created: 0, owned_by: 'model-dock', name: pool.name,
        source: { id: pool.id, name: pool.name, type: 'pool' }, ...poolMetadata(pool, members) });
    }
    return { object: 'list', data: [...routes, ...models, ...pools] };
  }
  snapshot() {
    const state = this.store.read();
    return { ...state,
      connections: state.connections.map(({ secret, ...connection }) => ({ ...connection, hasKey: Boolean(secret) })),
      keys: state.keys.map(({ hash, ...key }) => ({ ...key, ...(key.budget && { budgetUsage: this.budgets.summary(key) }) })),
      pools: (state.pools || []).map(pool => {
        const members = poolMembers(state, pool);
        return { ...pool, ...poolMetadata(pool, members), members: members.map(({ id, model, connection, available }) => ({
          id, name: model?.name ?? id, connectionName: connection?.name ?? null, available,
          cooldownUntil: available ? this.#cooldown(connection) || null : null
        })) };
      }),
      active: [...this.active.values()].map(({ controller, ...row }) => row),
      requests: this.history,
      providers: [
        { id: 'openai', label: 'OpenAI-compatible API', capabilities: 'Provider-defined', parameters: 'Chat Completions subset; see compatibility documentation.' },
        { id: 'ollama', label: 'Ollama', capabilities: 'Text, JSON, model-dependent images, tools and thinking' },
        { id: 'codex', label: 'Codex CLI', capabilities: 'Text, JSON, image input, application tools, native image generation', experimental: true }
      ] };
  }
  async saveConnection(input, id) {
    const result = await this.store.mutate(input.revision, state => {
      const previous = id ? state.connections.find(item => item.id === id) || missing('Connection') : null;
      const connection = normalizeConnection(input, previous);
      if (connection.type !== 'codex' && previous?.secret && input.apiKey === undefined
        && new URL(previous.baseUrl).origin !== new URL(connection.baseUrl).origin) {
        throw new GatewayError('Enter a new API key or remove the saved key before changing the provider origin.', 400, 'credential_origin_changed', 'apiKey');
      }
      if (input.apiKey !== undefined) connection.secret = this.store.encrypt(input.apiKey);
      if (previous) {
        state.connections[state.connections.indexOf(previous)] = connection;
        // A new endpoint is a new execution source; rediscover or register its models explicitly.
        if (previous.baseUrl !== connection.baseUrl) for (const model of state.models.filter(item => item.connectionId === id)) { model.available = false; model.enabled = false; }
      } else state.connections.push(connection);
      return { id: connection.id };
    });
    this.cooldowns.delete(result.id);
    return result;
  }
  async deleteConnection(id, revision) {
    const result = await this.store.mutate(revision, state => {
      if (!state.connections.some(item => item.id === id)) missing('Connection');
      const ids = new Set(state.models.filter(item => item.connectionId === id).map(item => item.id));
      state.connections = state.connections.filter(item => item.id !== id);
      state.models = state.models.filter(item => !ids.has(item.id));
      // Keep broken aliases visible so an explicit choice cannot silently change source.
    });
    this.cooldowns.delete(id);
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
  async saveModelSettings(input) {
    return this.store.mutate(input.revision, state => saveModelSettings(state, input));
  }
  async setUsagePrice(input) {
    exact(input, ['revision', 'modelId', 'price']);
    return this.store.mutate(input.revision, state => {
      const model = state.models.find(item => item.id === input.modelId) || missing('Model');
      const price = normalizeUsagePrice(input.price, model.capability === 'image_generation');
      if (price) model.usagePrice = price;
      else delete model.usagePrice;
    });
  }
  async savePool(input, id) {
    const result = await this.store.mutate(input.revision, state => {
      state.pools ||= [];
      const previous = id ? state.pools.find(item => item.id === id) || missing('Model pool') : null;
      const pool = normalizeModelPool(state, input, previous);
      pool.id = previous?.id ?? newId('pool');
      if (previous) state.pools[state.pools.indexOf(previous)] = pool;
      else state.pools.push(pool);
      return { id: pool.id };
    });
    this.poolCursors.delete(result.id);
    return result;
  }
  async deletePool(id, revision) {
    await this.store.mutate(revision, state => {
      if (!state.pools?.some(item => item.id === id)) missing('Model pool');
      state.pools = state.pools.filter(item => item.id !== id);
    });
    this.poolCursors.delete(id);
  }
  async saveRoute(input) {
    exact(input, ['revision', 'id', 'name', 'modelId']); const id = slug(input.id);
    return this.store.mutate(input.revision, state => {
      if (!state.models.some(model => model.id === input.modelId)) missing('Model');
      const existing = state.routes.find(item => item.id === id);
      const route = { ...existing, id, name: input.name ? string(input.name, 'function name') : id, modelId: input.modelId,
        ...(existing && existing.modelId !== input.modelId ? { reasoningPolicy: null } : {}) };
      if (existing) state.routes[state.routes.indexOf(existing)] = route; else state.routes.push(route);
      return { id };
    });
  }
  async deleteRoute(id, revision) {
    return this.store.mutate(revision, state => { if (!state.routes.some(item => item.id === id)) missing('Function'); state.routes = state.routes.filter(item => item.id !== id); });
  }
  async createKey(input) {
    exact(input, ['revision', 'name', 'models', 'limits', 'budget']);
    const limits = normalizeKeyLimits(input.limits ?? null);
    const budget = normalizeBudget(input.budget ?? null);
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 1000 || !input.models.every(value => typeof value === 'string')) throw new GatewayError('Choose at least one allowed model or function.');
    return this.store.mutate(input.revision, state => {
      const known = new Set(['*', ...state.models.map(item => item.id), ...state.routes.map(item => item.id), ...(state.pools || []).map(item => item.id)]);
      if (input.models.some(value => !known.has(value))) missing('Allowed model');
      const token = newToken('md_key'), id = newId('key');
      state.keys.push({ id, name: string(input.name, 'key name', 100), models: [...new Set(input.models)], hash: digest(token),
        prefix: token.slice(0, 13), createdAt: new Date().toISOString(), ...(limits && { limits }), ...(budget && { budget }) });
      return { id, token };
    });
  }
  async updateKey(id, input) {
    exact(input, ['revision', 'limits', 'budget']);
    if (!Object.hasOwn(input, 'limits') && !Object.hasOwn(input, 'budget')) {
      throw new GatewayError('Supply project limits or a budget.');
    }
    return this.store.mutate(input.revision, state => {
      const key = state.keys.find(item => item.id === id) || missing('Key');
      if (Object.hasOwn(input, 'limits')) {
        const limits = normalizeKeyLimits(input.limits);
        if (limits) key.limits = limits;
        else delete key.limits;
      }
      if (Object.hasOwn(input, 'budget')) {
        const budget = normalizeBudget(input.budget);
        if (budget) key.budget = budget;
        else delete key.budget;
      }
    });
  }
  async deleteKey(id, revision) {
    await this.store.mutate(revision, state => { if (!state.keys.some(item => item.id === id)) missing('Key'); state.keys = state.keys.filter(item => item.id !== id); });
    this.projectWindows.delete(id);
    for (const row of this.active.values()) if (row.principalId === id) row.controller.abort(new GatewayError('Access key revoked.', 401, 'key_revoked'));
  }
  admitProjectRequest(principal) {
    if (principal.admin) return;
    const key = this.store.read().keys.find(item => item.id === principal.id);
    if (!key) throw new GatewayError('A valid access token is required.', 401, 'unauthorized');
    const now = performance.now();
    const window = this.projectWindows.get(key.id) || { endsAt: now + 60_000, count: 0, active: 0 };
    if (now >= window.endsAt) {
      window.endsAt = now + 60_000;
      window.count = 0;
    }
    if (key.limits?.requestsPerMinute && window.count >= key.limits.requestsPerMinute) {
      throw new GatewayError('The project has reached its request limit for this minute.', 429, 'project_rate_limited', null,
        { retryAfter: String(Math.ceil((window.endsAt - now) / 1000)) });
    }
    if (key.limits?.maxConcurrentRequests && window.active >= key.limits.maxConcurrentRequests) {
      throw new GatewayError('The project has reached its concurrent request limit.', 429, 'project_at_capacity', null, { retryAfter: '1' });
    }
    window.count++;
    window.active++;
    this.projectWindows.set(key.id, window);
    return () => { window.active--; };
  }
  cancel(id) {
    const row = this.active.get(id) || missing('Request');
    row.controller.abort(new GatewayError('Request cancelled.', 499, 'request_cancelled'));
  }
  recordResponseFailure(context, error) {
    const row = context?.completed;
    if (!row || row.errorCode) return;
    if (context.signal.aborted) error = context.signal.reason;
    row.status = error?.status === 499 ? 'cancelled' : 'failed';
    row.errorCode = error instanceof GatewayError ? error.code : 'response_failed';
  }
  #concurrent(connection) {
    return [...this.active.values()].filter(row => row.connectionId === connection.id
      || connection.type === 'codex' && row.provider === 'codex').length;
  }
  #cooldown(connection) {
    const until = this.cooldowns.get(connection.id) || 0;
    if (until > this.clock()) return until;
    this.cooldowns.delete(connection.id);
    return 0;
  }
  #coolConnection(connection, error) {
    const until = cooldownUntil(error, this.clock());
    if (!until) return;
    const current = this.store.read().connections.find(item => item.id === connection.id);
    if (current?.baseUrl === connection.baseUrl && current.secret?.iv === connection.secret?.iv) {
      this.cooldowns.set(connection.id, Math.max(until, this.#cooldown(connection)));
    }
  }
  #resolveModel(name, principal, prepare) {
    const state = this.store.read();
    const key = state.keys.find(item => item.id === principal.id);
    if (!this.#keyAllows(principal, key, name)) throw new GatewayError('This key cannot use the selected model.', 403, 'model_forbidden');
    const quoteSelection = (model, connection, request) => {
      const quote = budgetQuote(key, model, connection, request);
      if (quote) this.budgets.check(quote);
      return { model, connection, provider: this.providers[connection.type], request, quote, revision: state.revision };
    };
    const route = state.routes.find(item => item.id === name);
    const pool = !route && state.pools?.find(item => item.id === name);
    if (pool) return this.#selectPool(state, pool, prepare, quoteSelection);
    const model = state.models.find(item => item.id === (route?.modelId || name));
    if (!model || !activeModel(state, model)) throw new GatewayError('The selected model is disabled or unavailable. Choose it explicitly in model management.', 404, 'model_unavailable');
    const connection = state.connections.find(item => item.id === model.connectionId);
    return quoteSelection(model, connection, prepare(model, route, this.providers[connection.type], false));
  }
  #selectPool(state, pool, prepare, quoteSelection) {
    const members = pool.enabled ? poolMembers(state, pool).filter(member => member.available) : [];
    if (!members.length) throw new GatewayError('The model pool is disabled or has no published deployments.', 404, 'model_unavailable');
    const offset = (this.poolCursors.get(pool.id) ?? -1) + 1;
    const compatible = [];
    let incompatibility;
    for (const { id, model, connection } of members) {
      let request;
      try { request = prepare(model, null, this.providers[connection.type], true); }
      catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        incompatibility ??= error;
        continue;
      }
      const index = pool.modelIds.indexOf(id);
      const count = this.#concurrent(connection);
      compatible.push({ model, connection, request, index, load: count / connection.maxConcurrency,
        order: (index - offset + pool.modelIds.length) % pool.modelIds.length, until: this.#cooldown(connection) });
    }
    if (!compatible.length) throw incompatibility;
    const reachable = compatible.filter(item => !item.until);
    if (!reachable.length) {
      const soonest = compatible.reduce((time, item) => Math.min(time, item.until), Infinity);
      throw new GatewayError('All compatible deployments are cooling down.', 503, 'pool_unavailable', null,
        { retryAfter: String(Math.max(1, Math.ceil((soonest - this.clock()) / 1000))) });
    }
    if (this.active.size >= 32 || reachable.every(item => item.load >= 1)) throw connectionBusy();
    let budgetError;
    for (const item of reachable.filter(item => item.load < 1).sort((a, b) => a.load - b.load || a.order - b.order)) {
      try {
        const selection = quoteSelection(item.model, item.connection, item.request);
        this.poolCursors.set(pool.id, item.index);
        return selection;
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        budgetError ??= error;
      }
    }
    throw budgetError;
  }
  async #reserveBudget(selection, context, signal) {
    context.budgetPrice = selection.model.usagePrice;
    context.budgetHold = await this.budgets.reserve(selection.quote, context.id, signal);
    signal.throwIfAborted();
    if (selection.revision !== this.store.read().revision) {
      throw new GatewayError('Settings changed. Refresh and try again.', 409, 'revision_conflict');
    }
  }
  async settleBudget(context) {
    if (!context?.budgetHold) return;
    try {
      const settlement = await this.budgets.settle(context.budgetHold, context.dispatched && !context.rejectedBeforeDispatch, context.budgetPrice, context.completed);
      if (context.completed && settlement) context.completed.budget = settlement;
    } catch {
      // Keep the reservation on disk for recovery. The ledger rejects further
      // budgeted calls until it can be opened safely again.
      if (context.completed) context.completed.budget = { period: context.budgetHold.period, basis: 'pending' };
    }
  }
  #startRequest(name, principal, model, connection, context) {
    if (this.#concurrent(connection) >= connection.maxConcurrency || this.active.size >= 32) throw connectionBusy();
    const { signal, id, endpoint } = context;
    signal.throwIfAborted();
    const controller = new AbortController(), started = Date.now();
    const metadata = { id, model: name, modelId: model.id, modelName: model.name, nativeModel: model.nativeId, endpoint,
      connectionId: connection.id, connectionName: connection.name, provider: connection.type,
      principalId: principal.id, projectName: principal.name, startedAt: new Date(started).toISOString() };
    this.active.set(id, { ...metadata, controller });
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(connection.timeoutSeconds * 1000)]);
    let status = 'failed', errorCode = null;
    const fail = error => {
      if (combined.aborted) {
        const timeout = combined.reason?.name === 'TimeoutError';
        error = combined.reason instanceof GatewayError ? combined.reason
          : new GatewayError(timeout ? 'Request timed out.' : 'Request cancelled.', timeout ? 504 : 499, timeout ? 'request_timeout' : 'request_cancelled');
        status = timeout ? 'failed' : 'cancelled';
      }
      errorCode = error instanceof GatewayError ? error.code : 'provider_failed';
      if (context.dispatched) this.#coolConnection(connection, error);
      return error;
    };
    return {
      signal: combined,
      succeed() { status = 'succeeded'; },
      fail,
      finish: (usage, images = 0) => {
        if (combined.aborted && status !== 'succeeded' && !errorCode) fail(combined.reason);
        const finished = Date.now();
        controller.abort(new GatewayError('Request completed or consumer disconnected.', 499, 'request_cancelled'));
        this.active.delete(id);
        if (!context.dispatched) return;
        context.completed = { ...metadata, status, errorCode, finishedAt: new Date(finished).toISOString(),
          durationMs: finished - started, usage, images, estimate: estimateUsage(model.usagePrice, usage, images) };
        this.history.unshift(context.completed);
        this.history = this.history.slice(0, 100);
      }
    };
  }
  async *generate(body, principal, context) {
    const responses = context.endpoint === 'responses' || context.responses === true;
    const contentParam = responses ? 'input' : 'messages';
    const normalized = validateChat(body, contentParam);
    const selection = this.#resolveModel(body.model, principal, (model, route, provider, pooled) => {
      if (model.capability === 'image_generation') {
        throw new GatewayError('Use /v1/images/generations for this model.', 400, 'unsupported_model_capability', 'model');
      }
      if (model.capabilities?.image_input === false && normalized.messages.some(message => Array.isArray(message.content))) {
        throw new GatewayError('The selected model does not support image input.', 400, 'unsupported_model_capability', contentParam);
      }
      const request = applyReasoningPolicy(model, route, normalized);
      if (pooled && !poolSupports(model, request)) {
        throw new GatewayError('No pool deployment supports these request options.', 400, 'unsupported_model_capability', 'model');
      }
      return request;
    });
    const { model, connection, provider, request, quote } = selection;
    const run = this.#startRequest(body.model, principal, model, connection, context);
    let measurement = null, done = false, output = 0;
    try {
      if (quote) await this.#reserveBudget(selection, context, run.signal);
      const secret = this.store.decrypt(connection.secret);
      context.dispatched = true;
      for await (const event of provider.generate(connection, { ...request, model: model.nativeId }, {
        secret, signal: run.signal, model, responses, budgeted: Boolean(quote)
      })) {
        run.signal.throwIfAborted();
        if (event.type === 'delta') { output += Buffer.byteLength(JSON.stringify(event.delta)); if (output > 8 * 1024 * 1024) throw new GatewayError('Output exceeds the 8 MiB limit.', 502, 'output_limit'); }
        if (event.type === 'usage') measurement = event.usage;
        if (event.type === 'done') done = true;
        yield event;
      }
      if (!done) throw new GatewayError('Provider ended without a terminal response.', 502, 'upstream_protocol_error');
      run.succeed();
    } catch (error) {
      // The native adapters use this code for synchronous request validation.
      if (connection.type !== 'openai' && error instanceof GatewayError && error.code === 'unsupported_parameter') {
        context.rejectedBeforeDispatch = true;
      }
      throw run.fail(error);
    } finally {
      run.finish(measurement);
    }
  }
  async generateImage(body, principal, context) {
    const normalized = validateImageGeneration(body);
    const selection = this.#resolveModel(normalized.model, principal, (model, route, provider) => {
      if (model.capability !== 'image_generation' || typeof provider?.generateImage !== 'function') {
        throw new GatewayError('Choose an image generation model.', 400, 'unsupported_model_capability', 'model');
      }
      return normalized;
    });
    const { model, connection, provider, request, quote } = selection;
    const referenceImages = decodeImageReferences(body.reference_images);
    const run = this.#startRequest(request.model, principal, model, connection, context);
    let usage = null, images = 0;
    try {
      if (quote) await this.#reserveBudget(selection, context, run.signal);
      context.dispatched = true;
      const result = await provider.generateImage(connection, { ...request, model: model.nativeId, referenceImages }, { signal: run.signal, model });
      usage = result.usage ?? null;
      images = 1;
      run.signal.throwIfAborted();
      run.succeed();
      return { created: Math.floor(Date.now() / 1000), output_format: result.format,
        data: [{ b64_json: result.b64_json, width: result.width, height: result.height }] };
    } catch (error) {
      throw run.fail(error);
    } finally {
      run.finish(usage, images);
    }
  }
  async close() {
    for (const row of this.active.values()) row.controller.abort(new GatewayError('Gateway is shutting down.', 503, 'shutting_down'));
    await Promise.allSettled(Object.values(this.providers).map(provider => provider.close?.()));
  }
}
