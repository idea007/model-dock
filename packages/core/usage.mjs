import fs from 'node:fs/promises';
import path from 'node:path';
import { GatewayError, exact } from '../protocol/index.mjs';

export const retentionDays = 30;
const detailLimit = 100;
const dayFile = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function localDay(value, offset = 0) {
  const date = new Date(value);
  date.setDate(date.getDate() + offset);
  const digits = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${digits(date.getMonth() + 1)}-${digits(date.getDate())}`;
}

export function normalizeUsagePrice(price, image) {
  if (price === null) return null;
  const fields = image ? ['perImage'] : ['inputPerMillion', 'outputPerMillion'];
  const bounds = image ? [] : ['maxInputTokens', 'maxOutputTokens'];
  exact(price, ['currency', ...fields, ...bounds]);
  if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) {
    throw new GatewayError('Enter a three-letter currency code.', 400, 'invalid_usage_currency');
  }
  if (fields.some(field => !Number.isFinite(price[field]) || price[field] < 0 || price[field] > Number.MAX_SAFE_INTEGER)) {
    throw new GatewayError('Enter valid non-negative prices for this model.', 400, 'invalid_usage_price');
  }
  const result = { currency: price.currency, ...Object.fromEntries(fields.map(field => [field, price[field]])) };
  for (const field of bounds) {
    if (price[field] == null) continue;
    if (!Number.isSafeInteger(price[field]) || price[field] < 1) {
      throw new GatewayError('Enter positive integer token ceilings.', 400, 'invalid_budget_token_ceiling', field);
    }
    result[field] = price[field];
  }
  return result;
}

export function estimateUsage(price, usage, images) {
  if (!price) return null;
  let amount;
  if (price.perImage !== undefined && images > 0) amount = images * price.perImage;
  else if (price.inputPerMillion !== undefined && usage) {
    amount = usage.prompt_tokens / 1_000_000 * price.inputPerMillion
      + usage.completion_tokens / 1_000_000 * price.outputPerMillion;
  }
  return Number.isFinite(amount) ? { currency: price.currency, amount } : null;
}

export function usageQuery(parameters) {
  const days = Number(parameters.get('days') ?? 7);
  if (!Number.isSafeInteger(days) || days < 1 || days > retentionDays) {
    throw new GatewayError(`Choose a usage period from 1 to ${retentionDays} days.`, 400, 'invalid_usage_period');
  }
  return { days, principalId: parameters.get('project') || '', modelId: parameters.get('model') || '' };
}

function matches(row, { principalId, modelId }) {
  return (!principalId || row.principalId === principalId) && (!modelId || row.modelId === modelId);
}

function totals() {
  return { requests: 0, succeeded: 0, failed: 0, cancelled: 0, reportedTokens: 0, unreported: 0,
    inputTokens: 0, outputTokens: 0, images: 0, estimatedRequests: 0, estimates: {} };
}

function tally(target, row) {
  target.requests++;
  target[row.status]++;
  if (row.usage) {
    target.reportedTokens++;
    target.inputTokens += row.usage.prompt_tokens;
    target.outputTokens += row.usage.completion_tokens;
  } else if (!row.images) target.unreported++;
  target.images += row.images;
  if (row.estimate) {
    const { currency, amount } = row.estimate;
    target.estimatedRequests++;
    target.estimates[currency] = (target.estimates[currency] || 0) + amount;
  }
}

function tallyGroup(groups, id, fields, row) {
  if (!groups.has(id)) groups.set(id, { ...fields, ...totals() });
  const group = groups.get(id);
  Object.assign(group, fields);
  tally(group, row);
}

export class UsageLedger {
  constructor(directory) {
    this.directory = path.join(directory, 'usage');
    this.queue = Promise.resolve();
    this.writeFailed = false;
  }

  async #prepare() {
    const now = Date.now(), day = localDay(now);
    if (this.preparedDay === day) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const earliest = localDay(now, 1 - retentionDays);
    for (const name of await fs.readdir(this.directory)) {
      if (dayFile.test(name) && name.slice(0, 10) < earliest) await fs.rm(path.join(this.directory, name), { force: true });
    }
    this.preparedDay = day;
  }

  #enqueue(action) {
    this.queue = this.queue.then(action).catch(() => { this.writeFailed = true; });
    return this.queue;
  }

  open() { return this.#enqueue(() => this.#prepare()); }

  record(row) {
    return this.#enqueue(async () => {
      await this.#prepare();
      const filename = path.join(this.directory, `${localDay(row.finishedAt)}.jsonl`);
      // A newline separates the next entry from a partially written tail after a crash.
      await fs.appendFile(filename, `\n${JSON.stringify(row)}\n`, { mode: 0o600, flush: true });
    });
  }

  async *rows(days, signal) {
    await this.open();
    const now = Date.now();
    for (let offset = 1 - days; offset <= 0; offset++) {
      signal.throwIfAborted();
      const date = localDay(now, offset);
      let file;
      try { file = await fs.open(path.join(this.directory, `${date}.jsonl`)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        for await (const line of file.readLines()) {
          signal.throwIfAborted();
          if (!line) continue;
          let row;
          try { row = JSON.parse(line); }
          catch { this.writeFailed = true; continue; }
          if (row?.id && ['succeeded', 'failed', 'cancelled'].includes(row.status)) yield { ...row, date };
        }
      } finally { await file.close(); }
    }
  }

  async report(query, signal) {
    const total = totals(), daily = new Map(), projects = new Map(), models = new Map();
    const projectOptions = new Map(), modelOptions = new Map(), recent = [];
    for await (const row of this.rows(query.days, signal)) {
      const project = { id: row.principalId, name: row.projectName };
      const model = { id: row.modelId, name: row.modelName, source: row.connectionName };
      projectOptions.set(project.id, project);
      modelOptions.set(model.id, model);
      if (!matches(row, query)) continue;
      tally(total, row);
      tallyGroup(daily, row.date, { date: row.date }, row);
      tallyGroup(projects, project.id, project, row);
      tallyGroup(models, model.id, model, row);
      recent.push(row);
      if (recent.length > detailLimit) recent.shift();
    }
    const ranked = groups => [...groups.values()].sort((a, b) => b.requests - a.requests);
    return { total, daily: [...daily.values()].reverse(), projects: ranked(projects), models: ranked(models),
      projectOptions: [...projectOptions.values()], modelOptions: [...modelOptions.values()], recent: recent.reverse(),
      retentionDays, detailLimit, writeFailed: this.writeFailed };
  }

  async *csv(query, signal) {
    yield '\uFEFFrequest_id,finished_at,project_id,project,model_id,model,connection,endpoint,status,duration_ms,input_tokens,output_tokens,images,currency,estimated_cost,error_code,requested_model,budget_period,budget_currency,budget_charge,budget_basis\r\n';
    for await (const row of this.rows(query.days, signal)) {
      if (!matches(row, query)) continue;
      const cells = [row.id, row.finishedAt, row.principalId, row.projectName, row.modelId, row.modelName, row.connectionName,
        row.endpoint, row.status, row.durationMs, row.usage?.prompt_tokens, row.usage?.completion_tokens, row.images,
        row.estimate?.currency, row.estimate?.amount, row.errorCode, row.model, row.budget?.period, row.budget?.currency, row.budget?.charged, row.budget?.basis];
      yield `${cells.map(csvCell).join(',')}\r\n`;
    }
  }

  close() { return this.queue; }
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  const text = String(value ?? '');
  const safe = /^\s*[=+\-@]|^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
