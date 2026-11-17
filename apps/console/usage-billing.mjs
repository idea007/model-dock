import { dateTime, errorText, number, t } from '../../packages/ui/i18n.mjs';
import { estimateText, modelName, money, pagination } from './usage-view.mjs';

const rootUrl = '/admin/usage/billing';
const localizedStatus = status => t(`usage.bill.${status || 'pending'}`);
const amountList = rows => rows.map(row => money(row.amount, row.currency)).join(' · ') || '—';
const estimates = groups => Object.entries(groups).map(([currency, values]) => estimateText({ currency, ...values })).join(' · ') || '—';

function field(label, name, value, escape, type = 'text', extra = '') {
  return `<label>${t(label)}<input type="${type}" name="${name}" value="${escape(value)}" ${extra}></label>`;
}

function statementRows(rows, escape) {
  return `<div class="usage-table-wrap usage-statement-table" tabindex="0"><table class="usage-table">
    <thead><tr>${['reference', 'matchingId', 'billed', 'result'].map(key => `<th scope="col">${t(`usage.bill.${key}`)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr><td>${escape(row.reference)}</td>
      <td>${escape(row.matchedCallId || row.callId || row.requestId || row.taskId || '—')}</td><td>${money(row.amount, row.currency)}</td>
      <td>${localizedStatus(row.status)}${row.duplicate ? ` · ${t('usage.bill.alreadyImported')}` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function priceCatalog(catalog, escape) {
  const items = catalog.models.flatMap(model => model.rates.filter(Boolean).map(rate => {
    const values = rate.kind === 'tokens' ? [
      ['usage.column.cachedTokens', rate.cacheReadPerMillion], ['usage.column.cacheWriteTokens', rate.cacheWritePerMillion],
      ['usage.inputTokens', rate.inputPerMillion], ['usage.outputTokens', rate.outputPerMillion]
    ].filter(([, amount]) => amount > 0).map(([key, amount]) => `${t(key)} ${money(amount, rate.currency)}`).join(' · ')
      : money(rate.amountPerUnit ?? rate.amountPerTenThousand ?? rate.amountPerSecond, rate.currency);
    const unit = { tokens: 'usage.bill.millionTokens', characters: 'usage.bill.tenThousandCharacters', seconds: 'usage.bill.perSecond',
      generated_count: 'usage.perImage' }[rate.kind];
    return `<tr><td>${escape(`${model.provider} · ${model.model}`)}</td><td>${values} · ${t(unit)}
      ${rate.priceBand ? ` · ${t(`usage.bill.${rate.priceBand}`)}` : ''}${rate.contextBand ? ` · ${escape(rate.contextBand)}` : ''}${rate.serviceTier ? ` · ${escape(rate.serviceTier)}` : ''}${rate.resolution ? ` · ${escape(rate.resolution)}` : ''}</td>
      <td>${escape(rate.effectiveFrom?.slice(0, 10) || '—')} · <a href="${escape(rate.source)}" target="_blank" rel="noreferrer">${t('usage.bill.priceSource')}</a></td></tr>`;
  }));
  return `<p class="usage-muted">${t('usage.bill.catalogAsOf', escape(catalog.rateAsOf))}</p>
    <div class="usage-table-wrap usage-statement-table" tabindex="0"><table class="usage-table">
      <thead><tr><th scope="col">${t('usage.providerModel')}</th><th scope="col">${t('usage.bill.rates')}</th><th scope="col">${t('usage.bill.effectiveFrom')}</th></tr></thead>
      <tbody>${items.join('')}${catalog.additionalItems.map(item => `<tr><td>${escape(`${item.provider} · ${item.item}`)}</td>
        <td>${money(item.amountPerUnit, item.currency)} / ${escape(item.unit)}</td>
        <td>${escape(item.effectiveFrom?.slice(0, 10) || '—')} · <a href="${escape(item.source)}" target="_blank" rel="noreferrer">${t('usage.bill.priceSource')}</a></td></tr>`).join('')}</tbody></table></div>`;
}

export class UsageBillingPanel {
  constructor(workspace) {
    this.owner = workspace;
    this.reset();
  }

  reset() {
    this.request?.abort();
    this.request = this.catalog = this.preview = this.error = null;
    this.open = this.imported = this.showCatalog = this.showImports = false;
    this.account = this.dateFrom = this.dateTo = this.csv = this.filename = '';
    this.fileVersion = (this.fileVersion || 0) + 1;
  }

  view(report) {
    const { escape } = this.owner;
    const { summary, cost } = report, { reconciled } = cost;
    const cards = [['estimate', estimates(summary.costs)], ['exact', number(summary.exactPriced)], ['range', number(summary.rangePriced)],
      ['unpriced', number(Math.max(0, summary.eligible - summary.priced))], ['reconciled', `${number(reconciled.count)} / ${number(cost.pagination.total)}`]];
    return `<section class="usage-billing"><h2>${t('usage.bill.section')}</h2>
      <div class="usage-panel usage-chart">
        <div class="usage-chart-heading"><div><h2>${t('usage.bill.title')}</h2><p>${t('usage.bill.help')}</p></div>
          <button type="button" data-usage-billing-action="export">${t('usage.bill.export')}</button></div>
        <div class="usage-bill-metrics">${cards.map(([key, value]) => `<div><small>${t(`usage.bill.${key}`)}</small><strong>${value}</strong></div>`).join('')}</div>
        ${reconciled.count ? `<p class="usage-muted usage-bill-note">${t('usage.bill.billedSummary', estimates(reconciled.amounts), number(reconciled.mismatches))}</p>` : ''}
        ${report.billingUnavailable ? `<p class="usage-alert" role="alert">${t('errors.usageBillingUnavailable')}</p>` : ''}
        <div class="usage-table-wrap" tabindex="0" role="region" aria-label="${t('usage.bill.title')}"><table class="usage-table usage-cost-table">
          <thead><tr>${['usage.column.time', 'usage.providerModel', 'usage.bill.metering', 'usage.estimate', 'usage.priceVersion', 'usage.bill.billed', 'usage.bill.result']
            .map(label => `<th scope="col">${t(label)}</th>`).join('')}<th scope="col" aria-label="${t('usage.bill.action')}"></th></tr></thead>
          <tbody>${cost.rows.length ? cost.rows.map(call => {
            const entry = call.reconciliation, rate = call.audit?.listEstimate, metrics = call.audit?.metrics || {};
            const total = metrics.totalTokens ?? call.usage?.total_tokens;
            const model = modelName(call);
            const evidence = [total != null ? `${number(total)} Token` : '', call.images ? t('usage.imageCount', call.images) : '',
              metrics.mediaSeconds != null ? `${number(metrics.mediaSeconds)} s` : '',
              metrics.inputCharacters != null ? `${number(metrics.inputCharacters)} ${t('usage.column.inputCharacters')}` : ''].filter(Boolean).join(' · ');
            return `<tr><td>${escape(dateTime(call.startedAt))}</td><td title="${escape(model)}">${escape(model)}</td>
              <td>${evidence || '—'}</td><td>${estimateText(rate)}${rate?.basis === 'request' ? `<small>${t('usage.bill.requestEstimate')}</small>` : ''}
                ${call.estimate ? `<small>${t('usage.configuredEstimate')} ${estimateText(call.estimate)}</small>` : ''}</td>
              <td>${escape(rate?.version || '—')}</td><td>${entry ? money(entry.amount, entry.currency) : '—'}</td>
              <td>${localizedStatus(entry?.status)}${entry ? `<small>${escape(entry.reference)}</small>` : ''}</td>
              <td><button type="button" data-usage-billing-action="reconcile" data-key="${escape(call.id)}"${report.billingUnavailable ? ' disabled' : ''}>
                ${t(entry ? 'usage.bill.correct' : 'usage.bill.action')}</button></td></tr>`;
          }).join('') : `<tr><td colspan="8" class="usage-empty">${t('usage.empty')}</td></tr>`}</tbody></table></div>
        ${pagination('cost', cost.pagination)}
        <div class="usage-statement-tools">
          <button type="button" class="usage-plain" data-usage-billing-action="tools" data-usage-focus="billing-tools" aria-expanded="${this.open}"${report.billingUnavailable ? ' disabled' : ''}>
            ${this.open ? '▾' : '▸'} ${t('usage.bill.tools')}</button>
          ${this.open ? this.tools(report) : ''}
        </div>
      </div></section>`;
  }

  tools(report) {
    const { escape, filters } = this.owner;
    const accounts = report.options.accounts;
    const selected = this.account || (filters.credential ? accounts.find(account => account.credential === filters.credential)?.id : '') || '';
    const from = this.dateFrom || filters.dateFrom || report.bounds.earliest, to = this.dateTo || filters.dateTo || report.bounds.latest;
    const busy = Boolean(this.request);
    return `<div class="usage-statement-controls">
      <p class="usage-muted">${t('usage.bill.matchHelp')}</p>
      <div class="usage-statement-fields">
        <label>${t('usage.bill.account')}<select data-usage-billing-field="account" data-usage-focus="billing-account"${busy ? ' disabled' : ''}>
          <option value="">${t('usage.bill.selectAccount')}</option>${accounts.map(account =>
            `<option value="${escape(account.id)}"${account.id === selected ? ' selected' : ''}>${escape(`${account.provider} · ${account.label || t('usage.unknown')}${account.version ? ` · …${account.version.slice(-8)}` : ''}`)}</option>`).join('')}</select></label>
        <label>${t('usage.dateFrom')}<input type="date" data-usage-billing-field="dateFrom" data-usage-focus="billing-from" value="${escape(from)}"${busy ? ' disabled' : ''}></label>
        <label>${t('usage.dateTo')}<input type="date" data-usage-billing-field="dateTo" data-usage-focus="billing-to" value="${escape(to)}"${busy ? ' disabled' : ''}></label>
      </div>
      <div class="usage-statement-actions">
        <button type="button" data-usage-billing-action="template">${t('usage.bill.template')}</button>
        <label class="usage-inline">${t('usage.bill.chooseFile')}<input type="file" accept=".csv,text/csv" data-usage-billing-field="csv"${busy ? ' disabled' : ''}></label>
        ${this.filename ? `<span class="usage-muted">${escape(this.filename)}</span>` : ''}
        <button type="button" data-usage-billing-action="preview" data-usage-focus="billing-preview"${busy || !this.csv ? ' disabled' : ''}>${t('usage.bill.preview')}</button>
        ${this.preview && !this.imported ? `<button type="button" data-usage-billing-action="import" data-usage-focus="billing-import"${busy ? ' disabled' : ''}>${t('usage.bill.commit')}</button>` : ''}
      </div>
      ${busy ? `<p role="status" class="usage-muted">${t('usage.loading')}</p>` : ''}
      ${this.error ? `<p role="alert" class="usage-alert">${escape(errorText(this.error))}</p>` : ''}
      ${this.imported ? `<p role="status" class="usage-muted">${t('usage.bill.saved')}</p>` : ''}
      ${this.preview ? `<section class="usage-statement-preview"><h3>${t('usage.bill.preview')}</h3>
        <p class="usage-muted">${['matched', 'manual_match', 'mismatch', 'unpriced', 'currency_mismatch', 'unmatched', 'ambiguous', 'duplicate', 'localOnly']
          .map(key => `${localizedStatus(key)} ${number(this.preview.summary[key])}`).join(' · ')}</p>
        <p class="usage-muted">${t('usage.bill.statementTotal', amountList(this.preview.currencies))}</p>
        ${statementRows(this.preview.rows, escape)}</section>` : ''}
      ${this.catalog ? `<button type="button" class="usage-plain" data-usage-billing-action="history" aria-expanded="${this.showImports}">
        ${this.showImports ? '▾' : '▸'} ${t('usage.bill.recentImports')}</button>
        ${this.showImports ? `<div class="usage-statement-imports">${this.catalog.imports.length ? this.catalog.imports.map(batch =>
          `<button type="button" data-usage-billing-action="batch" data-key="${escape(batch.id)}">${escape(`${dateTime(batch.createdAt)} · ${batch.provider} · ${batch.dateFrom} — ${batch.dateTo}`)}
          · ${number(batch.summary.rowCount)}</button>`).join('') : `<p class="usage-muted">${t('usage.bill.noImports')}</p>`}</div>` : ''}
        <button type="button" class="usage-plain" data-usage-billing-action="catalog" aria-expanded="${this.showCatalog}">
          ${this.showCatalog ? '▾' : '▸'} ${t('usage.bill.catalog')} · ${escape(this.catalog.catalog.version)}</button>
        ${this.showCatalog ? priceCatalog(this.catalog.catalog, escape) : ''}` : busy ? '' : `<button type="button" data-usage-billing-action="reload">${t('usage.retry')}</button>`}
    </div>`;
  }

  async change(target) {
    const key = target.dataset.usageBillingField;
    this.preview = this.error = null;
    this.imported = false;
    if (key === 'csv') {
      const file = target.files?.[0], change = ++this.fileVersion;
      this.filename = file?.name || '';
      this.csv = '';
      if (file?.size > 1024 * 1024) this.error = new Error(t('usage.bill.fileLimit'));
      else if (file) {
        const contents = await file.text();
        if (change !== this.fileVersion) return;
        this.csv = contents;
      }
    } else this[key] = target.value;
    this.owner.draw();
  }

  async loadTools() {
    const request = new AbortController();
    this.request = request;
    this.error = null;
    this.owner.draw();
    try {
      const catalog = await this.owner.api(rootUrl, { signal: request.signal });
      if (!request.signal.aborted) this.catalog = catalog;
    }
    catch (error) { if (!request.signal.aborted) this.error = error; }
    finally {
      if (this.request === request) {
        this.request = null;
        this.owner.draw();
      }
    }
  }

  async runImport(commit) {
    if (!this.csv || this.request) return;
    const scope = key => this.owner.root.querySelector(`[data-usage-billing-field="${key}"]`)?.value;
    const [provider, credential] = JSON.parse(scope('account') || '[]');
    if (!provider || !credential || !scope('dateFrom') || !scope('dateTo')) {
      this.error = new Error(t('usage.bill.scopeRequired'));
      this.owner.draw();
      return;
    }
    const body = { provider, credential, dateFrom: scope('dateFrom'), dateTo: scope('dateTo'), csv: this.csv,
      ...(commit && { previewHash: this.preview?.previewHash }) };
    const request = new AbortController();
    this.request = request;
    this.error = null;
    this.owner.draw();
    try {
      const result = await this.owner.api(`${rootUrl}/${commit ? 'import' : 'preview'}`, { method: 'POST', body, signal: request.signal });
      if (request.signal.aborted) return;
      this.preview = commit ? result.report : result;
      if (commit) {
        this.imported = true;
        this.catalog = await this.owner.api(rootUrl, { signal: request.signal });
      }
    } catch (error) {
      if (!request.signal.aborted) {
        this.error = error;
        if (error.code === 'usage_statement_changed') this.preview = null;
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        if (this.imported) void this.owner.refresh();
        else this.owner.draw();
      }
    }
  }

  async click(action, button) {
    const { owner } = this;
    switch (action) {
      case 'export': return owner.download(`/admin/usage/calls.csv?${owner.params({ offset: null, costOffset: null })}`, 'model-dock-ai-reconciliation.csv', button);
      case 'template': return owner.download(`${rootUrl}/template.csv`, 'model-dock-provider-statement.csv', button);
      case 'tools':
        this.open = !this.open;
        if (this.open && !this.catalog && !this.request) return this.loadTools();
        owner.draw();
        break;
      case 'reload': return this.loadTools();
      case 'catalog': this.showCatalog = !this.showCatalog; owner.draw(); break;
      case 'history': this.showImports = !this.showImports; owner.draw(); break;
      case 'preview': return this.runImport(false);
      case 'import': return this.runImport(true);
      case 'reconcile': this.reconcile(owner.report.cost.rows.find(call => call.id === button.dataset.key), button); break;
      case 'batch': return this.batch(button.dataset.key, button);
    }
  }

  reconcile(call, anchor) {
    if (!call) return;
    const { owner } = this, { escape } = owner;
    const { body, signal } = owner.modal(t(call.reconciliation ? 'usage.bill.correct' : 'usage.bill.action'), anchor);
    const estimate = call.audit?.listEstimate || call.estimate;
    const currency = call.reconciliation?.currency || estimate?.currency || 'CNY';
    body.innerHTML = `<form class="usage-bill-form">
      <p class="usage-muted">${escape(modelName(call))} · ${escape(call.id)} · ${t('usage.estimate')} ${estimateText(estimate)}</p>
      ${field('usage.bill.reference', 'reference', '', escape, 'text', 'required maxlength="200"')}
      ${field('usage.currency', 'currency', currency, escape, 'text', 'required maxlength="3" pattern="[A-Z]{3}"')}
      ${field('usage.bill.billed', 'amount', '', escape, 'text', 'required inputmode="decimal"')}
      <label class="usage-inline"><input type="checkbox" name="verified">${t('usage.bill.manual_match')}</label>
      <p class="usage-muted">${t('usage.bill.correctionHelp')}</p>
      <p role="alert" class="usage-form-error"></p>
      <div><button type="submit">${t('common.saveChanges')}</button></div>
    </form><section class="usage-reconcile-history"></section>`;
    const form = body.querySelector('form'), history = body.querySelector('.usage-reconcile-history');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]'), message = form.querySelector('[role="alert"]');
      button.disabled = true;
      message.textContent = '';
      const values = new FormData(form);
      try {
        await owner.api(`${rootUrl}/reconcile`, { method: 'POST', signal, body: {
          callId: call.id, reference: String(values.get('reference')).trim(), currency: String(values.get('currency')).trim(),
          amount: String(values.get('amount')).trim(), manuallyVerified: values.has('verified')
        } });
        if (signal.aborted) return;
        owner.dialog.close();
        owner.notify(t('usage.bill.reconciledSaved'));
        void owner.refresh();
      } catch (error) {
        if (!signal.aborted) message.textContent = errorText(error);
      } finally { button.disabled = false; }
    });
    void owner.api(`${rootUrl}/calls/${encodeURIComponent(call.id)}`, { signal }).then(({ entries }) => {
      if (!signal.aborted && entries.length) history.innerHTML = `<h3>${t('usage.bill.reconciliationHistory')}</h3>
        <ul>${entries.map(entry => `<li>${escape(dateTime(entry.createdAt))} · ${escape(entry.reference)} · ${money(entry.amount, entry.currency)} · ${localizedStatus(entry.status)}</li>`).join('')}</ul>`;
    }).catch(error => { if (!signal.aborted) history.textContent = errorText(error); });
  }

  async batch(id, anchor) {
    const { body, signal } = this.owner.modal(t('usage.bill.recentImports'), anchor);
    const { escape } = this.owner;
    body.textContent = t('usage.loading');
    try {
      const { batch } = await this.owner.api(`${rootUrl}/imports/${encodeURIComponent(id)}`, { signal });
      if (!signal.aborted) body.innerHTML = `<p class="usage-muted">${escape(`${batch.provider} · ${batch.dateFrom} — ${batch.dateTo}`)}</p>${statementRows(batch.rows, escape)}`;
    } catch (error) { if (!signal.aborted) body.textContent = errorText(error); }
  }
}
