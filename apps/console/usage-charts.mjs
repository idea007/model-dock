import { language, number, t } from '../../packages/ui/i18n.mjs';

const dayLength = 86_400_000;
const dateValue = date => Date.parse(`${date}T00:00:00Z`);
const percent = value => value == null ? '—' : number(value, { style: 'percent', maximumFractionDigits: 1 });
const chartButton = (field, value, escape) => `data-usage-chart-${field}="${escape(value)}"`;

function chartDays(report, filters) {
  const { earliest, latest } = report.bounds;
  const from = Math.max(dateValue(filters.dateFrom || earliest), dateValue(earliest));
  const to = Math.min(dateValue(filters.dateTo || latest), dateValue(latest));
  const days = new Map(report.groups.daily.map(row => [row.key, row]));
  return Array.from({ length: Math.max(0, (to - from) / dayLength + 1) }, (_, index) => {
    const key = new Date(from + index * dayLength).toISOString().slice(0, 10);
    return days.get(key) || { key, calls: 0, tokenCount: 0, totalTokens: 0, costs: {}, empty: true };
  });
}

function weekdayLabel(day) {
  return new Intl.DateTimeFormat(language(), { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 5 + day));
}

function metricPicker(name, selected, options) {
  return `<label class="usage-inline">${t(`usage.${name}`)}
    <select data-usage-change="${name}" data-usage-focus="${name}">
      ${options.map(value => `<option value="${value}"${value === selected ? ' selected' : ''}>${t(`usage.${value}`)}</option>`).join('')}
    </select></label>`;
}

function heading(title, description, action = '') {
  return `<div class="usage-chart-heading"><div><h2>${t(title)}</h2><p>${t(description)}</p></div>${action}</div>`;
}

function heatmap(days, report, filters, metric, { escape, costs }) {
  const hourly = days.length > 0 && days.length <= 7;
  const labels = Array.from({ length: 7 }, (_, index) => weekdayLabel(index));
  const byWeekday = new Map(days.map(row => [(new Date(dateValue(row.key)).getUTCDay() + 6) % 7, row.key]));
  const byHour = new Map(report.groups.hourly.map(row => [row.key, row]));
  const hourCells = labels.map((_, weekday) => Array.from({ length: 24 }, (_, hour) => {
    const date = byWeekday.get(weekday);
    if (!date) return null;
    const key = `${date}T${String(hour).padStart(2, '0')}`;
    return byHour.get(key) || { key, day: date, calls: 0, totalTokens: 0, costs: {}, empty: true };
  }));
  const currencies = Object.keys(report.summary.costs);
  const value = row => metric === 'calls' ? row.calls : metric === 'estimate' ? currencies.length === 1
    ? row.costs[currencies[0]]?.maximum : null : row.totalTokens;
  const maximum = Math.max(0, ...(hourly ? hourCells.flat() : days).filter(Boolean).map(row => value(row) || 0));
  const cell = row => {
    if (!row) return '<span class="usage-heat-empty"></span>';
    const date = row.day || row.key, quantity = value(row);
    const level = maximum && quantity > 0 ? Math.min(4, Math.ceil(Math.sqrt(quantity / maximum) * 4)) : 0;
    const label = `${row.key.replace('T', ' ')} · ${metric === 'estimate' ? costs(row.costs)
      : metric === 'tokens' && !row.empty && !row.tokenCount && !row.totalTokens ? '—' : number(quantity ?? 0)} · ${t('usage.callCount', number(row.calls))}`;
    return `<button type="button" class="usage-heat-cell usage-heat-${level}${!row.empty && quantity == null ? ' usage-heat-unknown' : ''}"
      ${chartButton('date', date, escape)} data-usage-focus="heat-${escape(row.key)}"
      aria-pressed="${filters.dateFrom === date && filters.dateTo === date}" aria-label="${escape(label)}" title="${escape(label)}"></button>`;
  };
  const weekday = days.length ? (new Date(dateValue(days[0].key)).getUTCDay() + 6) % 7 : 0;
  const cells = [...Array(weekday).fill(null), ...days];
  const months = Array.from(new Set(days.map(row => row.key.slice(0, 7))));
  return `<section class="usage-panel usage-chart">
    ${heading('usage.heatmap', 'usage.heatHelp', metricPicker('heatMetric', metric, ['tokens', 'calls', 'estimate']))}
    ${metric === 'estimate' && currencies.length > 1 ? `<p class="usage-muted">${t('usage.multipleCurrencies')}</p>` : ''}
    ${!days.length ? `<p class="usage-muted">${t('usage.empty')}</p>` : `
      <div class="usage-chart-scroll" tabindex="0" aria-label="${t(hourly ? 'usage.hourView' : 'usage.dayView')}">
        ${hourly ? `<div class="usage-hours"><span></span>${Array.from({ length: 24 }, (_, hour) => `<span>${String(hour).padStart(2, '0')}</span>`).join('')}</div>
        ${labels.map((label, index) => `<div class="usage-hours"><span>${label} ${byWeekday.get(index)?.slice(5) || ''}</span>${hourCells[index].map(cell).join('')}</div>`).join('')}`
          : `<div class="usage-day-months">${months.map(month => `<span>${new Intl.DateTimeFormat(language(), { month: 'short', timeZone: 'UTC' }).format(dateValue(month + '-01'))}</span>`).join('')}</div>
            <div class="usage-days"><div>${labels.map(label => `<span>${label}</span>`).join('')}</div><div>${cells.map(cell).join('')}</div></div>`}
      </div>
      <div class="usage-heat-footer"><span>${days[0].key} — ${days.at(-1).key} · ${t(hourly ? 'usage.hourView' : 'usage.dayView')}</span>
        <span class="usage-heat-legend">${t('usage.less')} ${[0, 1, 2, 3, 4].map(level => `<i class="usage-heat-${level}"></i>`).join('')} ${t('usage.more')}</span>
      </div>`}</section>`;
}

