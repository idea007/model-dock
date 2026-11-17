import { GatewayError } from '../protocol/index.mjs';
import { csvCell, localDay, retentionDays } from './usage.mjs';

const pageSize = 50;
const compareCalls = (left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id);

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toJSON()?.slice(0, 10) === value;
}

export function usageAnalyticsQuery(parameters, now = Date.now()) {
  const earliest = localDay(now, 1 - retentionDays), latest = localDay(now);
  const dateFrom = parameters.get('dateFrom') || earliest, dateTo = parameters.get('dateTo') || latest;
  const mode = parameters.get('mode') || 'operations', offset = Number(parameters.get('offset') || 0);
  const costOffset = Number(parameters.get('costOffset') ?? offset);
  const operation = parameters.get('operation') || '';
  const version = parameters.get('version') === '2' ? 2 : 1;
  if (!validDate(dateFrom) || !validDate(dateTo) || dateFrom > dateTo) {
    throw new GatewayError('Choose a valid start and end date.', 400, 'invalid_usage_dates');
  }
  if (!['operations', 'calls'].includes(mode) || [offset, costOffset].some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new GatewayError('Choose a valid view and page.', 400, 'invalid_usage_page');
  }
  const filters = ['project', 'credential', 'model', 'provider', 'endpoint'];
  if (version === 1) filters.push('feature');
  return { dateFrom, dateTo, earliest, latest, mode, offset, costOffset, operation, version,
    ...Object.fromEntries(filters.map(key => [key, parameters.get(key) || ''])) };
}

function describeEndpoint(endpoint, capability) {
  if (endpoint === 'images' || capability === 'image_generation') return ['images', 'image', 'generate'];
  if (endpoint === 'chat' || endpoint === 'responses') return [endpoint, 'text', 'generate'];
  if (endpoint === 'embeddings') return [endpoint, 'embedding', 'understand'];
  if (endpoint === 'speech') return [endpoint, 'audio', 'generate'];
  if (endpoint === 'transcriptions') return [endpoint, 'audio', 'understand'];
  if (endpoint === 'video') return [endpoint, 'video', 'generate'];
  if (endpoint === 'search' || endpoint === 'service-query') return [endpoint, 'unknown', 'understand'];
  return ['service', 'unknown', 'unknown'];
}

function callRecord(row) {
  const audit = row.audit || {};
  const startedAt = audit.startedAt || row.startedAt || row.finishedAt;
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(row.finishedAt)) || typeof row.id !== 'string') return null;
  const day = localDay(startedAt);
  const [endpoint, modality, direction] = describeEndpoint(audit.endpoint || row.endpoint, audit.capability);
  const feature = audit.feature || endpoint;
  const operation = row.operationId ? JSON.stringify([row.principalId, row.operationId]) : '';
  const credential = audit.credential || { id: 'unknown', name: '' };
  const modelKey = row.endpoint === 'service' && audit.actualModel && audit.actualModel !== row.nativeModel
    ? JSON.stringify([row.modelId, audit.actualModel]) : row.modelId;
  return { ...row, gatewayStatus: row.status, gatewayErrorCode: row.errorCode, status: audit.status || row.status,
    errorCode: audit.errorCode ?? row.errorCode, durationMs: audit.durationMs ?? row.durationMs,
    images: audit.metrics?.images ?? (audit.errorCode === 'provider_application_error' ? 0 : row.images),
    nativeModel: audit.actualModel || row.nativeModel, modelKey, startedAt, day, hour: new Date(startedAt).getHours(), feature, endpoint, modality, direction, operation, credential,
    provider: audit.provider || row.provider || 'unknown', kind: audit.kind || 'legacy',
    source: audit.source || (['codex', 'mflux', 'ollama'].includes(row.provider) ? 'local' : 'unknown') };
}

async function* allUsageCalls(ledger, signal) {
  const meteredVideo = new Set();
  for await (const row of ledger.rows(retentionDays, signal)) {
    const call = callRecord(row);
    if (!call) { ledger.writeFailed = true; continue; }
    if (call.audit?.mediaTask) {
      const key = JSON.stringify([call.connectionId, call.credential.id, call.audit.mediaTask]);
      if (meteredVideo.has(key)) {
        const { videos, mediaSeconds, ...metrics } = call.audit.metrics;
        call.audit = { ...call.audit, metrics, listEstimate: null };
      } else meteredVideo.add(key);
    }
    yield call;
  }
}

function inPeriod(call, query) {
  return call.day >= query.dateFrom && call.day <= query.dateTo && call.day >= query.earliest && call.day <= query.latest;
}

