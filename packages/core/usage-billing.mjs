import fs from 'node:fs/promises';
import path from 'node:path';
import { GatewayError, exact } from '../protocol/index.mjs';
import { billableUsageCalls, findUsageCall, usageAnalyticsQuery } from './usage-analytics.mjs';
import { safeAuditId } from './usage-development.mjs';
import { digest, newId, writePrivateJson } from './store.mjs';

const columns = ['statement_reference', 'provider_request_id', 'provider_task_id', 'call_id', 'currency', 'amount'];
const maxRows = 1000;
const units = 1_000_000;
export const usageStatementTemplate = `\uFEFF${columns.join(',')}\r\n`;
const invalid = message => new GatewayError(message, 422, 'invalid_usage_statement');
const conflict = () => new GatewayError('This statement reference already has different data. Use a correction reference.', 409, 'usage_statement_conflict');
const unavailable = () => new GatewayError('The local reconciliation ledger is unavailable.', 503, 'usage_billing_unavailable');

function amountFields(currency, value) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw invalid('Use a three-letter uppercase currency code.');
  }
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,6})?$/.test(value)) {
    throw invalid('Enter a non-negative amount with up to six decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const amountMicros = Number(whole) * units + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(amountMicros)) throw invalid('This statement amount is too large.');
  return { currency, amountMicros, amount: amountMicros / units };
}

function statementId(value, required = false) {
  if ((!value && !required) || safeAuditId(value)) return value || '';
  throw invalid('Use only letters, numbers, periods, underscores, colons and dashes in statement identifiers.');
}

function parseCsv(csv) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv) > 1024 * 1024) throw invalid('A statement CSV may be at most 1 MiB.');
  const rows = [], row = [];
  let cell = '', quoted = false, closed = false;
  const finishCell = () => {
    row.push(cell.trim());
    if (row.length > columns.length) throw invalid('Use the statement template columns.');
    cell = '';
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) rows.push([...row]);
    row.length = 0;
    if (rows.length > maxRows + 1) throw invalid('Import up to 1,000 rows at a time.');
  };
  const source = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      finishRow();
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw invalid('The CSV contains an invalid quoted field.');
    else cell += char;
    if (cell.length > 250) throw invalid('The CSV contains a field longer than 250 characters.');
  }
  if (quoted) throw invalid('A quoted CSV field is not closed.');
  if (cell || row.length || closed) finishRow();
  const headers = rows.shift() || [];
  if (!rows.length || new Set(headers).size !== headers.length || headers.some(key => !columns.includes(key))
    || !['statement_reference', 'currency', 'amount'].every(key => headers.includes(key))) {
    throw invalid('Use the statement template and include at least one billing row.');
  }
  const references = new Set();
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw invalid(`CSV row ${index + 2} has an unexpected column count.`);
    const raw = Object.fromEntries(headers.map((key, position) => [key, values[position]]));
    const reference = statementId(raw.statement_reference, true);
    if (references.has(reference)) throw invalid('A statement reference appears more than once.');
    references.add(reference);
    return { reference, requestId: statementId(raw.provider_request_id), taskId: statementId(raw.provider_task_id),
      callId: statementId(raw.call_id), ...amountFields(raw.currency, raw.amount) };
  });
}

function statementScope(input) {
  exact(input, ['provider', 'credential', 'dateFrom', 'dateTo', 'csv', 'previewHash']);
  if (!safeAuditId(input.provider) || !safeAuditId(input.credential)
    || typeof input.dateFrom !== 'string' || !input.dateFrom || typeof input.dateTo !== 'string' || !input.dateTo) {
    throw invalid('Choose a provider, historical credential and statement dates.');
  }
  const params = new URLSearchParams({ provider: input.provider, credential: input.credential,
    dateFrom: input.dateFrom, dateTo: input.dateTo });
  const query = usageAnalyticsQuery(params);
  const duration = Date.parse(query.dateTo) - Date.parse(query.dateFrom);
  if (duration >= 366 * 86_400_000) throw invalid('A statement period may be at most 366 days.');
  return query;
}

function estimateOf(call) {
  const estimate = call.audit?.listEstimate || call.estimate;
  return estimate && { currency: estimate.currency, minimum: estimate.minimum ?? estimate.amount,
    maximum: estimate.maximum ?? estimate.amount, version: estimate.version || '' };
}

function compare(estimate, row) {
  if (!estimate) return 'unpriced';
  if (row.currency !== estimate.currency) return 'currency_mismatch';
  const lower = Math.round(estimate.minimum * units), upper = Math.round(estimate.maximum * units);
  return row.amountMicros >= lower && row.amountMicros <= upper ? 'matched' : 'mismatch';
}

