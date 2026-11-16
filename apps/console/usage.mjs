import { dateTime, duration, errorText, number, t } from '../../packages/ui/i18n.mjs';

const statuses = { succeeded: 'common.completed', failed: 'common.failed', cancelled: 'console.cancelled' };
const endpointLabels = { chat: 'Chat Completions', responses: 'Responses', images: 'Images' };

export function money(amount, currency) {
  return number(amount, { style: 'currency', currency, maximumFractionDigits: 6 });
}

function estimateLabel(estimates) {
  return Object.entries(estimates).map(([currency, amount]) => money(amount, currency)).join(' · ') || '—';
}

function aggregate(title, nameOf, groups) {
  return `<section class="usage-section"><h2>${t(title)}</h2>
    <div class="table-wrap"><table><thead><tr><th>${t(nameOf.label)}</th><th>${t('usage.calls')}</th>
      <th>${t('usage.inputTokens')}</th><th>${t('usage.outputTokens')}</th><th>${t('usage.images')}</th>
      <th>${t('usage.unreported')}</th><th>${t('usage.estimate')}</th></tr></thead><tbody>
      ${groups.map(row => `<tr><td>${nameOf.cell(row)}</td><td>${number(row.requests)}</td><td>${row.reportedTokens ? number(row.inputTokens) : '—'}</td>
        <td>${row.reportedTokens ? number(row.outputTokens) : '—'}</td><td>${number(row.images)}</td><td>${number(row.unreported)}</td>
        <td>${estimateLabel(row.estimates)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function recent(report, escape) {
  return `<section class="usage-section"><h2>${t('usage.requestDetails')}</h2>
    <p>${t('usage.detailLimit', report.detailLimit)}</p>
    <div class="table-wrap"><table><thead><tr><th>${t('usage.finishedAt')}</th><th>${t('console.project')}</th>
      <th>${t('common.model')}</th><th>API</th><th>${t('console.result')}</th><th>${t('console.duration')}</th>
      <th>${t('console.tokenUsage')}</th><th>${t('usage.estimate')}</th></tr></thead><tbody>
      ${report.recent.map(row => `<tr><td>${escape(dateTime(row.finishedAt))}<small>${escape(row.id)}</small></td>
        <td>${escape(row.principalId === 'admin' ? t('usage.localAdministrator') : row.projectName)}</td>
        <td><strong>${escape(row.modelName)}</strong><small>${escape(row.connectionName)}</small>
          ${row.model !== row.modelId ? `<small><code>${escape(row.model)}</code></small>` : ''}</td>
        <td>${endpointLabels[row.endpoint] || '—'}</td>
        <td><span class="request-status ${row.status}">${t(statuses[row.status])}</span>${row.errorCode ? `<small>${escape(row.errorCode)}</small>` : ''}</td>
        <td>${duration(row.durationMs / 1000)}</td>
        <td>${row.usage ? `${number(row.usage.prompt_tokens)} / ${number(row.usage.completion_tokens)}` : row.images ? t('usage.imageCount', row.images) : t('console.notReported')}</td>
        <td>${row.estimate ? money(row.estimate.amount, row.estimate.currency) : '—'}
          ${row.budget?.basis === 'reserved' ? `<small>${t('usage.budgetUnconfirmed', money(row.budget.charged, row.budget.currency))}</small>` : ''}
          ${row.budget?.basis === 'pending' ? `<small>${t('errors.budgetLedgerUnavailable')}</small>` : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`;
}

export function usagePage({ state, report, filters, loading, error }, escape) {
  const projectName = row => row.id === 'admin' ? t('usage.localAdministrator') : row.name;
  const deploymentName = row => row.source ? `${row.name} · ${row.source}` : row.name;
  const modelOptions = state.models.map(model => ({ id: model.id, name: model.name,
    source: state.connections.find(connection => connection.id === model.connectionId)?.name }));
  const projects = new Map((report?.projectOptions || []).map(row => [row.id, projectName(row)]));
  for (const key of state.keys) projects.set(key.id, key.name);
  const models = new Map((report?.modelOptions || []).map(row => [row.id, deploymentName(row)]));
  for (const model of modelOptions) models.set(model.id, deploymentName(model));
  function selectFilter(key, label, values) {
    if (filters[key] && !values.has(filters[key])) values.set(filters[key], filters[key]);
    return `<label>${t(label)}<select data-usage-filter="${key}" data-usage-focus="${key}"><option value="">${t('usage.all')}</option>
      ${[...values].map(([id, name]) => `<option value="${escape(id)}"${id === filters[key] ? ' selected' : ''}>${escape(name)}</option>`).join('')}
      </select></label>`;
  }
  const total = report?.total;
  return `<div class="between page-heading usage-heading"><h1>${t('usage.title')}</h1>
    <div class="row wrap"><button type="button" data-action="refresh-usage" data-usage-focus="refresh" ${loading ? 'disabled' : ''}>${t('usage.refresh')}</button>
      <button type="button" data-action="export-usage" ${loading || error || !total?.requests ? 'disabled' : ''}>${t('usage.export')}</button></div></div>
    <div class="usage-filters">
      <label>${t('usage.period')}<select data-usage-filter="days" data-usage-focus="days">${[1, 7, 30].map(days =>
        `<option value="${days}"${days === filters.days ? ' selected' : ''}>${t(days === 1 ? 'usage.today' : 'usage.lastDays', days)}</option>`).join('')}</select></label>
      ${selectFilter('project', 'console.project', projects)}${selectFilter('model', 'common.model', models)}
    </div>
    <p class="usage-note">${t('usage.retention', report?.retentionDays ?? 30)}</p>
    ${loading ? `<p class="card" role="status">${t('usage.loading')}</p>` : ''}
    ${error ? `<p class="card form-error" role="alert">${escape(errorText(error))}</p>` : ''}
    ${!loading && !error && report ? `${report.writeFailed ? `<p class="info-box" role="alert">${t('usage.storageWarning')}</p>` : ''}
      <div class="usage-stats">${[
        [number(total.requests), 'usage.calls', t('usage.outcomes', total.succeeded, total.failed, total.cancelled)],
        [total.reportedTokens ? `${number(total.inputTokens)} / ${number(total.outputTokens)}` : '—', 'usage.inputOutput', t('usage.unreportedCount', total.unreported)],
        [number(total.images), 'usage.images'],
        [estimateLabel(total.estimates), 'usage.estimate', t('usage.estimateHelp', total.estimatedRequests, total.requests)]
      ].map(([value, label, detail]) => `<section class="card"><h2>${t(label)}</h2><strong>${value}</strong>${detail ? `<small>${detail}</small>` : ''}</section>`).join('')}</div>
      ${total.requests ? [
        aggregate('usage.daily', { label: 'usage.date', cell: row => escape(row.date) }, report.daily),
        aggregate('usage.byProject', { label: 'console.project', cell: row => escape(projectName(row)) }, report.projects),
        aggregate('usage.byModel', { label: 'common.model', cell: row => escape(deploymentName(row)) }, report.models),
        recent(report, escape)
      ].join('') : `<p class="card usage-note">${t('usage.empty')}</p>`}` : ''}
    ${modelOptions.length ? `<section class="usage-section"><h2>${t('usage.prices')}</h2><p>${t('usage.pricesHelp')}</p>
      <div class="usage-price-controls"><select id="usage-price-model" data-usage-focus="price" aria-label="${t('common.model')}">
        ${modelOptions.map(model => `<option value="${escape(model.id)}"${model.id === filters.priceModel ? ' selected' : ''}>${escape(deploymentName(model))}</option>`).join('')}
      </select><button type="button" data-action="edit-usage-price">${t('usage.editPrice')}</button></div></section>` : ''}`;
}