function matches(call, query) {
  return (!query.project || call.principalId === query.project)
    && (!query.credential || call.credential.id === query.credential)
    && (!query.provider || call.provider === query.provider)
    && (!query.model || call.modelKey === query.model || call.modelId === query.model)
    && (!query.endpoint || call.endpoint === query.endpoint)
    && (!query.feature || call.feature === query.feature)
    && (!query.operation || call.operation === query.operation);
}

function emptyUsage() {
  return { rows: 0, calls: 0, legacy: 0, replayed: 0, succeeded: 0, failed: 0, cancelled: 0, retries: 0,
    reported: 0, textCalls: 0, tokenCount: 0, totalTokens: 0, inputCount: 0, inputTokens: 0, outputCount: 0, outputTokens: 0,
    cacheCount: 0, cacheInput: 0, cachedTokens: 0, cacheWriteCount: 0, cacheWriteTokens: 0, reasoningCount: 0, reasoningTokens: 0,
    images: 0, videos: 0, mediaSeconds: 0, inputCharacters: 0, eligible: 0, priced: 0, exactPriced: 0, rangePriced: 0,
    configuredPriced: 0, costs: {}, configuredCosts: {} };
}

export function usageCostCategory(call) {
  const category = call.audit?.costCategory;
  if (category) return category;
  if (call.source === 'local') return 'local';
  return call.source === 'api' ? 'metered' : 'unknown';
}

function addAmount(group, estimate) {
  if (!estimate) return;
  const range = group[estimate.currency] ??= { minimum: 0, maximum: 0 };
  range.minimum += estimate.minimum ?? estimate.amount;
  range.maximum += estimate.maximum ?? estimate.amount;
}

function tally(target, call) {
  target.rows++;
  if (call.kind === 'replay') { target.replayed++; return; }
  if (call.kind === 'setup') return;
  target.calls++;
  if (call.kind === 'legacy') target.legacy++;
  target[call.status]++;
  if (call.audit?.attempt > 1) target.retries++;
  if (['text', 'embedding'].includes(call.modality)) target.textCalls++;
  const metrics = call.audit?.metrics || {};
  const input = metrics.inputTokens ?? call.usage?.prompt_tokens;
  const output = metrics.outputTokens ?? call.usage?.completion_tokens;
  const total = metrics.totalTokens ?? call.usage?.total_tokens ?? (input != null && output != null ? input + output : null);
  if (call.usage || Object.keys(metrics).length) target.reported++;
  if (input != null) { target.inputCount++; target.inputTokens += input; }
  if (output != null) { target.outputCount++; target.outputTokens += output; }
  if (total != null) target.tokenCount++;
  target.totalTokens += total ?? (input ?? 0) + (output ?? 0);
  if (metrics.cachedTokens != null && input != null) {
    target.cacheCount++; target.cacheInput += input; target.cachedTokens += metrics.cachedTokens;
  }
  if (metrics.cacheWriteTokens != null) { target.cacheWriteCount++; target.cacheWriteTokens += metrics.cacheWriteTokens; }
  if (metrics.reasoningTokens != null) { target.reasoningCount++; target.reasoningTokens += metrics.reasoningTokens; }
  target.images += metrics.images ?? call.images ?? 0;
  target.videos += metrics.videos ?? 0;
  target.mediaSeconds += metrics.mediaSeconds ?? 0;
  target.inputCharacters += metrics.inputCharacters ?? 0;
  if (usageCostCategory(call) === 'metered') target.eligible++;
  if (call.audit?.listEstimate) {
    target.priced++;
    target[call.audit.listEstimate.basis === 'request' || call.audit.listEstimate.minimum < call.audit.listEstimate.maximum ? 'rangePriced' : 'exactPriced']++;
    addAmount(target.costs, call.audit.listEstimate);
  }
  if (call.estimate) { target.configuredPriced++; addAmount(target.configuredCosts, call.estimate); }
}

function group(entries, key, fields, call) {
  if (!entries.has(key)) entries.set(key, { key, ...fields, ...emptyUsage() });
  tally(entries.get(key), call);
}

