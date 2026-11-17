import { dateTime, errorText, number, t } from '../../packages/ui/i18n.mjs';
import { usageCharts } from './usage-charts.mjs';

export const callColumns = [
  ['time', 216, 160], ['endpoint', 192, 128], ['initiator', 160, 112], ['model', 256, 160],
  ['credential', 244, 128], ['speed', 116, 88], ['status', 176, 112], ['duration', 152, 104],
  ['tokens', 230, 128], ['media', 180, 104], ['accounting', 220, 120]
];
export const groupColumns = [
  ['group', 252, 140], ['calls', 96, 80], ['totalTokens', 124, 100], ['inputTokens', 106, 84], ['cachedTokens', 110, 88],
  ['outputTokens', 106, 84], ['estimate', 156, 120], ['coverage', 120, 96], ['cacheWriteTokens', 112, 88],
  ['reasoningTokens', 108, 88], ['images', 92, 72], ['videos', 92, 72], ['mediaSeconds', 110, 88], ['inputCharacters', 110, 88]
];
const dimensions = ['sources', 'costCategories', 'projects', 'endpoints', 'models', 'credentials', 'modalities', 'directions', 'daily'];
const endpoints = ['chat', 'responses', 'images', 'embeddings', 'speech', 'transcriptions', 'video', 'service', 'service-query', 'search'];
const statuses = { succeeded: 'usage.succeeded', failed: 'common.failed', cancelled: 'console.cancelled' };
export const statusLabel = status => t(statuses[status] || 'usage.unknownStatus');
export const endpointName = value => t(endpoints.includes(value) ? `usage.endpoint.${value}` : 'usage.unknown');
export const projectName = (id, name) => id === 'admin' ? t('usage.localAdministrator') : name || id;
export const modelName = row => [row.provider === 'unknown' ? t('usage.unknown') : row.provider, row.nativeModel || row.label || row.modelName].filter(Boolean).join(' · ');
const credentialName = row => row?.name || row?.label || t('usage.unknown');
const known = value => value == null ? '—' : number(value);
const length = value => value == null ? '—' : value < 1000 ? `${number(value)} ms` : `${number(value / 1000, { maximumFractionDigits: 2 })} s`;
const icon = (path, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

export function money(amount, currency) {
  return number(amount, { style: 'currency', currency, maximumFractionDigits: 6 });
}

export function estimateText(estimate) {
  if (!estimate) return '—';
  const start = estimate.minimum ?? estimate.amount, end = estimate.maximum ?? estimate.amount;
  return start === end ? money(start, estimate.currency) : `${money(start, estimate.currency)}–${money(end, estimate.currency)}`;
}

function costs(values = {}) {
  return Object.entries(values).map(([currency, amount]) => estimateText({ currency, ...amount })).join(' · ') || '—';
}

function measurement(row, key, compact = false) {
  const coverage = { totalTokens: 'tokenCount', inputTokens: 'inputCount', outputTokens: 'outputCount',
    cachedTokens: 'cacheCount', cacheWriteTokens: 'cacheWriteCount', reasoningTokens: 'reasoningCount' }[key];
  if (!coverage) return known(row[key]);
  if (!row[coverage] && !row[key]) return '—';
  return `${number(row[key] || 0, compact ? { notation: 'compact', maximumFractionDigits: 2 } : undefined)}${row[coverage] < row.textCalls ? ' *' : ''}`;
}

function overview(summary) {
  const cards = [
    ['knownTokens', measurement(summary, 'totalTokens', true), t('usage.tokenBreakdown', measurement(summary, 'inputTokens'), measurement(summary, 'outputTokens'))],
    ['providerCalls', number(summary.calls), [t('usage.outcomes', number(summary.succeeded), number(summary.failed), number(summary.cancelled)),
      summary.legacy ? t('usage.legacyCount', number(summary.legacy)) : '', summary.replayed ? t('usage.replayCount', number(summary.replayed)) : ''].filter(Boolean).join(' · ')],
    ['cacheRate', summary.cacheInput > 0 ? number(summary.cachedTokens / summary.cacheInput, { style: 'percent', maximumFractionDigits: 1 }) : '—',
      t('usage.cacheCoverage', number(summary.cacheCount))],
    ['estimate', costs(summary.priced ? summary.costs : summary.configuredCosts) + (summary.priced && summary.priced < summary.eligible ? ' *' : ''),
      summary.priced ? t('usage.publicCoverage', number(summary.priced), number(summary.eligible)) :
        Object.keys(summary.configuredCosts).length ? t('usage.configuredBasis') : t('usage.publicCoverage', '0', number(summary.eligible))]
  ];
  return `<section class="usage-overview" aria-label="${t('usage.overview')}">${cards.map(([key, value, help]) =>
    `<article class="usage-panel"><h2>${t(`usage.${key}`)}</h2><strong${key === 'knownTokens' ? ` title="${measurement(summary, 'totalTokens')}"` : ''}>${value}</strong><small>${help}</small></article>`).join('')}</section>`;
}

function select(key, title, all, value, options, escape) {
  if (value && !options.has(value)) options.set(value, value);
  return `<label>${t(title)}<select data-usage-filter="${key}" data-usage-focus="${key}">
    <option value="">${t(all)}</option>${[...options].map(([id, label]) =>
      `<option value="${escape(id)}"${id === value ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select></label>`;
}

function dateField(key, value, bounds, escape) {
  return `<label>${t(`usage.${key}`)}<input type="date" data-usage-filter="${key}" data-usage-focus="${key}"
    value="${escape(value)}"${bounds ? ` min="${bounds.earliest}" max="${bounds.latest}"` : ''}></label>`;
}

function filterPanel(ui, escape) {
  const { state, report, filters, filtersOpen, tab, chartBase } = ui, bounds = report?.bounds;
  const options = report?.options || {};
  const projects = new Map((options.projects || []).map(row => [row.id, projectName(row.id, row.label)]));
  projects.set('admin', t('usage.localAdministrator'));
  for (const key of state.keys) projects.set(key.id, key.name);
  const credentials = new Map((options.credentials || []).map(row => [row.id,
    `${credentialName(row)}${row.version ? ` · …${row.version.slice(-8)}` : ''} · ${t('usage.callCount', number(row.count))}`]));
  const models = new Map((options.models || []).map(row => [row.id, `${modelName(row)} · ${row.connection} · ${t('usage.callCount', number(row.count))}`]));
  if (!filters.credential) for (const row of state.models) {
    if (!models.has(row.id)) models.set(row.id, `${row.name} · ${state.connections.find(connection => connection.id === row.connectionId)?.name || row.nativeId}`);
  }
  const endpointOptions = new Map((options.endpoints || []).map(row => [row.id, endpointName(row.id)]));
  const dateFrom = filters.dateFrom || bounds?.earliest || '', dateTo = filters.dateTo || bounds?.latest || '';
  const condensed = tab === 'aiCalls', open = !condensed || filtersOpen;
  const summary = [dateFrom && dateTo ? `${dateFrom} — ${dateTo}` : t('usage.period'), credentials.get(filters.credential) || t('usage.allCredentials'),
    models.get(filters.model) || t('usage.allModels'), filters.endpoint ? endpointName(filters.endpoint) : t('usage.allEndpoints')].join(' · ');
  return `<section class="usage-panel usage-scope">
      ${select('project', 'usage.projectScope', 'usage.allProjects', filters.project, projects, escape)}
      <p>${escape(t('usage.scopeHint', projects.get(filters.project) || t('usage.allProjects')))}</p></section>
    <section class="usage-panel usage-filter-panel">
      ${condensed ? `<div class="usage-filter-header"><p>${escape(summary)}</p>
        <button type="button" data-usage-action="filters" data-usage-focus="filters" aria-expanded="${open}" aria-controls="usage-filters">
          ${t(open ? 'usage.hideFilters' : 'usage.showFilters')}</button></div>` : ''}
      <div id="usage-filters"${open ? '' : ' hidden'} class="${condensed ? 'usage-collapsible-filters' : ''}">
        <div class="usage-filters">
          ${select('credential', 'usage.credential', 'usage.allCredentials', filters.credential, credentials, escape)}
          ${select('model', 'usage.providerModel', 'usage.allModels', filters.model, models, escape)}
          ${select('endpoint', 'usage.endpointType', 'usage.allEndpoints', filters.endpoint, endpointOptions, escape)}
          ${dateField('dateFrom', dateFrom, bounds, escape)}${dateField('dateTo', dateTo, bounds, escape)}
        </div>
        <p class="usage-filter-note">${t('usage.filterHint')}</p>
      </div>
      ${chartBase ? `<div class="usage-filter-header usage-filter-note" role="status">
        <p>${escape(summary)}</p><button type="button" data-usage-action="undo-chart" data-usage-focus="undo-chart">${t('usage.undoChart')}</button></div>` : ''}
    </section>`;
}

export function pagination(kind, page, disabled = false) {
  if (!page) return '';
  return `<div class="usage-pagination">
    <span>${t('usage.pageRange', page.total ? number(page.offset + 1) : '0', number(Math.min(page.offset + page.limit, page.total)), number(page.total))}</span>
    <div><button type="button" data-usage-page="${kind}" data-offset="${Math.max(0, page.offset - page.limit)}" data-usage-focus="${kind}-previous"${disabled || !page.offset ? ' disabled' : ''}>${t('usage.previousPage')}</button>
    <button type="button" data-usage-page="${kind}" data-offset="${page.offset + page.limit}" data-usage-focus="${kind}-next"${disabled || !page.hasMore ? ' disabled' : ''}>${t('usage.nextPage')}</button></div></div>`;
}

export function visibleColumns(ui, kind) {
  const definitions = kind === 'calls' ? callColumns : groupColumns;
  const { order, hidden } = ui.columnViews[kind];
  return order.filter(key => !hidden.includes(key)).map(key => definitions.find(column => column[0] === key));
}

function columnLabel(key) {
  const mapped = { model: 'providerModel', estimate: 'estimate', calls: 'calls', tokens: 'tokens', endpoint: 'endpointType',
    credential: 'credential', inputTokens: 'inputTokens', outputTokens: 'outputTokens', images: 'images', totalTokens: 'knownTokens' };
  return t(`usage.${mapped[key] || `column.${key}`}`);
}

export function columnMenu(kind, ui, escape) {
  const { order, hidden } = ui.columnViews[kind];
  return `<div class="usage-popover usage-column-menu" aria-label="${t('usage.columns')}">
    <h3>${t('usage.columns')}</h3>
    ${order.map((key, index) => `<div class="usage-column-option">
      <label><input type="checkbox" data-usage-column="${kind}" data-column="${key}" data-usage-focus="column-${key}"${hidden.includes(key) ? '' : ' checked'}${key === (kind === 'calls' ? 'time' : 'group') ? ' disabled' : ''}>
        ${columnLabel(key)}</label>
      <button type="button" data-usage-column-move="${kind}" data-column="${key}" data-direction="-1" data-usage-focus="up-${key}" aria-label="${escape(t('usage.moveColumnUp', columnLabel(key)))}"${index ? '' : ' disabled'}>←</button>
      <button type="button" data-usage-column-move="${kind}" data-column="${key}" data-direction="1" data-usage-focus="down-${key}" aria-label="${escape(t('usage.moveColumnDown', columnLabel(key)))}"${index < order.length - 1 ? '' : ' disabled'}>→</button>
    </div>`).join('')}
    <button type="button" data-usage-action="reset-columns" data-kind="${kind}">${t('usage.resetColumns')}</button></div>`;
}

function table(kind, ui, rows, escape) {
  const columns = visibleColumns(ui, kind);
  const primary = kind === 'groups' && ui.columnViews.groups.sortRules[0];
  return `<div class="usage-table-wrap" data-usage-scroll="${kind}" role="region" aria-label="${t(kind === 'calls' ? 'usage.callList' : 'usage.usageDetails')}" tabindex="0">
    <table class="usage-table usage-${kind}-table" data-usage-table="${kind}">
      <colgroup>${columns.map(([key]) => `<col data-usage-col="${key}">`).join('')}</colgroup>
      <thead><tr>${columns.map(([key]) => `<th scope="col"${primary?.key === key ? ` aria-sort="${primary.ascending ? 'ascending' : 'descending'}"` : ''}>
        ${kind === 'groups' ? `<button type="button" class="usage-plain" data-usage-sort="${key}" data-usage-focus="sort-${key}">${columnLabel(key)}${primary?.key === key ? primary.ascending ? ' ↑' : ' ↓' : ''}</button>` : columnLabel(key)}
        <button type="button" class="usage-resizer" data-usage-resize="${kind}" data-column="${key}" aria-label="${escape(t('usage.resizeColumn', columnLabel(key)))}" title="${t('usage.resizeHelp')}"></button>
      </th>`).join('')}</tr></thead>
      <tbody>${rows(columns)} </tbody>
    </table></div>`;
}

function callCells(call, item, ui, nested, escape) {
  const group = item?.operation ? item : null;
  const task = item?.representative && group;
  const child = task && ui.children.get(item.key);
  const metrics = call.audit?.metrics || {};
  const tokenLabel = task ? [measurement(item.stats, 'inputTokens'), measurement(item.stats, 'outputTokens')]
    : [known(metrics.inputTokens ?? call.usage?.prompt_tokens), known(metrics.outputTokens ?? call.usage?.completion_tokens)];
  const label = modelName(call), id = escape(call.id);
  const stateLabel = call.kind === 'replay' ? t('usage.replay') : call.kind === 'setup' ? t('usage.setupOnly') : statusLabel(task ? item.taskStatus : call.status);
  const taskKey = task ? escape(item.key) : '';
  const est = estimateText(call.audit?.listEstimate || call.estimate);
  return {
    time: `<div class="usage-time${nested ? ' usage-nested' : ''}">
      ${task && item.count > 1 ? `<button type="button" class="usage-plain usage-chevron" data-usage-action="expand" data-key="${taskKey}" data-usage-focus="expand-${taskKey}" aria-expanded="${Boolean(child)}" aria-label="${t('usage.toggleChild')}">${child ? '⌄' : '›'}</button>` : '<span class="usage-chevron-space"></span>'}
      <button type="button" class="usage-plain" data-usage-action="${task ? 'task-detail' : 'detail'}" data-key="${task ? taskKey : id}"
        data-usage-focus="detail-${task ? taskKey : id}">${escape(dateTime(call.startedAt))}</button></div>`,
    endpoint: task && item.endpointCount > 1 ? t('usage.multipleEndpoints') : escape(endpointName(call.endpoint)),
    initiator: escape(projectName(call.principalId, call.projectName)),
    model: task && item.providerCount > 1 ? t('usage.modelCount', number(item.providerCount)) : escape(label),
    credential: task && item.credentialCount > 1 ? t('usage.multipleCredentials') : escape(credentialName(call.credential)),
    speed: escape(call.audit?.speed || '—'),
    status: `${stateLabel}${task ? ` · ${t('usage.callCount', number(item.count))}` : call.audit?.attempt > 1 ? ` · ${t('usage.attemptNumber', number(call.audit.attempt))}` : ''}`,
    duration: task ? length(item.taskDuration) : length(call.durationMs),
    tokens: tokenLabel.join(' / '),
    media: task ? t('usage.mediaCounts', number(item.stats.images), number(item.stats.videos)) :
      call.images || metrics.images || metrics.videos ? t('usage.mediaCounts', known(metrics.images ?? call.images), known(metrics.videos ?? 0)) : '—',
    accounting: task ? costs(item.stats.priced ? item.stats.costs : item.stats.configuredCosts) :
      `${est}${call.budget?.basis === 'reserved' ? ` · ${t('usage.budgetUnconfirmed', money(call.budget.charged, call.budget.currency))}` : ''}
        ${call.budget?.basis === 'pending' ? ` · ${t('errors.budgetLedgerUnavailable')}` : ''}`
  };
}

function callRows(report, ui, columns, escape) {
  const makeRow = (call, item, nested) => {
    const cells = callCells(call, item, ui, nested, escape);
    return `<tr data-usage-record="${escape(call.id)}"${item?.operation ? ` data-usage-operation="${escape(item.key)}"` : ''}${nested ? ' class="usage-child"' : ''}>
      ${columns.map(([key]) => `<td${key === 'model' && (!item?.operation || item.providerCount === 1) ? ` title="${escape(modelName(call))}"` : ''}>${cells[key]}</td>`).join('')}</tr>`;
  };
  return report.rows.length ? report.rows.map(item => {
    if (ui.mode === 'calls') return makeRow(item, null, false);
    const child = ui.children.get(item.key);
    const row = makeRow(item.representative, item, false);
    if (!child) return row;
    return row + (child.data?.rows || []).map(call => makeRow(call, null, true)).join('') +
      (child.loading || child.error || child.data?.pagination.total > child.data?.pagination.limit ? `<tr class="usage-child"><td class="usage-full-cell" colspan="${columns.length}">
        ${child.loading ? `<span role="status">${t('usage.loading')}</span>` : ''}
        ${child.error ? `<span role="alert">${escape(errorText(child.error))}</span> <button data-usage-action="retry-child" data-key="${escape(item.key)}">${t('usage.retry')}</button>` : ''}
        ${pagination(`child:${escape(item.key)}`, child.data?.pagination, child.loading)}</td></tr>` : '');
  }).join('') : `<tr><td class="usage-empty" colspan="${columns.length}">${t('usage.empty')}</td></tr>`;
}

function callList(report, ui, escape) {
  const summary = report.summary;
  const counters = [
    ['operationsCount', summary.operations], ['standalone', summary.standalone], ['providerCalls', summary.calls], ['usageReported', summary.reported],
    ['inputTokens', summary.inputCount ? summary.inputTokens : null], ['column.cachedTokens', summary.cacheCount ? summary.cachedTokens : null],
    ['outputTokens', summary.outputCount ? summary.outputTokens : null], ['generatedMedia', t('usage.mediaCounts', number(summary.images), number(summary.videos))]
  ];
  const toggleLabel = t(ui.mode === 'operations' ? 'usage.byCall' : 'usage.byTask');
  return `<section class="usage-call-list"><h2>${t('usage.callList')}</h2>
    <p class="usage-muted">${t(ui.mode === 'operations' ? 'usage.tasksHelp' : 'usage.callsHelp')}</p>
    <div class="usage-counters">${counters.map(([label, value]) => `<span>${t(`usage.${label}`)} <strong>${typeof value === 'string' ? value : known(value)}</strong></span>`).join('')}</div>
    <div class="usage-toolbar">
      <button type="button" class="usage-icon-button" data-usage-action="mode" data-usage-focus="mode" title="${toggleLabel}" aria-label="${toggleLabel}"${ui.modeTransition ? ' disabled' : ''}>${icon('M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4')}</button>
      ${columnTool('calls', ui, escape)}
      <button type="button" data-usage-action="export" data-usage-focus="export">${t('usage.exportCalls')}</button>
    </div>
    ${table('calls', ui, columns => callRows(report, ui, columns, escape), escape)}
    ${pagination('main', report.pagination, ui.modeTransition)}
  </section>`;
}

function columnTool(kind, ui, escape) {
  return `<div class="usage-column-tool"><button type="button" class="usage-icon-button" data-usage-action="columns" data-kind="${kind}"
    data-usage-focus="columns" aria-expanded="${ui.columnMenu === kind}" title="${t('usage.columns')}" aria-label="${t('usage.columns')}">
    ${icon('M3 6h11m4 0h3M3 12h3m4 0h11M3 18h11m4 0h3M14 4v4m-8 2v4m8 2v4')}</button>
    ${ui.columnMenu === kind ? columnMenu(kind, ui, escape) : ''}</div>`;
}

function groupLabel(row, dimension) {
  if (dimension === 'projects') return projectName(row.key, row.label);
  if (dimension === 'models') return modelName(row);
  if (dimension === 'endpoints') return endpointName(row.key);
  if (dimension === 'credentials') return credentialName(row);
  return dimension === 'daily' ? row.key : t(`usage.value.${row.key}`);
}

function sortingTool(ui) {
  const rules = ui.columnViews.groups.sortRules;
  return `<div class="usage-column-tool">
    <button type="button" class="usage-icon-button" data-usage-action="sorting" data-usage-focus="sorting" aria-expanded="${ui.sortingMenu}"
      aria-label="${t('usage.sortRules')}" title="${t('usage.sortRules')}">${icon('M5 6h14M8 12h8m-5 6h2')}</button>
    ${ui.sortingMenu ? `<div class="usage-popover usage-sort-menu">
      <h3>${t('usage.sortRules')}</h3>
      ${rules.map((rule, index) => `<div class="usage-sort-row">
        <select data-usage-sort-rule="key" data-index="${index}" data-usage-focus="sort-key-${index}" aria-label="${t('usage.sortColumn')}">
          ${groupColumns.map(([key]) => `<option value="${key}"${key === rule.key ? ' selected' : rules.some(item => item.key === key) ? ' disabled' : ''}>${columnLabel(key)}</option>`).join('')}
        </select>
        <select data-usage-sort-rule="direction" data-index="${index}" data-usage-focus="sort-direction-${index}" aria-label="${t('usage.sortDirection')}">
          <option value="desc"${rule.ascending ? '' : ' selected'}>${t('usage.descending')}</option>
          <option value="asc"${rule.ascending ? ' selected' : ''}>${t('usage.ascending')}</option>
        </select>
        <button type="button" data-usage-action="remove-sort" data-index="${index}" aria-label="${t('usage.removeSort')}">×</button>
      </div>`).join('')}
      <button type="button" data-usage-action="add-sort" data-usage-focus="add-sort"${rules.length === groupColumns.length ? ' disabled' : ''}>${t('usage.addSort')}</button>
    </div>` : ''}</div>`;
}

function groupTable(report, ui, escape) {
  const { dimension, selectedGroup } = ui;
  const sortValue = (row, key) => {
    if (key === 'group') return groupLabel(row, dimension);
    if (key === 'coverage') return row.reported;
    if (key === 'estimate') {
      const amounts = Object.values(row.priced ? row.costs : row.configuredCosts);
      return amounts.length === 1 ? amounts[0].maximum : null;
    }
    return row[key];
  };
  const rows = [...(report.groups[dimension] || [])].sort((a, b) => {
    for (const rule of ui.columnViews.groups.sortRules) {
      const left = sortValue(a, rule.key), right = sortValue(b, rule.key);
      if (left === right || left == null && right == null) continue;
      if (left == null || right == null) return left == null ? 1 : -1;
      const compared = typeof left === 'string' ? left.localeCompare(right) : left - right;
      if (compared) return (rule.ascending ? 1 : -1) * compared;
    }
    return a.key.localeCompare(b.key);
  });
  return `<section class="usage-chart"><div class="usage-chart-heading"><h2>${t('usage.usageDetails')}</h2>
    <label class="usage-inline">${t('usage.dimension')}<select data-usage-change="dimension" data-usage-focus="dimension">
      ${dimensions.map(key => `<option value="${key}"${key === dimension ? ' selected' : ''}>${t(`usage.dimension.${key}`)}</option>`).join('')}
    </select></label></div>
    <div class="usage-toolbar">${sortingTool(ui)}${columnTool('groups', ui, escape)}</div>
    ${table('groups', ui, columns => rows.length ? rows.map(row => {
      const open = selectedGroup === row.key;
      return `<tr>${columns.map(([key]) => `<td>${key === 'group'
        ? `<button type="button" class="usage-plain" data-usage-action="group" data-key="${escape(row.key)}" data-usage-focus="group-${escape(row.key)}" aria-expanded="${open}">${open ? '⌄' : '›'} ${escape(groupLabel(row, dimension))}</button>`
        : key === 'estimate' ? costs(row.priced ? row.costs : row.configuredCosts) : key === 'coverage' ? `${number(row.reported)} / ${number(row.calls)}` : measurement(row, key)}</td>`).join('')}</tr>
        ${open ? `<tr class="usage-child"><td class="usage-full-cell" colspan="${columns.length}">
          ${t('usage.cacheCoverage', number(row.cacheCount))} · ${t('usage.column.cacheWriteTokens')} ${measurement(row, 'cacheWriteTokens')}
          · ${t('usage.column.reasoningTokens')} ${measurement(row, 'reasoningTokens')} · ${t('usage.coverage', number(row.reported), number(row.calls))}
          · ${t('usage.estimateHelp', number(row.priced), number(row.calls))}</td></tr>` : ''}`;
    }).join('') : `<tr><td class="usage-empty" colspan="${columns.length}">${t('usage.empty')}</td></tr>`, escape)}
    <p class="usage-muted usage-table-note">${t('usage.measurementHelp')}</p></section>`;
}

function overviewPage(report, ui, escape) {
  const chartReport = report.summary.priced ? report : { ...report,
    summary: { ...report.summary, costs: report.summary.configuredCosts },
    groups: Object.fromEntries(Object.entries(report.groups).map(([key, rows]) => [key, rows.map(row => ({ ...row, costs: row.configuredCosts }))])) };
  const prices = ui.state.models.filter(model => model.capability !== 'provider_service');
  return `<p class="usage-muted">${t('usage.measurementHelp')}</p>
    ${usageCharts(chartReport, ui.filters, ui, { escape, costs, measurement, modelName })}
    ${groupTable(report, ui, escape)}
    ${ui.billing.view(report)}
    ${prices.length ? `<section class="usage-panel usage-chart"><h2>${t('usage.prices')}</h2><p class="usage-muted">${t('usage.pricesHelp')}</p>
      <div class="usage-price-controls"><select aria-label="${t('common.model')}" data-usage-change="priceModel" data-usage-focus="priceModel">
        ${prices.map(model => `<option value="${escape(model.id)}"${model.id === ui.priceModel ? ' selected' : ''}>
          ${escape(model.name)} · ${escape(ui.state.connections.find(row => row.id === model.connectionId)?.name)}</option>`).join('')}
        </select><button type="button" data-usage-action="price" data-usage-focus="price">${t('usage.editPrice')}</button></div></section>` : ''}`;
}

export function usageView(ui, escape) {
  const { tab, loading, error, report } = ui;
  const tabs = [['aiCalls', 'usage.aiCalls'], ['aiUsage', 'usage.aiUsage']];
  const tabName = t(tabs.find(([key]) => key === tab)[1]);
  return `<div class="usage-heading"><h1>${icon('M3 21h18M5 18v-6h3v6M10 18V7h3v11m2 0V3h3v15', 22)}${tabName}</h1>
    <div class="usage-heading-actions">
      <button type="button" class="usage-icon-button" data-usage-action="refresh" data-usage-focus="refresh" title="${t('usage.refresh')}" aria-label="${t('usage.refresh')}"${loading ? ' disabled' : ''}>${icon('M20 7v5h-5M4 17v-5h5m-4-2a7 7 0 0 1 12-4l3 4M4 14l3 4a7 7 0 0 0 12-4')}</button>
      <button type="button" class="usage-icon-button" data-usage-action="about" data-usage-focus="about" aria-expanded="${ui.about}" title="${t('usage.dataScope')}" aria-label="${t('usage.dataScope')}">${icon('M12 8h.01M12 12v4m9-4a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z')}</button>
      ${ui.about ? `<div class="usage-popover usage-about"><strong>${t('usage.dataScope')}</strong><p>${t('usage.retention', 30)}</p><p>${t('usage.measurementHelp')}</p></div>` : ''}</div>
    </div>
    <div class="usage-tabs" role="tablist" aria-label="${t('usage.title')}">
      ${tabs.map(([key, label]) => `<button type="button" role="tab" id="usage-tab-${key}" aria-controls="usage-tab-content"
        aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}" data-usage-tab="${key}" data-usage-focus="${key}">${t(label)}</button>`).join('')}
    </div>
    <div class="usage-content" id="usage-tab-content" role="tabpanel" aria-labelledby="usage-tab-${tab}" aria-busy="${loading}">
      ${filterPanel(ui, escape)}
      ${error ? `<div class="usage-alert" role="alert">${escape(errorText(error))} <button type="button" data-usage-action="refresh">${t('usage.retry')}</button></div>` : ''}
      ${loading ? `<div class="usage-panel usage-loading" role="status">${t('usage.loading')}</div>` : ''}
      ${(!loading || ui.modeTransition) && ui.current && report ? `${report.writeFailed ? `<p class="usage-alert" role="alert">${t('usage.storageWarning')}</p>` : ''}
        ${overview(report.summary)}${tab === 'aiCalls' ? callList(report, ui, escape) : overviewPage(report, ui, escape)}` : ''}
    </div>`;
}

export function usageCallDetail(call, escape) {
  const audit = call.audit || {}, metrics = audit.metrics || {};
  const items = [
    ['usage.callId', call.id], ['usage.operationId', call.operationId], ['usage.endpointType', endpointName(call.endpoint)],
    ['usage.column.initiator', projectName(call.principalId, call.projectName)],
    ['usage.providerModel', modelName(call)], ['usage.credential', credentialName(call.credential)], ['usage.column.time', dateTime(call.startedAt)],
    ['usage.finishedAt', dateTime(call.finishedAt)], ['usage.column.status', call.kind === 'replay' ? t('usage.replay') : call.kind === 'setup' ? t('usage.setupOnly') : statusLabel(call.status)],
    ['usage.column.duration', length(call.durationMs)],
    ['usage.firstResponse', length(audit.firstResponseMs)], ['usage.providerRequestId', audit.providerRequestId], ['usage.providerTaskId', audit.providerTaskId],
    ['usage.httpStatus', audit.httpStatus], ['usage.finishReason', audit.finishReason], ['usage.errorCode', call.errorCode],
    ['usage.inputTokens', known(metrics.inputTokens ?? call.usage?.prompt_tokens)], ['usage.column.cachedTokens', known(metrics.cachedTokens)],
    ['usage.column.cacheWriteTokens', known(metrics.cacheWriteTokens)], ['usage.outputTokens', known(metrics.outputTokens ?? call.usage?.completion_tokens)],
    ['usage.column.reasoningTokens', known(metrics.reasoningTokens)], ['usage.knownTokens', known(metrics.totalTokens ?? call.usage?.total_tokens)],
    ['usage.generatedMedia', t('usage.mediaCounts', known(metrics.images ?? call.images), known(metrics.videos ?? 0))],
    ['usage.publicEstimate', estimateText(audit.listEstimate)], ['usage.priceVersion', audit.listEstimate?.version],
    ['usage.configuredEstimate', estimateText(call.estimate)]
  ];
  if (call.status !== call.gatewayStatus) items.push(['usage.gatewayResult', statusLabel(call.gatewayStatus)]);
  if (audit.providerErrorCode != null) items.push(['usage.providerErrorCode', audit.providerErrorCode]);
  if (call.budget?.basis === 'pending') items.push(['usage.monthlyBudget', t('errors.budgetLedgerUnavailable')]);
  if (call.budget?.charged != null) items.push(['usage.monthlyBudget', call.budget.basis === 'reserved'
    ? t('usage.budgetUnconfirmed', money(call.budget.charged, call.budget.currency)) : money(call.budget.charged, call.budget.currency)]);
  return `<dl class="usage-detail-grid">${items.map(([key, value]) => `<div><dt>${t(key)}</dt><dd>${escape(value ?? '—')}</dd></div>`).join('')}</dl>
    ${audit.listEstimate?.snapshot ? `<details class="usage-price-snapshot"><summary>${t('usage.priceSnapshot')}</summary>
      <pre>${escape(JSON.stringify(audit.listEstimate.snapshot, null, 2))}</pre></details>` : ''}`;
}