function tokenParts(row) {
  const input = row.inputTokens || 0, output = row.outputTokens || 0;
  const cache = row.cachedTokens || 0, write = row.cacheWriteTokens || 0, reasoning = row.reasoningTokens || 0;
  const splitInput = row.inputCount && row.cacheCount === row.inputCount && cache + write <= input;
  const splitOutput = row.outputCount && row.reasoningCount === row.outputCount && reasoning <= output;
  return [
    ...(splitInput ? [['input', input - cache - write], ['cache', cache], ['cacheWrite', write]] : [['inputAll', input]]),
    ...(splitOutput ? [['output', output - reasoning], ['reasoning', reasoning]] : [['outputAll', output]]),
    ['unallocated', Math.max(0, row.totalTokens - input - output)]
  ].filter(([, value]) => value > 0);
}

function trend(days, filters, metric, { escape, costs, measurement }) {
  const tokens = metric === 'tokens';
  const currencies = new Set(days.flatMap(row => Object.keys(row.costs)));
  const parts = row => tokens ? tokenParts(row) : [[metric, metric === 'calls' ? row.calls :
    currencies.size === 1 ? Object.values(row.costs)[0]?.maximum || 0 : 0]];
  const maximum = Math.max(1e-6, ...days.map(row => parts(row).reduce((sum, [, value]) => sum + value, 0)));
  const legend = [...new Set(days.flatMap(row => parts(row).filter(([, value]) => value).map(([key]) => key)))];
  return `<section class="usage-panel usage-chart">
    ${heading(tokens ? 'usage.tokenTrend' : 'usage.otherTrend', tokens ? 'usage.tokenTrendHelp' : 'usage.otherTrendHelp',
      tokens ? '' : metricPicker('trendMetric', metric, ['calls', 'estimate']))}
    ${metric === 'estimate' && currencies.size > 1 ? `<p class="usage-muted">${t('usage.multipleCurrencies')}</p>` : ''}
    ${days.length ? `<div class="usage-chart-scroll" tabindex="0" aria-label="${t(tokens ? 'usage.tokenTrend' : 'usage.otherTrend')}"><div class="usage-trend">
      ${days.map((row, index) => {
        let top = 100;
        const bars = parts(row);
        const value = tokens ? row.empty ? '0' : measurement(row, 'totalTokens') : metric === 'calls' ? number(row.calls) : costs(row.costs);
        const label = [row.key, value, ...(tokens ? bars.map(([key, size]) => `${t(`usage.part.${key}`)} ${number(size)}`) : [])].join(' · ');
        return `<button type="button" ${chartButton('date', row.key, escape)} data-usage-focus="${metric}-${row.key}"
          aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="${filters.dateFrom === row.key && filters.dateTo === row.key}">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bars.map(([key, size]) => {
            const height = 100 * size / maximum;
            top -= height;
            return `<rect class="usage-part-${key}" width="100" y="${Math.max(0, top).toFixed(4)}" height="${height.toFixed(4)}"/>`;
          }).join('')}</svg><span>${index % Math.max(1, Math.ceil(days.length / 8)) === 0 ? row.key.slice(5) : '&nbsp;'}</span></button>`;
      }).join('')}</div></div>` : `<p class="usage-muted">${t('usage.empty')}</p>`}
    ${tokens && legend.length ? `<div class="usage-chart-legend">${legend.map(key => `<span><i class="usage-part-${key}"></i>${t(`usage.part.${key}`)}</span>`).join('')}</div>` : ''}</section>`;
}