function addGroups(groups, call) {
  group(groups.sources, call.source, {}, call);
  group(groups.costCategories, usageCostCategory(call), {}, call);
  group(groups.projects, call.principalId, { label: call.projectName }, call);
  group(groups.models, call.modelKey, { label: call.nativeModel || call.modelName, provider: call.provider, connection: call.connectionName }, call);
  group(groups.credentials, call.credential.id, { label: call.credential.name }, call);
  group(groups.modalities, call.modality, {}, call);
  group(groups.directions, call.direction, {}, call);
  group(groups.daily, call.day, {}, call);
  group(groups.hourly, `${call.day}T${String(call.hour).padStart(2, '0')}`, { day: call.day }, call);
  if (groups.endpoints) group(groups.endpoints, call.endpoint, {}, call);
  else {
    group(groups.features, call.feature, {}, call);
    group(groups.matrix, JSON.stringify([call.feature, call.modelKey]), { feature: call.feature, model: call.modelKey }, call);
  }
}

function addOption(map, id, label, extra = {}) {
  const value = map.get(id) || { id, label, ...extra, count: 0 };
  value.count++;
  map.set(id, value);
}

function paginate(query, rows) {
  const offset = Math.min(query.offset, rows.length ? Math.floor((rows.length - 1) / pageSize) * pageSize : 0);
  return { rows: rows.slice(offset, offset + pageSize),
    pagination: { offset, limit: pageSize, total: rows.length, hasMore: offset + pageSize < rows.length } };
}

function groupOperations(calls, facts, dimension) {
  const operations = new Map();
  for (const call of calls) {
    const key = call.operation || call.id;
    if (!operations.has(key)) operations.set(key, { key, operation: call.operation, representative: call, count: 0, stats: emptyUsage(),
      providers: new Set(), types: new Set(), credentials: new Set() });
    const entry = operations.get(key);
    entry.count++;
    entry.providers.add(call.modelKey);
    entry.types.add(call[dimension]);
    entry.credentials.add(call.credential.id);
    tally(entry.stats, call);
  }
  return Array.from(operations.values(), ({ providers, types, credentials, ...entry }) => {
    const full = facts.get(entry.operation);
    return { ...entry, providerCount: providers.size, [`${dimension}Count`]: types.size, credentialCount: credentials.size,
      taskStatus: full?.status ?? null, taskDuration: full ? Date.parse(full.finishedAt) - Date.parse(full.startedAt) : null };
  });
}

function endpointRecord({ feature, ...call }) {
  if (call.audit && Object.hasOwn(call.audit, 'feature')) {
    const { feature, ...audit } = call.audit;
    call.audit = audit;
  }
  return call;
}

export async function usageAnalytics(ledger, query, signal, reconciliation = Object.create(null)) {
  const calls = [], facts = new Map(), summary = emptyUsage();
  const endpointView = query.version === 2;
  const dimension = endpointView ? 'endpoint' : 'feature';
  const groupKey = `${dimension}s`;
  const groupKeys = ['sources', 'costCategories', 'projects', groupKey, 'models', 'credentials', 'modalities', 'directions', 'daily', 'hourly'];
  if (!endpointView) groupKeys.push('matrix');
  const groups = Object.fromEntries(groupKeys.map(key => [key, new Map()]));
  const options = { projects: new Map(), credentials: new Map(), models: new Map(), [groupKey]: new Map(), accounts: new Map() };
  for await (const call of allUsageCalls(ledger, signal)) {
    if (call.operation) {
      const fact = facts.get(call.operation);
      if (!fact) facts.set(call.operation, { startedAt: call.startedAt, finishedAt: call.finishedAt, status: call.audit?.taskStatus });
      else {
        if (call.startedAt < fact.startedAt) fact.startedAt = call.startedAt;
        if (call.finishedAt > fact.finishedAt) {
          fact.finishedAt = call.finishedAt;
          fact.status = call.audit?.taskStatus;
        }
      }
    }
    if (!inPeriod(call, query)) continue;
    addOption(options.projects, call.principalId, call.projectName);
    if (query.project && call.principalId !== query.project) continue;
    addOption(options.credentials, call.credential.id, call.credential.name, { provider: call.provider, version: call.credential.version });
    if (['provider', 'legacy'].includes(call.kind)) addOption(options.accounts, JSON.stringify([call.provider, call.credential.id]), call.credential.name,
      { provider: call.provider, credential: call.credential.id, version: call.credential.version });
    if (!query.credential || call.credential.id === query.credential) {
      addOption(options.models, call.modelKey, call.nativeModel || call.modelName, { connection: call.connectionName, provider: call.provider });
      if (!query.model || call.modelKey === query.model || call.modelId === query.model) {
        addOption(options[groupKey], call[dimension], call[dimension]);
      }
    }
    if (!matches(call, query)) continue;
    calls.push(endpointView ? endpointRecord(call) : call);
    tally(summary, call);
    if (!query.operation) addGroups(groups, call);
  }
  signal.throwIfAborted();
  calls.sort(compareCalls);
  const operations = groupOperations(calls, facts, dimension);
  const rows = query.mode === 'operations' ? operations : calls;
  const page = paginate(query, rows);
  const billable = calls.filter(call => ['provider', 'legacy'].includes(call.kind));
  const costPage = paginate({ ...query, offset: query.costOffset ?? query.offset }, billable);
  const reconciled = billable.reduce((total, call) => {
    const entry = reconciliation[call.id];
    if (entry) {
      total.count++;
      addAmount(total.amounts, entry);
      if (['mismatch', 'currency_mismatch'].includes(entry.status)) total.mismatches++;
    }
    return total;
  }, { count: 0, mismatches: 0, amounts: {} });
  const byKey = ({ key: left }, { key: right }) => left.localeCompare(right);
  return { ...page, summary: { ...summary, operations: operations.filter(operation => operation.operation).length,
      standalone: operations.filter(operation => !operation.operation).length },
    groups: Object.fromEntries(groupKeys.map(key => [key, Array.from(groups[key].values())
      .sort(['daily', 'hourly'].includes(key) ? byKey : (left, right) => right.calls - left.calls || byKey(left, right))])),
    options: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, [...value.values()]])),
    bounds: { earliest: query.earliest, latest: query.latest }, writeFailed: ledger.writeFailed,
    cost: { ...costPage, rows: costPage.rows.map(call => ({ ...call, reconciliation: reconciliation[call.id] })), reconciled } };
}