function sameRow(previous, row) {
  return previous.currency === row.currency && previous.amountMicros === row.amountMicros
    && previous.requestId === row.requestId && previous.taskId === row.taskId && previous.callId === row.callId;
}

function identifierKeys(call) {
  return [['callId', call.id], ['requestId', call.audit?.providerRequestId], ['taskId', call.audit?.providerTaskId]];
}

async function preview(state, ledger, input, signal) {
  const query = statementScope(input);
  const statement = parseCsv(input.csv);
  const { provider, credential, dateFrom, dateTo } = query;
  const existing = new Map();
  for (const batch of state.batches) {
    if (batch.provider === provider && batch.credential === credential) for (const row of batch.rows) existing.set(row.reference, { ...row, batchId: batch.id });
  }
  const byIdentifier = new Map();
  const targetIds = new Set(statement.flatMap(row => ['callId', 'requestId', 'taskId'].filter(key => row[key]).map(key => `${key}:${row[key]}`)));
  const ledgerCalls = [];
  for await (const call of billableUsageCalls(ledger, query, signal)) {
    if (credential === 'unknown' && call.kind !== 'legacy') continue;
    ledgerCalls.push({ id: call.id, model: call.nativeModel || call.modelName, startedAt: call.startedAt });
    for (const [type, id] of identifierKeys(call)) {
      if (!id || credential === 'unknown' && type !== 'callId') continue;
      const key = `${type}:${id}`;
      if (!targetIds.has(key)) continue;
      if (!byIdentifier.has(key)) byIdentifier.set(key, []);
      byIdentifier.get(key).push(call);
    }
  }
  const covered = new Set();
  const reconciliations = new Map(state.entries.map(entry => [JSON.stringify([entry.callId, entry.reference]), entry]));
  const rows = statement.map(row => {
    const previous = existing.get(row.reference);
    if (previous && !sameRow(previous, row)) throw conflict();
    const criteria = ['callId', 'requestId', 'taskId'].filter(key => row[key]);
    const candidates = criteria.length ? (byIdentifier.get(`${criteria[0]}:${row[criteria[0]]}`) || []).filter(call =>
      identifierKeys(call).every(([key, id]) => !row[key] || id === row[key])) : [];
    const call = candidates.length === 1 ? candidates[0] : null;
    const matchedCallId = previous ? previous.matchedCallId : call?.id || null;
    const estimate = previous ? previous.estimate : call && estimateOf(call);
    const reconciled = matchedCallId && reconciliations.get(JSON.stringify([matchedCallId, row.reference]));
    if (reconciled && (reconciled.amountMicros !== row.amountMicros || reconciled.currency !== row.currency)) throw conflict();
    const status = previous ? previous.status : reconciled ? reconciled.status : call ? compare(estimate, row) : candidates.length ? 'ambiguous' : 'unmatched';
    if (matchedCallId) {
      if (covered.has(matchedCallId)) throw invalid('Combine all line items for a single call into one statement row.');
      covered.add(matchedCallId);
    }
    return { ...row, matchedCallId, estimate, status, alreadyReconciled: Boolean(reconciled),
      duplicate: Boolean(previous), ...(previous && { batchId: previous.batchId }) };
  });
  const alreadyReconciled = new Set(state.entries.map(entry => entry.callId));
  const localOnly = ledgerCalls.filter(call => !covered.has(call.id) && !alreadyReconciled.has(call.id));
  const currencies = {};
  const summary = { rowCount: rows.length, duplicate: 0, matched: 0, manual_match: 0, mismatch: 0, unpriced: 0, currency_mismatch: 0, unmatched: 0, ambiguous: 0,
    localOnly: localOnly.length };
  for (const row of rows) {
    summary[row.status]++;
    if (row.duplicate) summary.duplicate++;
    currencies[row.currency] = (currencies[row.currency] || 0) + row.amountMicros;
    if (!Number.isSafeInteger(currencies[row.currency])) throw invalid('The statement total is too large.');
  }
  const report = { provider, credential, dateFrom, dateTo, rows, summary,
    currencies: Object.entries(currencies).map(([currency, amount]) => ({ currency, amount: amount / units })),
    localOnly: localOnly.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50) };
  return { ...report, previewHash: digest(JSON.stringify(report)) };
}

