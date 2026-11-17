import { GatewayError, exact, string } from '../protocol/index.mjs';

export const activeModel = (state, model) => model.enabled && model.available !== false
  && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);

const capabilityKeys = ['text', 'tools', 'structured', 'thinking', 'image_input'];

export function modelMetadata(model) {
  const declared = model.reasoningEfforts || [];
  const allowed = model.reasoningPolicy?.allowedEfforts || declared;
  return {
    capabilities: { ...Object.fromEntries(capabilityKeys.map(key => [key, typeof model.capabilities?.[key] === 'boolean' ? model.capabilities[key] : null])),
      ...(model.capability === 'image_generation' ? { image_generation: true } : {}) },
    context_window: model.contextWindow || null,
    ...(model.imageSizes && { image_sizes: model.imageSizes, max_reference_images: model.maxReferenceImages, model_revision: model.revision }),
    reasoning_efforts: declared.filter(level => allowed.includes(level)),
    default_reasoning_effort: model.reasoningPolicy?.defaultEffort || model.defaultEffort || null
  };
}

function deployment(state, id) {
  const model = state.models.find(model => model.id === id);
  const connection = model && state.connections.find(connection => connection.id === model.connectionId);
  return connection ? { model, connection } : null;
}

export function normalizeModelPool(state, input, previous) {
  exact(input, ['revision', 'name', 'modelIds', 'enabled']);
  if (!Array.isArray(input.modelIds) || input.modelIds.length < 2 || new Set(input.modelIds).size !== input.modelIds.length
    || input.modelIds.some(id => typeof id !== 'string') || typeof input.enabled !== 'boolean') {
    throw new GatewayError('Choose at least two independent deployments of the same model.', 400, 'invalid_model_pool');
  }
  const name = string(input.name, 'pool name', 100);
  if (previous && input.modelIds.length === previous.modelIds.length && input.modelIds.every((id, index) => id === previous.modelIds[index])) {
    return { ...previous, name, enabled: input.enabled };
  }
  if (input.modelIds.length > state.models.length) throw new GatewayError('Some pool deployments no longer exist.', 400, 'incompatible_pool_members');
  const deployments = input.modelIds.map(id => deployment(state, id));
  const first = deployments[0];
  if (!first || deployments.some(item => !item || item.model.nativeId !== first.model.nativeId
    || item.connection.type !== first.connection.type || item.model.capability !== first.model.capability)
    || previous && (first.model.nativeId !== previous.nativeId || first.connection.type !== previous.providerType
      || (first.model.capability ?? null) !== previous.capability)
    || new Set(deployments.map(item => item.connection.baseUrl)).size !== deployments.length) {
    throw new GatewayError('Pool members must use the same model and adapter at distinct upstream endpoints.', 400, 'incompatible_pool_members');
  }
  return { name, modelIds: [...input.modelIds], enabled: input.enabled,
    nativeId: first.model.nativeId, providerType: first.connection.type, capability: first.model.capability ?? null };
}

export function poolMembers(state, pool) {
  const endpoints = new Set();
  return pool.modelIds.map(id => {
    const item = deployment(state, id);
    if (!item) return { id, available: false };
    const { model, connection } = item;
    const available = activeModel(state, model) && model.nativeId === pool.nativeId && connection.type === pool.providerType
      && (model.capability ?? null) === pool.capability && !endpoints.has(connection.baseUrl);
    if (available) endpoints.add(connection.baseUrl);
    return { ...item, id, available };
  });
}

export function poolMetadata(pool, members) {
  const models = members.filter(member => member.available).map(member => modelMetadata(member.model));
  const capabilities = Object.fromEntries(capabilityKeys.map(key => {
    const values = models.map(model => model.capabilities[key]);
    return [key, values.includes(false) ? false : values.length && values.every(value => value === true) ? true : null];
  }));
  if (pool.capability === 'image_generation') capabilities.image_generation = true;
  const contexts = models.map(model => model.context_window);
  const reasoning = (models[0]?.reasoning_efforts || []).filter(level => models.every(model => model.reasoning_efforts.includes(level)));
  const defaultEffort = models[0]?.default_reasoning_effort;
  return { capabilities, context_window: contexts.length && contexts.every(Boolean) ? contexts.reduce((left, right) => Math.min(left, right)) : null,
    reasoning_efforts: reasoning, default_reasoning_effort: reasoning.includes(defaultEffort)
      && models.every(model => model.default_reasoning_effort === defaultEffort) ? defaultEffort : null };
}

export function poolSupports(model, request) {
  const capabilities = model.capabilities || {};
  if (capabilities.text === false || request.tools?.length && capabilities.tools === false
    || request.response_format && request.response_format.type !== 'text' && capabilities.structured === false) return false;
  const effort = request.reasoning_effort;
  if (effort && (effort !== 'none' && capabilities.thinking === false || model.reasoningEfforts?.length && !model.reasoningEfforts.includes(effort))) return false;
  const outputLimit = request.max_completion_tokens ?? request.max_tokens;
  return !outputLimit || !model.maxOutputTokens || outputLimit <= model.maxOutputTokens;
}

export function cooldownUntil(error, now) {
  if (!(error instanceof GatewayError) || !(['upstream_rate_limited', 'upstream_unreachable', 'upstream_auth_failed',
    'upstream_protocol_error', 'request_timeout'].includes(error.code)
    || error.code === 'upstream_rejected' && error.status === 502)) return 0;
  const retryAfter = error.retryAfter;
  const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
    : retryAfter ? Date.parse(retryAfter) - now : 30_000;
  return now + (Number.isFinite(delay) ? Math.max(1_000, Math.min(delay, 2_147_483_647)) : 30_000);
}