export async function findUsageCall(ledger, id, signal) {
  for await (const call of allUsageCalls(ledger, signal)) if (call.id === id) return call;
  throw new GatewayError('This call is outside the retained history.', 404, 'usage_call_missing');
}

export async function* billableUsageCalls(ledger, query, signal) {
  for await (const call of allUsageCalls(ledger, signal)) {
    if (inPeriod(call, query) && matches(call, query) && ['provider', 'legacy'].includes(call.kind)) yield call;
  }
}

const csvColumns = [
  'call_id', 'started_at', 'finished_at', 'project_id', 'project', 'operation_id', 'feature', 'provider', 'model_id', 'model', 'connection',
  'credential_id', 'credential', 'record_kind', 'attempt', 'status', 'duration_ms', 'first_response_ms', 'http_status',
  'provider_request_id', 'provider_task_id', 'input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens',
  'total_tokens', 'images', 'videos', 'media_seconds', 'estimated_currency', 'estimated_minimum', 'estimated_maximum', 'price_version',
  'configured_currency', 'configured_estimate', 'billed_currency', 'billed_amount', 'reconciliation', 'statement_reference', 'error_code',
  'actual_model', 'gateway_status', 'gateway_error_code'
];

export async function* usageCallsCsv(ledger, query, signal, reconciliation = Object.create(null)) {
  const dimension = query.version === 2 ? 'endpoint' : 'feature';
  const columns = csvColumns.map(column => column === 'feature' ? dimension : column);
  yield `\uFEFF${columns.join(',')}\r\n`;
  for await (const call of allUsageCalls(ledger, signal)) {
    if (!inPeriod(call, query) || !matches(call, query)) continue;
    const audit = call.audit || {}, metrics = audit.metrics || {}, estimate = audit.listEstimate, billed = reconciliation[call.id];
    const cells = [
      call.id, call.startedAt, call.finishedAt, call.principalId, call.projectName, call.operationId, call[dimension], call.provider, call.modelId,
      call.modelName, call.connectionName, call.credential.id, call.credential.name, call.kind, audit.attempt, call.status, call.durationMs,
      audit.firstResponseMs, audit.httpStatus, audit.providerRequestId, audit.providerTaskId, metrics.inputTokens ?? call.usage?.prompt_tokens,
      metrics.cachedTokens, metrics.cacheWriteTokens, metrics.outputTokens ?? call.usage?.completion_tokens, metrics.reasoningTokens,
      metrics.totalTokens ?? call.usage?.total_tokens, metrics.images ?? call.images, metrics.videos, metrics.mediaSeconds,
      estimate?.currency, estimate?.minimum, estimate?.maximum, estimate?.version, call.estimate?.currency, call.estimate?.amount,
      billed?.currency, billed?.amount, billed?.status, billed?.reference, call.errorCode,
      call.nativeModel, call.gatewayStatus, call.gatewayErrorCode
    ];
    yield `${cells.map(csvCell).join(',')}\r\n`;
  }
}
