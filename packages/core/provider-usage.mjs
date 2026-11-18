import { GatewayError } from '../protocol/index.mjs';
import { digest } from './store.mjs';
import { DevelopmentCapture, safeAuditId } from './usage-development.mjs';
import { AI_USAGE_PRICE_BOOK, findAiUsageRate, getAiUsagePriceCatalog } from './usage-price-book.mjs';

const count = (...values) => values.find(value => Number.isSafeInteger(value) && value >= 0);
const quantity = (...values) => values.find(value => Number.isFinite(value) && value >= 0);
const publicHosts = new Map([['api.deepseek.com', 'deepseek'], ['api.minimaxi.com', 'minimax']]);
const deepSeekSearch = getAiUsagePriceCatalog().additionalItems.find(item => item.provider === 'deepseek' && !item.effectiveFrom);
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const validModel = value => typeof value === 'string' && value.length <= 200 && value.split('/').length <= 4
  && value.split('/').every(part => safeAuditId(part));

export function usageTags(headers, token) {
  const fields = { operationId: headers['x-model-dock-operation-id'], feature: headers['x-model-dock-feature'],
    callId: headers['x-model-dock-call-id'] };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !safeAuditId(value, [token]) || value.length > 160) {
      throw new GatewayError('Usage tags must be simple identifiers.', 400, 'invalid_usage_tag', key);
    }
  }
  const rawAttempt = headers['x-model-dock-attempt'];
  if (rawAttempt === undefined) return fields;
  if (typeof rawAttempt !== 'string' || !/^[1-9]\d{0,3}$/.test(rawAttempt) || !fields.operationId) {
    throw new GatewayError('A usage attempt requires an operation ID and a positive attempt number.', 400, 'invalid_usage_tag', 'attempt');
  }
  return { ...fields, attempt: Number(rawAttempt) };
}

export function providerUsageMetrics(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const inputDetails = value.prompt_tokens_details || value.input_tokens_details || {};
  const outputDetails = value.completion_tokens_details || value.output_tokens_details || {};
  const cachedTokens = count(inputDetails.cached_tokens, value.prompt_cache_hit_tokens, value.cache_read_input_tokens, value.cachedInputTokens);
  const cacheWriteTokens = count(inputDetails.cache_write_tokens, value.cache_creation_input_tokens, value.cacheWriteInputTokens);
  const inputTokens = count(value.prompt_tokens, value.input_tokens, value.inputTokens,
    cachedTokens !== undefined && Number.isSafeInteger(value.prompt_cache_miss_tokens) ? cachedTokens + value.prompt_cache_miss_tokens : undefined);
  const outputTokens = count(value.completion_tokens, value.output_tokens, value.outputTokens);
  const reportedTotal = count(value.total_tokens, value.totalTokens);
  const totalTokens = reportedTotal >= (inputTokens || 0) + (outputTokens || 0) ? reportedTotal : undefined;
  const reasoningTokens = count(outputDetails.reasoning_tokens, value.reasoning_tokens, value.reasoningOutputTokens);
  const measures = { inputTokens, outputTokens, totalTokens,
    cachedTokens: inputTokens === undefined || cachedTokens <= inputTokens ? cachedTokens : undefined,
    cacheWriteTokens: inputTokens === undefined || (cachedTokens || 0) + cacheWriteTokens <= inputTokens ? cacheWriteTokens : undefined,
    reasoningTokens: outputTokens === undefined || reasoningTokens <= outputTokens ? reasoningTokens : undefined,
    images: count(value.generated_images, value.image_count),
    videos: count(value.generated_videos, value.video_count),
    mediaSeconds: quantity(value.output_seconds, value.duration_seconds, value.video_duration),
    inputCharacters: count(value.input_characters, value.characters, value.input_character_count) };
  return Object.fromEntries(Object.entries(measures).filter(([, entry]) => entry !== undefined));
}

