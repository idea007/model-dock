import fs from 'node:fs/promises';
import path from 'node:path';
import { GatewayError, exact } from '../protocol/index.mjs';
import { writePrivateJson } from './store.mjs';

const precision = 1_000_000;
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const isCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const positiveBound = value => Number.isSafeInteger(value) && value > 0;
const add = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

function decimalTerm(rate, quantity) {
  const [significand, exponent = '0'] = String(rate).split('e');
  const [whole, fraction = ''] = significand.split('.');
  return { coefficient: BigInt(whole + fraction) * BigInt(quantity), places: fraction.length - Number(exponent) };
}

function costUnits(price, usage, images) {
  // Rates per million tokens already express millionths of a currency unit
  // per token. Add the decimal terms before rounding the request up once.
  const terms = price.perImage !== undefined ? [decimalTerm(price.perImage, images * precision)]
    : [decimalTerm(price.inputPerMillion, usage.prompt_tokens), decimalTerm(price.outputPerMillion, usage.completion_tokens)];
  const places = Math.max(0, ...terms.map(term => term.places));
  const divisor = 10n ** BigInt(places);
  const numerator = terms.reduce((sum, term) => sum + term.coefficient * 10n ** BigInt(places - term.places), 0n);
  return Number((numerator + divisor - 1n) / divisor);
}