function validateLedger(state) {
  const validAmount = row => /^[A-Z]{3}$/.test(row?.currency || '') && Number.isSafeInteger(row.amountMicros) && row.amountMicros >= 0;
  return state?.version === 1 && Array.isArray(state.entries) && Array.isArray(state.batches)
    && state.entries.every(row => validAmount(row) && typeof row.callId === 'string' && typeof row.reference === 'string')
    && state.batches.every(batch => typeof batch?.id === 'string' && Array.isArray(batch.rows) && batch.rows.every(validAmount));
}

export class UsageBilling {
  constructor(directory) {
    this.file = path.join(directory, 'usage-billing.json');
    this.state = { version: 1, entries: [], batches: [] };
    this.queue = Promise.resolve();
  }

  async open() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!validateLedger(state)) throw unavailable();
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') this.writeFailed = true;
    }
  }

  latest() {
    const result = Object.create(null);
    for (const entry of this.state.entries) result[entry.callId] = entry;
    return result;
  }

  requireLedger() {
    if (this.writeFailed) throw unavailable();
    return this.state;
  }

  write(operation, signal) {
    const result = this.queue.then(async () => {
      signal.throwIfAborted();
      const { next, value } = await operation(this.requireLedger());
      signal.throwIfAborted();
      if (next) {
        try { await writePrivateJson(this.file, next); }
        catch { throw unavailable(); }
        this.state = next;
      }
      return value;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  preview(ledger, body, signal) {
    return preview(this.requireLedger(), ledger, body, signal);
  }

  import(ledger, body, signal) {
    if (!/^[a-f0-9]{64}$/.test(body?.previewHash || '')) throw invalid('Preview the statement before importing.');
    return this.write(async state => {
      const report = await preview(state, ledger, body, signal);
      const { rows, summary, provider, credential, dateFrom, dateTo } = report;
      if (rows.every(row => row.duplicate)) return { value: { id: rows[0].batchId, created: false, report } };
      if (report.previewHash !== body.previewHash) throw new GatewayError('These matches have changed. Preview the statement again.', 409, 'usage_statement_changed');
      const id = newId('statement'), createdAt = new Date().toISOString();
      const savedRows = rows.filter(row => !row.duplicate).map(({ duplicate, ...row }) => row);
      const batch = { id, provider, credential, dateFrom, dateTo, createdAt, rows: savedRows,
        summary: { ...summary, rowCount: savedRows.length } };
      const entries = savedRows.filter(row => row.matchedCallId && !row.alreadyReconciled).map(row => ({
        id: newId('reconcile'), callId: row.matchedCallId, reference: row.reference, amount: row.amount,
        amountMicros: row.amountMicros, currency: row.currency, status: row.status, estimate: row.estimate, createdAt, batchId: id
      }));
      return { next: { ...state, batches: [...state.batches, batch], entries: [...state.entries, ...entries] },
        value: { id, created: true, report } };
    }, signal);
  }

  reconcile(ledger, input, signal) {
    exact(input, ['callId', 'reference', 'currency', 'amount', 'manuallyVerified']);
    const callId = statementId(input.callId, true), reference = statementId(input.reference, true);
    const amount = amountFields(input.currency, input.amount);
    if (input.manuallyVerified !== undefined && typeof input.manuallyVerified !== 'boolean') throw invalid('Choose a valid reconciliation outcome.');
    return this.write(async state => {
      const previous = state.entries.find(row => row.callId === callId && row.reference === reference);
      if (previous) {
        if (previous.amountMicros !== amount.amountMicros || previous.currency !== amount.currency
          || (previous.status === 'manual_match') !== Boolean(input.manuallyVerified)) throw conflict();
        return { value: previous };
      }
      const call = await findUsageCall(ledger, callId, signal);
      if (!['provider', 'legacy'].includes(call.kind)) throw invalid('This record has no billable provider call.');
      const estimate = estimateOf(call);
      const row = { id: newId('reconcile'), callId, reference, ...amount, estimate,
        status: input.manuallyVerified ? 'manual_match' : compare(estimate, amount), createdAt: new Date().toISOString() };
      return { next: { ...state, entries: [...state.entries, row] }, value: row };
    }, signal);
  }

  imports() {
    return this.requireLedger().batches.slice(-20).reverse().map(({ rows, ...batch }) => batch);
  }

  batch(id) {
    const batch = this.requireLedger().batches.find(row => row.id === id);
    if (!batch) throw new GatewayError('This statement import was not found.', 404, 'usage_statement_missing');
    return batch;
  }

  callHistory(id) {
    return this.requireLedger().entries.filter(row => row.callId === id).reverse();
  }
}
