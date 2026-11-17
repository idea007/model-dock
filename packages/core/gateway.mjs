import { GatewayError, exact, string, slug, validateChat, validateImageGeneration, decodeImageReferences } from '../protocol/index.mjs';
import { digest, equalSecret, newId, newToken } from './store.mjs';
import { createProviders } from '../providers/index.mjs';
import { saveModelSettings, applyReasoningPolicy } from './model-settings.mjs';
import { estimateUsage, normalizeUsagePrice } from './usage.mjs';
import { ProviderUsageTrace, serviceUsageEndpoint } from './provider-usage.mjs';
import { observeServiceUsage, serviceAuditInput } from './service-usage.mjs';
import { budgetQuote, normalizeBudget, ProjectBudgets } from './budgets.mjs';
import { activeModel, cooldownUntil, modelMetadata, normalizeModelPool, poolMembers, poolMetadata, poolSupports } from './model-pools.mjs';
import { CodexRequestQueue, connectionBusy } from './codex-request-queue.mjs';
import { CodexImageOperations } from './codex-image-operations.mjs';
import { CodexSessions, validateCodexSession, scopeCodexSession } from './codex-sessions.mjs';
import { ServiceOwnership } from './service-ownership.mjs';
import { serviceJobId, serviceProfiles, serviceRequest, standardUpstreamModelProfiles } from '../providers/services.mjs';
import { jsonResponse } from '../providers/http.mjs';
import { apiCredentialName, isApiConnection, providerUrl, validateApiKey, validateMfluxToken } from './api-credentials.mjs';

const missing = kind => { throw new GatewayError(`${kind} not found.`, 404, 'not_found'); };
const originChanged = () => new GatewayError('Enter a new API key or remove the saved key before changing the provider origin.', 400, 'credential_origin_changed', 'apiKey');

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
function normalizeKeyModels(state, models) {
  if (!Array.isArray(models) || !models.length || models.length > 1000 || !models.every(value => typeof value === 'string')) {
    throw new GatewayError('Choose at least one allowed model or function.');
  }
  const known = new Set(['*', ...state.models.map(item => item.id), ...state.routes.map(item => item.id), ...(state.pools || []).map(item => item.id)]);
  if (models.some(value => !known.has(value))) missing('Allowed model');
  return [...new Set(models)];
}
export function normalizeConnection(input, previous) {
  exact(input, ['revision', 'name', 'type', 'baseUrl', 'apiKey', 'enabled', 'maxConcurrency', 'timeoutSeconds', 'service', 'credentialId', 'upstreamModel']);
  const type = previous?.type || input.type;
  if (!['openai', 'ollama', 'codex', 'mflux', 'service'].includes(type) || previous && input.type !== undefined && input.type !== previous.type) throw new GatewayError('Invalid provider type.');
  const concurrencyLimit = type === 'codex' ? 1 : type === 'mflux' ? 4 : 16;
  const connection = { ...previous, id: previous?.id || newId('conn'), type,
    name: input.name === undefined && previous ? previous.name : string(input.name, 'connection name', 100),
    enabled: input.enabled ?? previous?.enabled ?? true,
    maxConcurrency: input.maxConcurrency ?? previous?.maxConcurrency ?? (concurrencyLimit < 16 ? concurrencyLimit : 2),
    timeoutSeconds: input.timeoutSeconds ?? previous?.timeoutSeconds ?? 600,
    status: 'unknown', checkedAt: null, errorCode: null };
  if (type === 'service') {
    const profile = input.service ?? previous?.service;
    if (!serviceProfiles.has(profile) || previous && profile !== previous.service) throw new GatewayError('Invalid provider service profile.');
    connection.service = profile;
  } else if (input.service !== undefined) {
    throw new GatewayError('The service profile is only allowed on service connections.');
  }
  if (input.upstreamModel !== undefined) {
    if (!standardUpstreamModelProfiles.has(connection.service)) {
      throw new GatewayError('This service does not accept an upstream model binding.', 400, 'unsupported_parameter', 'upstreamModel');
    }
    if (input.upstreamModel === '') delete connection.upstreamModel;
    else connection.upstreamModel = string(input.upstreamModel, 'upstreamModel', 300);
  }
  if (typeof connection.enabled !== 'boolean') throw new GatewayError('enabled must be boolean.');
  if (!Number.isInteger(connection.maxConcurrency) || connection.maxConcurrency < 1 || connection.maxConcurrency > concurrencyLimit) throw new GatewayError('Invalid concurrency limit.');
  if (!Number.isInteger(connection.timeoutSeconds) || connection.timeoutSeconds < 5 || connection.timeoutSeconds > 1800) throw new GatewayError('timeoutSeconds must be between 5 and 1800.');
  if (type === 'codex') {
    if (input.baseUrl || input.apiKey) throw new GatewayError('Codex uses the locally authenticated CLI; do not submit its tokens.');
    connection.baseUrl = '';
  } else {
    const value = input.baseUrl ?? previous?.baseUrl ??
      (type === 'ollama' ? 'http://127.0.0.1:11434' : type === 'mflux' ? 'http://127.0.0.1:8016/v1' : '');
    const url = providerUrl(value);
    if (type === 'mflux' && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^\/v1\/?$/.test(url.pathname))) {
      throw new GatewayError('Use the MFLUX loopback HTTP address with an explicit port and /v1.');
    }
    connection.baseUrl = url.toString().replace(/\/+$/, '');
  }
  if (input.apiKey !== undefined) validateApiKey(input.apiKey);
  return connection;
}