function periodAt(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function normalizeBudget(budget) {
  if (budget === null) return null;
  exact(budget, ['currency', 'amount']);
  const units = typeof budget.amount === 'number' ? Math.round(budget.amount * precision) : 0;
  if (!isCurrency(budget.currency) || !positiveBound(units) || units / precision !== budget.amount) {
    throw new GatewayError('Enter a currency and a positive monthly amount with up to six decimal places.', 400, 'invalid_project_budget');
  }
  return { currency: budget.currency, amount: budget.amount };
}

export function budgetQuote(key, model, connection, request) {
  if (!key?.budget) return null;
  const { currency, amount } = key.budget;
  const price = model.usagePrice;
  const image = model.capability === 'image_generation';
  if (price?.currency !== currency || image !== (price?.perImage !== undefined)) {
    throw new GatewayError('Set a price in the project budget currency for this deployment.', 409, 'budget_price_required');
  }
  let usage = null;
  if (!image) {
    const input = price.inputPerMillion === 0 ? 0 : model.maxInputTokens ?? price.maxInputTokens ?? model.contextWindow;
    const declaredOutput = model.maxOutputTokens ?? price.maxOutputTokens;
    const requestedOutput = connection.type !== 'codex' ? request.max_completion_tokens ?? request.max_tokens : undefined;
    const output = price.outputPerMillion === 0 ? 0
      : requestedOutput ? Math.min(requestedOutput, declaredOutput ?? requestedOutput) : declaredOutput;
    if (!nonnegativeInteger(input) || !nonnegativeInteger(output)) {
      throw new GatewayError('Set verified token ceilings or supply a supported output limit to reserve the budget.', 409, 'budget_token_ceiling_required');
    }
    usage = { prompt_tokens: input, completion_tokens: output };
  }
  const units = costUnits(price, usage, image ? 1 : 0);
  return { principalId: key.id, currency, allowance: Math.round(amount * precision), units };
}

const unavailable = () => new GatewayError('The local budget ledger is unavailable.', 503, 'budget_ledger_unavailable');
const exceeded = () => new GatewayError('The request would exceed the project monthly budget.', 429, 'project_budget_exceeded');
const sameBalance = (row, scope) => row.principalId === scope.principalId && row.period === scope.period && row.currency === scope.currency;
const validScope = row => typeof row?.principalId === 'string' && /^\d{4}-\d{2}$/.test(row.period) && isCurrency(row.currency);

function charge(state, hold, field, units) {
  let balance = state.balances.find(row => sameBalance(row, hold));
  if (!balance) {
    const { principalId, period, currency } = hold;
    balance = { principalId, period, currency, settled: 0, unconfirmed: 0 };
    state.balances.push(balance);
  }
  balance[field] = add(balance[field], units);
}

export class ProjectBudgets {
  constructor(directory, clock = Date.now) {
    this.file = path.join(directory, 'budgets.json');
    this.clock = clock;
    this.queue = Promise.resolve();
    this.state = { version: 1, balances: [], holds: [] };
    this.available = true;
  }

  async open() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state?.version !== 1 || !Array.isArray(state.balances) || !Array.isArray(state.holds)
        || state.balances.some(row => !validScope(row) || !nonnegativeInteger(row.settled) || !nonnegativeInteger(row.unconfirmed))
        || state.holds.some(row => !validScope(row) || typeof row.id !== 'string' || !nonnegativeInteger(row.units))) {
        throw new Error('Invalid budget ledger.');
      }
      if (state.holds.length) {
        // A previous gateway may have sent these requests before it stopped.
        // Carry their reserved amounts forward as unconfirmed charges.
        for (const hold of state.holds) charge(state, hold, 'unconfirmed', hold.units);
        state.holds = [];
        await writePrivateJson(this.file, state);
      }
      this.state = state;
    } catch (error) { if (error.code !== 'ENOENT') this.available = false; }
  }

  #balance(scope) {
    const balance = this.state.balances.find(row => sameBalance(row, scope));
    const reserved = this.state.holds.filter(row => sameBalance(row, scope)).reduce((sum, row) => add(sum, row.units), 0);
    return { settled: balance?.settled ?? 0, unconfirmed: balance?.unconfirmed ?? 0, reserved };
  }

  summary(key) {
    const { currency, amount } = key.budget;
    const period = periodAt(this.clock());
    const { settled, unconfirmed, reserved } = this.#balance({ principalId: key.id, currency, period });
    const remaining = Math.max(0, Math.round(amount * precision) - settled - unconfirmed - reserved);
    return { period, currency, amount, available: this.available, settled: settled / precision,
      unconfirmed: unconfirmed / precision, reserved: reserved / precision, remaining: remaining / precision };
  }

  check(quote, period = periodAt(this.clock())) {
    if (!this.available) throw unavailable();
    const { settled, unconfirmed, reserved } = this.#balance({ ...quote, period });
    const remaining = quote.allowance - settled - unconfirmed - reserved;
    if (!nonnegativeInteger(quote.units) || quote.units > remaining) throw exceeded();
  }

  #enqueue(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async #write(state) {
    try { await writePrivateJson(this.file, state); this.state = state; }
    catch { this.available = false; throw unavailable(); }
  }

  reserve(quote, id, signal) {
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      const period = periodAt(this.clock());
      this.check(quote, period);
      const { units, principalId, currency } = quote;
      const hold = { id, period, principalId, currency, units };
      const next = structuredClone(this.state);
      next.balances = next.balances.filter(row => row.period >= period || next.holds.some(hold => sameBalance(row, hold)));
      next.holds.push(hold);
      await this.#write(next);
      return hold;
    });
  }

  settle(hold, dispatched, price, row) {
    return this.#enqueue(async () => {
      if (!this.available) throw unavailable();
      const next = structuredClone(this.state);
      const index = next.holds.findIndex(row => row.id === hold.id);
      if (index < 0) return;
      next.holds.splice(index, 1);
      const measured = price.perImage !== undefined ? row?.images > 0
        : nonnegativeInteger(row?.usage?.prompt_tokens) && nonnegativeInteger(row?.usage?.completion_tokens);
      const basis = !dispatched ? 'released' : measured ? 'reported' : 'reserved';
      const units = !dispatched ? 0 : measured ? Math.min(Number.MAX_SAFE_INTEGER, costUnits(price, row.usage, row.images)) : hold.units;
      if (dispatched) charge(next, hold, measured ? 'settled' : 'unconfirmed', units);
      await this.#write(next);
      return { period: hold.period, currency: hold.currency, reserved: hold.units / precision, charged: units / precision, basis };
    });
  }
}