export function serviceUsageEndpoint(connection, pathname, method) {
  if (pathname === '/chat/completions') return 'chat';
  if (pathname === '/tools/search') return 'search';
  if (pathname === '/embeddings') return 'embeddings';
  if (/\/audio\/transcriptions$/.test(pathname)) return 'transcriptions';
  if (/\/audio\/.*speech/.test(pathname) || pathname === '/v1/t2a_v2') return 'speech';
  if (pathname === '/images/generations' || pathname === '/v1/image_generation') return 'images';
  if (['seedance', 'minimax-video', 'wan', 'local-ltx'].includes(connection.service) && !/\/(?:models|health|credential-probe)$/.test(pathname)) return 'video';
  return method === 'GET' ? 'service-query' : 'service';
}

function sourceOf(connection) {
  const hostname = connection.baseUrl ? new URL(connection.baseUrl).hostname : '';
  const catalogProvider = publicHosts.get(hostname);
  const fallback = connection.type === 'service' ? connection.service.split('-')[0] : connection.type;
  const source = ['codex', 'ollama', 'mflux'].includes(connection.type) || loopback.has(hostname) ? 'local' : 'api';
  const costCategory = connection.type === 'codex' ? 'subscription' : source === 'local' ? 'local' : 'metered';
  return { provider: catalogProvider || fallback, source, costCategory, catalogProvider };
}

function credentialSnapshot(connection, profile) {
  const id = profile?.id || connection.credentialId || connection.id;
  const version = digest(JSON.stringify([id, connection.secret?.iv || null])).slice(0, 12);
  return { id: `${id}-${version}`, name: profile?.name || connection.name, profileId: id, version };
}

function priceSnapshot(catalogProvider, model, endpoint, startedAt, metrics, request, status) {
  if (endpoint === 'search' && catalogProvider === 'deepseek' && status === 'succeeded') {
    const rate = deepSeekSearch;
    return { minimum: rate.amountPerUnit, maximum: rate.amountPerUnit, currency: rate.currency, version: AI_USAGE_PRICE_BOOK.version,
      basis: 'request', snapshot: { ...rate, rateAsOf: AI_USAGE_PRICE_BOOK.rateAsOf } };
  }
  const capability = { chat: 'content_ai', responses: 'content_ai', speech: 'video_tts',
    images: 'image_generation', video: 'video_generation' }[endpoint];
  if (!catalogProvider || !model || !capability) return null;
  const rate = findAiUsageRate(catalogProvider, model, capability, { startedAt, serviceTier: request.speed,
    input_tokens: metrics.inputTokens, resolution: request.resolution });
  if (!rate) return null;
  let minimum, maximum, basis = 'measured';
  if (rate.kind === 'tokens' && metrics.inputTokens != null && metrics.outputTokens != null) {
    const read = metrics.cachedTokens ?? 0, write = metrics.cacheWriteTokens ?? 0;
    if (read + write > metrics.inputTokens) return null;
    const unclassified = metrics.inputTokens - read - write;
    const remainingRates = [rate.inputPerMillion];
    if (metrics.cachedTokens == null) remainingRates.push(rate.cacheReadPerMillion);
    if (metrics.cacheWriteTokens == null && rate.cacheWritePerMillion) remainingRates.push(rate.cacheWritePerMillion);
    const fixed = read * rate.cacheReadPerMillion + write * (rate.cacheWritePerMillion || rate.inputPerMillion) + metrics.outputTokens * rate.outputPerMillion;
    minimum = (fixed + unclassified * Math.min(...remainingRates)) / 1_000_000;
    maximum = (fixed + unclassified * Math.max(...remainingRates)) / 1_000_000 * (rate.maximumTimeMultiplier || 1);
  } else if (rate.kind === 'generated_count' && metrics.images != null) minimum = maximum = metrics.images * rate.amountPerUnit;
  else if (rate.kind === 'characters' && metrics.inputCharacters != null) minimum = maximum = metrics.inputCharacters * rate.amountPerTenThousand / 10_000;
  else if (rate.kind === 'seconds' && status === 'succeeded' && request.inputImages != null && request.requestedSeconds > 0) {
    const outputSeconds = metrics.mediaSeconds ?? request.requestedSeconds;
    const extraImages = Math.max(0, request.inputImages - rate.freeInputImages);
    minimum = maximum = outputSeconds * rate.amountPerSecond + extraImages * rate.inputImagePerUnit;
    basis = metrics.mediaSeconds == null ? 'request' : 'measured';
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum > Number.MAX_SAFE_INTEGER / 1e6) return null;
  return { minimum: Math.round(minimum * 1e6) / 1e6, maximum: Math.round(maximum * 1e6) / 1e6,
    currency: rate.currency, version: rate.version, basis: minimum < maximum ? 'range' : basis, snapshot: rate };
}