export class Gateway {
  constructor(store, options = {}) {
    this.store = store;
    this.providers = options.providers || createProviders({ ...options,
      codex: { ...options.codex, sessionStore: new CodexSessions(store.directory) } });
    this.active = new Map(); this.history = []; this.discovering = new Set();
    this.projectWindows = new Map();
    this.clock = options.clock ?? Date.now;
    this.budgets = new ProjectBudgets(store.directory, this.clock);
    this.cooldowns = new Map();
    this.poolCursors = new Map();
    this.codexQueue = options.codexQueueWaitMs ? new CodexRequestQueue(options.codexQueueWaitMs) : null;
    this.imageOperations = new CodexImageOperations(options.imageStores || new Map(), this.providers.codex);
    this.serviceOwnership = new ServiceOwnership(store.directory);
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
  hasDedicatedCodexCatalog(principal) {
    if (principal.admin) return false;
    const { keys, models, connections } = this.store.read();
    const published = keys.find(key => key.id === principal.id)?.models || [];
    const deployments = published.map(id => models.find(model => model.id === id));
    const isCodex = model => connections.some(connection => connection.id === model?.connectionId && connection.type === 'codex');
    return deployments.some(model => model?.capability !== 'image_generation' && isCodex(model))
      && deployments.every(model => ['image_generation', 'provider_service'].includes(model?.capability) || isCodex(model));
  }
  catalog(principal) {
    const state = this.store.read();
    const key = state.keys.find(item => item.id === principal.id);
    const allows = name => this.#keyAllows(principal, key, name);
    const models = state.models.filter(model => activeModel(state, model) && allows(model.id)).map(model => {
      const connection = state.connections.find(item => item.id === model.connectionId);
      return { id: model.id, object: 'model', created: 0, owned_by: model.connectionId, name: model.name,
        source: { id: connection.id, name: connection.name, type: connection.type }, ...modelMetadata(model),
        ...(connection.type === 'service' ? { service: connection.service } : {}),
        ...(connection.type === 'codex' && model.capability === 'image_generation' && this.imageOperations.has(principal) ? { image_operations: true } : {}) };
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
  async availableCatalog(principal, signal) {
    const catalog = this.catalog(principal);
    const state = this.store.read();
    const ids = new Set(catalog.data.filter(item => item.source?.type === 'mflux').map(item => item.source.id));
    const ready = new Map();
    await Promise.all(state.connections.filter(connection => ids.has(connection.id)).map(async connection => {
      try {
        const models = await this.providers.mflux.discover(connection, {
          secret: this.store.decrypt(this.store.connectionKey(connection, state)), signal: AbortSignal.any([signal, AbortSignal.timeout(3000)])
        });
        ready.set(connection.id, new Map(models.map(model => [model.nativeId, model])));
      } catch { /* The authorized catalog keeps serving other providers. */ }
    }));
    const current = this.catalog(principal);
    return { ...current, data: current.data.filter(item => {
      if (item.source?.type !== 'mflux') return true;
      const nativeId = item.id.slice(item.source.id.length + 1);
      const model = ready.get(item.source.id)?.get(nativeId);
      return model && model.revision === item.model_revision && model.maxReferenceImages === item.max_reference_images
        && item.image_sizes.length === model.imageSizes.length && item.image_sizes.every(size => model.imageSizes.includes(size));
    }) };
  }
  snapshot() {
    const state = this.store.read();
    const credentials = new Map(state.apiCredentials.map(({ secret, ...credential }) => [credential.id, {
      ...credential, hasKey: Boolean(secret), origin: new URL(credential.baseUrl).origin, connectionIds: []
    }]));
    const connections = state.connections.map(({ secret, ...connection }) => {
      const credential = credentials.get(connection.credentialId);
      credential?.connectionIds.push(connection.id);
      return { ...connection, hasKey: credential?.hasKey ?? Boolean(secret) };
    });
    return { ...state,
      connections,
      apiCredentials: [...credentials.values()],
      keys: state.keys.map(({ hash, ...key }) => ({ ...key, ...(key.budget && { budgetUsage: this.budgets.summary(key) }) })),
      pools: (state.pools || []).map(pool => {
        const members = poolMembers(state, pool);
        return { ...pool, ...poolMetadata(pool, members), members: members.map(({ id, model, connection, available }) => ({
          id, name: model?.name ?? id, connectionName: connection?.name ?? null, available,
          cooldownUntil: available ? this.#cooldown(connection) || null : null
        })) };
      }),
      active: [...this.active.values()].map(({ controller, ...row }) => row),
      codexWaiting: this.codexQueue?.waitingCount ?? 0,
      requests: this.history,
      providers: [
        { id: 'openai', label: 'OpenAI-compatible API', capabilities: 'Provider-defined', parameters: 'Chat Completions subset; see compatibility documentation.' },
        { id: 'ollama', label: 'Ollama', capabilities: 'Text, JSON, model-dependent images, tools and thinking' },
        { id: 'codex', label: 'Codex CLI', capabilities: 'Text, JSON, image input, application tools, native image generation', experimental: true },
        { id: 'mflux', label: 'MFLUX', capabilities: 'Local image generation and model-dependent reference images' },
        { id: 'service', label: 'Provider service', profiles: [...serviceProfiles.keys()], standardModelProfiles: [...standardUpstreamModelProfiles] }
      ] };
  }
  async saveConnection(input, id) {
    const result = await this.store.mutate(input.revision, state => {
      const previous = id ? state.connections.find(item => item.id === id) || missing('Connection') : null;
      const selected = input.credentialId === undefined ? undefined
        : state.apiCredentials.find(item => item.id === input.credentialId) || missing('API credential');
      const defaultBase = selected && selected.id !== previous?.credentialId ? selected.baseUrl : undefined;
      const connection = normalizeConnection({ ...input, baseUrl: input.baseUrl ?? defaultBase }, previous);
      if (previous && this.store.connectionKey(previous, state) && !selected && input.apiKey === undefined
        && new URL(previous.baseUrl).origin !== new URL(connection.baseUrl).origin) {
        throw originChanged();
      }
      if (selected) {
        if (input.apiKey !== undefined || !isApiConnection(connection)) {
          throw new GatewayError('Choose a saved credential or enter a new API key.');
        }
        if (new URL(selected.baseUrl).origin !== new URL(connection.baseUrl).origin) {
          throw new GatewayError('The API base URL must match the saved credential origin.', 400, 'credential_origin_mismatch', 'baseUrl');
        }
        connection.credentialId = selected.id;
      } else if (isApiConnection(connection)) {
        connection.credentialId = this.#legacyConnectionCredential(state, connection, previous, input.apiKey).id;
      } else if (input.apiKey !== undefined) {
        connection.secret = this.store.encrypt(input.apiKey);
      }
      if (connection.type === 'mflux') validateMfluxToken(this.store.decrypt(this.store.connectionKey(connection, state)));
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
  #matchingApiCredential(state, origin, apiKey, except) {
    if (!apiKey) return undefined;
    return state.apiCredentials.find(credential => credential.id !== except && credential.secret
      && new URL(credential.baseUrl).origin === origin && this.store.decrypt(credential.secret) === apiKey);
  }
  #legacyConnectionCredential(state, connection, previous, apiKey) {
    const origin = new URL(connection.baseUrl).origin;
    const current = state.apiCredentials.find(item => item.id === previous?.credentialId);
    if (current && new URL(current.baseUrl).origin === origin
      && (apiKey === undefined || this.store.decrypt(current.secret) === apiKey)) return current;
    const shared = this.#matchingApiCredential(state, origin, apiKey);
    if (shared) return shared;
    const credential = { id: newId('cred'), name: apiCredentialName([connection]), baseUrl: connection.baseUrl, secret: this.store.encrypt(apiKey) };
    state.apiCredentials.push(credential);
    return credential;
  }
  async saveApiCredential(input, id) {
    exact(input, ['revision', 'name', 'baseUrl', 'apiKey']);
    if (input.apiKey !== undefined) validateApiKey(input.apiKey);
    const result = await this.store.mutate(input.revision, state => {
      const previous = id ? state.apiCredentials.find(item => item.id === id) || missing('API credential') : null;
      const name = string(input.name ?? previous?.name, 'credential name', 100);
      const url = providerUrl(input.baseUrl ?? previous?.baseUrl);
      const links = id ? state.connections.filter(connection => connection.credentialId === id) : [];
      if (previous && new URL(previous.baseUrl).origin !== url.origin) {
        if (links.length) throw new GatewayError('Remove or reassign linked services before changing the credential origin.', 409, 'credential_in_use', 'baseUrl');
        if (previous.secret && input.apiKey === undefined) throw originChanged();
      }
      if (this.#matchingApiCredential(state, url.origin, input.apiKey, id)) {
        throw new GatewayError('This API key is already saved for the provider origin.', 409, 'duplicate_api_credential');
      }
      if (input.apiKey !== undefined && links.some(connection => connection.type === 'mflux')) validateMfluxToken(input.apiKey);
      const replace = input.apiKey !== undefined && this.store.decrypt(previous?.secret) !== input.apiKey;
      const credential = { id: id ?? newId('cred'), name, baseUrl: url.toString().replace(/\/+$/, ''),
        secret: replace ? this.store.encrypt(input.apiKey) : previous?.secret ?? null };
      if (previous) state.apiCredentials[state.apiCredentials.indexOf(previous)] = credential;
      else state.apiCredentials.push(credential);
      if (replace) for (const connection of links) Object.assign(connection, { status: 'unknown', checkedAt: null, errorCode: null });
      return { id: credential.id, resetConnections: replace ? links.map(connection => connection.id) : [] };
    });
    for (const connectionId of result.resetConnections) this.cooldowns.delete(connectionId);
    return { id: result.id };
  }
  async deleteApiCredential(id, revision) {
    return this.store.mutate(revision, state => {
      const credential = state.apiCredentials.find(item => item.id === id) || missing('API credential');
      if (state.connections.some(connection => connection.credentialId === id)) {
        throw new GatewayError('Remove or reassign linked services before deleting the credential.', 409, 'credential_in_use');
      }
      state.apiCredentials.splice(state.apiCredentials.indexOf(credential), 1);
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
    this.cooldowns.delete(id);
    const removed = new GatewayError('Connection removed.', 409, 'connection_removed');
    this.codexQueue?.cancelMatching(row => row.connectionId === id, removed);
    for (const row of this.active.values()) if (row.connectionId === id) row.controller.abort(removed);
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
          secret: this.store.decrypt(this.store.connectionKey(connection, before)), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
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
    return this.store.mutate(input.revision, state => {
      const models = normalizeKeyModels(state, input.models);
      const token = newToken('md_key'), id = newId('key');
      state.keys.push({ id, name: string(input.name, 'key name', 100), models, hash: digest(token),
        prefix: token.slice(0, 13), createdAt: new Date().toISOString(), ...(limits && { limits }), ...(budget && { budget }) });
      return { id, token };
    });
  }
  async updateKey(id, input) {
    exact(input, ['revision', 'limits', 'budget', 'models']);
    if (!['limits', 'budget', 'models'].some(field => Object.hasOwn(input, field))) {
      throw new GatewayError('Supply project settings to update.');
    }
    return this.store.mutate(input.revision, state => {
      const key = state.keys.find(item => item.id === id) || missing('Key');
      if (Object.hasOwn(input, 'models')) key.models = normalizeKeyModels(state, input.models);
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
    const revoked = new GatewayError('Access key revoked.', 401, 'key_revoked');
    this.codexQueue?.cancelMatching(row => row.principalId === id, revoked);
    for (const row of this.active.values()) if (row.principalId === id) row.controller.abort(revoked);
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
  requestStatus(principal, id) {
    const active = this.active.get(id);
    const completed = this.history.find(item => item.id === id && Date.now() - Date.parse(item.finishedAt) < 3600_000);
    const row = active || completed;
    if (!row || row.principalId !== principal.id) missing('Request');
    return { id, status: active ? 'running' : row.status, startedAt: row.startedAt,
      ...(completed && { finishedAt: row.finishedAt, errorCode: row.errorCode }) };
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
    const state = this.store.read();
    const current = state.connections.find(item => item.id === connection.id);
    if (current && current.baseUrl === connection.baseUrl && current.credentialId === connection.credentialId
      && this.store.connectionKey(current, state)?.iv === connection.secret?.iv) {
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
      const credential = state.apiCredentials.find(item => item.id === connection.credentialId);
      const source = { ...connection, secret: this.store.connectionKey(connection, state),
        ...(credential && { usageCredential: { id: credential.id, name: credential.name } }) };
      return { model, connection: source, provider: this.providers[connection.type], request, quote, revision: state.revision };
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
  async #admitRequest(name, principal, context, prepare) {
    let selection = this.#resolveModel(name, principal, prepare);
    let release;
    if (selection.connection.type === 'codex' && this.codexQueue) {
      release = await this.codexQueue.acquire(context.id, context.admissionSignal || context.signal, principal.id, selection.connection.id);
    }
    try {
      if (release && selection.revision !== this.store.read().revision) {
        const refreshed = this.#resolveModel(name, principal, prepare);
        if (refreshed.model.id !== selection.model.id || refreshed.connection.id !== selection.connection.id) {
          throw new GatewayError('The model deployment changed while waiting. Refresh and try again.', 409, 'revision_conflict');
        }
        selection = refreshed;
      }
      const run = this.#startRequest(name, principal, selection.model, selection.connection, context, release);
      return { ...selection, run };
    } catch (error) {
      release?.();
      throw error;
    }
  }
  #startRequest(name, principal, model, connection, context, release) {
    if (this.#concurrent(connection) >= connection.maxConcurrency || this.active.size >= 32) throw connectionBusy();
    const { signal, id, endpoint } = context;
    signal.throwIfAborted();
    const controller = new AbortController(), started = Date.now();
    const linkedOperation = context.operationId || context.usageTags?.operationId;
    const metadata = { id, model: name, modelId: model.id, modelName: model.name, nativeModel: model.nativeId, endpoint,
      connectionId: connection.id, connectionName: connection.name, provider: connection.type,
      ...(linkedOperation && { operationId: linkedOperation }),
      principalId: principal.id, projectName: principal.name, startedAt: new Date(started).toISOString() };
    const trace = new ProviderUsageTrace({ connection, model, credential: connection.usageCredential,
      endpoint: context.serviceRequest ? serviceUsageEndpoint(connection, context.serviceRequest.pathname, context.serviceRequest.method) : endpoint,
      tags: context.usageTags,
      development: context.developmentSecrets, directory: this.store.directory });
    this.active.set(id, { ...metadata, controller });
    const combined = AbortSignal.any([signal, controller.signal,
      AbortSignal.timeout(context.imageOperation ? 1800_000 : connection.timeoutSeconds * 1000)]);
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
      trace,
      succeed() { status = 'succeeded'; },
      fail,
      finish: (usage, images = 0) => {
        if (combined.aborted && status !== 'succeeded' && !errorCode) fail(combined.reason);
        const finished = Date.now();
        controller.abort(new GatewayError('Request completed or consumer disconnected.', 499, 'request_cancelled'));
        this.active.delete(id);
        release?.();
        if (!context.dispatched) return;
        const audit = trace.finish({ status, errorCode, usage, images, taskStatus: context.imageOperation ? status : null });
        if (model.usagePrice) audit.configuredPrice = model.usagePrice;
        if (trace.started && trace.development) context.development = trace.development;
        context.completed = { ...metadata, status, errorCode, finishedAt: new Date(finished).toISOString(),
          ...(context.serviceOperationId && !linkedOperation && { operationId: context.serviceOperationId }),
          durationMs: finished - started, usage, images, estimate: estimateUsage(model.usagePrice, usage, images), audit };
        this.history.unshift(context.completed);
        this.history = this.history.slice(0, 100);
      }
    };
  }
  async *generate(body, principal, context) {
    const responses = context.endpoint === 'responses' || context.responses === true;
    const contentParam = responses ? 'input' : 'messages';
    const { model_dock_session, ...fields } = body;
    const session = validateCodexSession(model_dock_session);
    const normalized = validateChat(fields, contentParam);
    const selection = await this.#admitRequest(body.model, principal, context, (model, route, provider, pooled) => {
      if (model.capability === 'image_generation') {
        throw new GatewayError('Use /v1/images/generations for this model.', 400, 'unsupported_model_capability', 'model');
      }
      if (model.capabilities?.image_input === false && normalized.messages.some(message => Array.isArray(message.content))) {
        throw new GatewayError('The selected model does not support image input.', 400, 'unsupported_model_capability', contentParam);
      }
      if (session && (responses || pooled || route || !provider?.supportsCodexSessions)) {
        throw new GatewayError('Choose a published Codex text deployment for session requests.', 400, 'unsupported_model_capability', 'model_dock_session');
      }
      const request = applyReasoningPolicy(model, route, normalized);
      if (pooled && !poolSupports(model, request)) {
        throw new GatewayError('No pool deployment supports these request options.', 400, 'unsupported_model_capability', 'model');
      }
      return request;
    });
    const { model, connection, provider, request, quote, run } = selection;
    let measurement = null, done = false, output = 0;
    try {
      if (quote) await this.#reserveBudget(selection, context, run.signal);
      const secret = this.store.decrypt(connection.secret);
      run.signal.throwIfAborted();
      context.dispatched = true;
      const upstreamInput = { ...request, model: model.nativeId };
      if (!provider.tracesUsage) run.trace.start(upstreamInput, secret);
      for await (const event of provider.generate(connection, upstreamInput, {
        secret, signal: run.signal, model, responses, budgeted: Boolean(quote),
        trace: run.trace,
        ...(session && { session: scopeCodexSession(principal, model.id, session) })
      })) {
        run.signal.throwIfAborted();
        if (!provider.tracesUsage && event.type === 'delta') run.trace.delta(event.delta);
        if (event.type === 'done') run.trace.stopReason(event.finishReason);
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
    const operation = context.imageOperation;
    const selection = await this.#admitRequest(normalized.model, principal, context, (model, route, provider) => {
      if (model.capability !== 'image_generation' || typeof provider?.generateImage !== 'function') {
        throw new GatewayError('Choose an image generation model.', 400, 'unsupported_model_capability', 'model');
      }
      if (operation && (model.id !== normalized.model || !provider.recoverImage)) {
        throw new GatewayError('Choose a published Codex image deployment.', 400, 'unsupported_model_capability', 'model');
      }
      if (provider.prepareImage) return provider.prepareImage(model, normalized, body.reference_images?.length ?? 0);
      if (normalized.size !== undefined) {
        throw new GatewayError('This model accepts aspect_ratio instead of size.', 400, 'unsupported_parameter', 'size');
      }
      return normalized;
    });
    const { model, connection, provider, request, quote, run } = selection;
    let usage = null, images = 0;
    try {
      const referenceImages = decodeImageReferences(body.reference_images);
      if (quote) await this.#reserveBudget(selection, context, run.signal);
      run.signal.throwIfAborted();
      if (operation) {
        context.admissionSignal.throwIfAborted();
        await operation.start(connection.timeoutSeconds * 1000);
        run.signal.throwIfAborted();
      }
      context.dispatched = true;
      let imageSaved = false;
      const saveImage = operation && (async image => {
        await operation.save(image);
        imageSaved = true;
      });
      const secret = this.store.decrypt(connection.secret);
      const upstreamInput = { ...request, model: model.nativeId, referenceImages };
      if (!provider.tracesUsage) run.trace.start(upstreamInput, secret);
      const result = await provider.generateImage(connection, upstreamInput,
        { signal: run.signal, model, secret, onIdentity: operation?.onIdentity, onImage: saveImage, trace: run.trace });
      if (!provider.tracesUsage) run.trace.output(result);
      usage = result.usage ?? null;
      images = 1;
      if (operation && !imageSaved) await saveImage(result);
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
  async callService(name, request, principal, context, writeResponse) {
    context.serviceRequest = { pathname: request.pathname, method: request.method };
    const { connection, run, quote } = await this.#admitRequest(name, principal, context, (model, route) => {
      if (model.id !== name || route || model.capability !== 'provider_service') {
        throw new GatewayError('Choose a published provider service.', 400, 'unsupported_model_capability', 'model');
      }
      return {};
    });
    let images = 0;
    try {
      if (quote) throw new GatewayError('This provider service cannot be priced by Model Dock.', 402, 'budget_unpriced_deployment');
      const secret = this.store.decrypt(connection.secret);
      const { method, pathname, search = '', headers, body } = request.prepare
        ? await request.prepare(connection, secret, run.signal) : request;
      const call = serviceRequest(connection, method, pathname, search, headers, body, secret);
      const { operation, ownedId, idempotency } = call;
      if (operation.owned && !await this.serviceOwnership.owns(principal, connection, operation.owned, ownedId)) {
        missing('Provider operation');
      }
      if (idempotency) await this.serviceOwnership.claim(principal, connection, 'operation', idempotency);
      run.signal.throwIfAborted();
      context.dispatched = true;
      run.trace.start(serviceAuditInput(run.trace, body, headers['content-type'] || ''), secret);
      let response;
      try {
        response = await fetch(call.url, { method, headers: call.headers, redirect: 'error', signal: run.signal,
          ...(body.length && { body }) });
      } catch (error) {
        if (run.signal.aborted) throw run.signal.reason;
        throw new GatewayError('Cannot connect to the provider service.', 502, 'upstream_unreachable');
      }
      run.trace.headers(response);
      let taskId = operation.owned === 'task' || operation.owned === 'operation' ? ownedId : null;
      if (response.ok && operation.created) {
        const value = await jsonResponse(response, 512 * 1024);
        const id = serviceJobId(operation.created(value));
        if (id) await this.serviceOwnership.claim(principal, connection, operation.outputKind || 'task', id);
        if (id && operation.outputKind !== 'file') taskId = id;
        response = Response.json(value, { status: response.status });
      }
      const observer = observeServiceUsage(response, run.trace, { method, ownedId: taskId });
      try { await writeResponse(response, run.signal, observer, connection); }
      finally { observer.end(); }
      if (run.trace.metadata.endpoint === 'video' && run.trace.metadata.providerTaskId) {
        context.serviceOperationId = `service:${connection.id}:${run.trace.metadata.providerTaskId}`;
      }
      if (response.ok) {
        if (operation.image) images = 1;
        run.succeed();
      } else {
        run.fail(new GatewayError('Provider service rejected the request.', response.status, 'upstream_rejected'));
      }
    } catch (error) {
      throw run.fail(error);
    } finally {
      run.finish(null, images);
    }
  }
  submitImageOperation(body, principal, context, takeBody, record) {
    const { operation_id: id, ...input } = body;
    const normalized = validateImageGeneration(input);
    const state = this.store.read();
    const key = state.keys.find(item => item.id === principal.id);
    if (!this.#keyAllows(principal, key, normalized.model)) {
      throw new GatewayError('This key cannot use the selected model.', 403, 'model_forbidden');
    }
    const deployment = state.models.find(model => model.id === normalized.model);
    if (state.connections.some(connection => connection.id === deployment?.connectionId && connection.type === 'mflux')) {
      throw new GatewayError('MFLUX returns images synchronously.', 400, 'unsupported_parameter', 'operation_id');
    }
    return this.imageOperations.submit(principal, id, { ...normalized, references: input.reference_images || [] }, async operation => {
      const releaseBody = takeBody();
      let releaseProject;
      const execution = { id: context.id, endpoint: 'images', operationId: id, signal: operation.signal,
        usageTags: context.usageTags, developmentSecrets: context.developmentSecrets,
        admissionSignal: AbortSignal.any([context.signal, operation.signal]), imageOperation: operation };
      try {
        releaseProject = this.admitProjectRequest(principal);
        await this.generateImage(input, principal, execution);
      } finally {
        releaseBody?.();
        releaseProject?.();
        try {
          await this.settleBudget(execution);
          if (execution.completed) await record(execution.completed, execution.development);
        } catch { /* The operation receipt is independent of the usage ledger. */ }
      }
    });
  }
  async close() {
    const shuttingDown = new GatewayError('Gateway is shutting down.', 503, 'shutting_down');
    this.codexQueue?.cancelMatching(() => true, shuttingDown);
    for (const row of this.active.values()) row.controller.abort(shuttingDown);
    await this.imageOperations.close();
    await Promise.allSettled(Object.values(this.providers).map(provider => provider.close?.()));
  }
}