function shares(rows, filters, metric, { escape, costs, measurement, modelName }) {
  const groups = new Map();
  for (const row of rows) {
    const entries = metric === 'estimate' ? Object.entries(row.costs) : [['', { maximum: row.totalTokens }]];
    for (const [currency, amount] of entries.length ? entries : [['unknown', {}]]) {
      if (!groups.has(currency)) groups.set(currency, []);
      groups.get(currency).push({ row, amount });
    }
  }
  return `<section class="usage-panel usage-chart">
    ${heading('usage.modelShares', 'usage.modelSharesHelp', metricPicker('shareMetric', metric, ['tokens', 'estimate']))}
    <div class="usage-model-shares">${groups.size ? [...groups].map(([currency, entries]) => {
      const total = entries.reduce((sum, { amount }) => sum + (amount.maximum || 0), 0);
      return `${currency ? `<p class="usage-muted">${escape(currency === 'unknown' ? t('usage.unpriced') : currency)}</p>` : ''}
        ${entries.sort((a, b) => (b.amount.maximum || 0) - (a.amount.maximum || 0)).map(({ row, amount }) => {
          const full = total && amount.maximum != null && (amount.maximum > 0 || metric === 'estimate' || row.tokenCount);
          const fraction = full ? amount.maximum / total : null;
          const label = modelName(row);
          return `<button type="button" class="usage-share" ${chartButton('model', row.key, escape)} aria-pressed="${filters.model === row.key}"
            data-usage-focus="share-${escape(row.key)}"><span><strong>${escape(label)}</strong><span>${metric === 'tokens' ? measurement(row, 'totalTokens') : costs(currency !== 'unknown' ? { [currency]: amount } : {})} · ${percent(fraction)}</span></span>
            <progress value="${fraction || 0}" max="1" aria-label="${escape(label)}"></progress>
            <small>${t('usage.callCount', number(row.calls))} · ${t('usage.coverage', number(row.reported), number(row.calls))}</small></button>`;
        }).join('')}`;
    }).join('') : `<p class="usage-muted">${t('usage.empty')}</p>`}</div></section>`;
}

export function usageCharts(report, filters, preferences, format) {
  const days = chartDays(report, filters);
  return `${heatmap(days, report, filters, preferences.heatMetric, format)}
    ${trend(days, filters, 'tokens', format)}${trend(days, filters, preferences.trendMetric, format)}
    ${shares(report.groups.models, filters, preferences.shareMetric, format)}`;
}