export class ProviderUsageTrace {
  constructor({ connection, model, credential, endpoint, tags, development, directory }) {
    const { catalogProvider, ...identity } = sourceOf(connection);
    this.catalogProvider = catalogProvider;
    this.metadata = { ...identity, credential: credentialSnapshot(connection, credential), endpoint,
      capability: model.capability, ...(tags?.feature && { feature: tags.feature }), attempt: tags?.attempt || 1 };
    this.model = model.nativeId;
    this.metrics = {};
    this.request = {};
    // Draft text and detection results stay with the caller's report.
    this.development = connection.service !== 'greyscope' && development ? new DevelopmentCapture(development, directory) : undefined;
  }

  start(input, secret) {
    this.started = Date.now();
    this.secret = secret;
    this.modelName(input?.model);
    const speed = safeAuditId(input?.service_tier || input?.serviceTier, [secret]);
    if (speed) this.request.speed = speed;
    if (['2K', '768P', '720P'].includes(input?.resolution)) this.request.resolution = input.resolution;
    if (this.metadata.endpoint === 'video' && Array.isArray(input?.content)
      && input.content.every(part => ['text', 'image_url', 'audio_url'].includes(part?.type))) {
      this.request.inputImages = input.content.filter(part => part.type === 'image_url').length;
      this.request.requestedSeconds = count(input.duration);
    }
    this.development?.begin(input, secret);
  }

  modelName(value) {
    if (validModel(value) && !(this.secret && value.includes(this.secret))) this.model = value;
  }

  firstResponse() {
    if (this.started && this.metadata.firstResponseMs === undefined) this.metadata.firstResponseMs = Date.now() - this.started;
  }

  headers(response) {
    this.firstResponse();
    this.metadata.httpStatus = response.status;
    this.identify(response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-tt-logid'));
  }

  identify(requestId, taskId) {
    const request = safeAuditId(requestId, [this.secret]), task = safeAuditId(taskId, [this.secret]);
    if (request && !this.metadata.providerRequestId) this.metadata.providerRequestId = request;
    if (task) this.metadata.providerTaskId = task;
  }

  measure(metrics) {
    Object.assign(this.metrics, metrics);
  }

  usage(value) {
    this.measure(providerUsageMetrics(value));
  }

  stopReason(value) {
    const reason = safeAuditId(value, [this.secret]);
    if (reason) this.metadata.finishReason = reason;
  }

  output(value) {
    this.development?.response(value);
  }

  delta(value) {
    this.firstResponse();
    this.development?.delta(value);
  }

  reasoning(value) {
    this.development?.appendReasoning(value);
  }

  replay(turnId) {
    this.replayed = true;
    this.identify(turnId);
  }

  finish({ status, errorCode, usage, images, taskStatus }) {
    const kind = this.replayed ? 'replay' : this.started ? 'provider' : 'setup';
    if (usage && kind === 'provider') {
      for (const [key, value] of Object.entries(providerUsageMetrics(usage))) this.metrics[key] ??= value;
    }
    if (images && kind === 'provider' && !this.providerFailed) this.metrics.images ??= images;
    const outcome = status === 'succeeded' && this.providerFailed ? 'failed' : status;
    const listEstimate = kind === 'provider' && this.metadata.costCategory === 'metered'
      ? priceSnapshot(this.catalogProvider, this.model, this.metadata.endpoint, this.started, this.metrics, this.request, outcome) : null;
    return { ...this.metadata, kind, status: outcome, errorCode: errorCode || (this.providerFailed ? 'provider_application_error' : null),
      taskStatus: this.taskStatus || taskStatus,
      ...(this.mediaTask && { mediaTask: this.mediaTask }),
      ...(this.started && { startedAt: new Date(this.started).toISOString(), durationMs: Date.now() - this.started }),
      actualModel: this.model, ...(this.request.speed && { speed: this.request.speed }),
      metrics: this.metrics, listEstimate };
  }
}
