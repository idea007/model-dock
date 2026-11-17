import { dateTime, errorText, t } from '../../packages/ui/i18n.mjs';
import { callColumns, groupColumns, endpointName, modelName, pagination, usageCallDetail, usageView, visibleColumns } from './usage-view.mjs';
import { UsageBillingPanel } from './usage-billing.mjs';

export { money } from './usage-view.mjs';

const filterNames = ['project', 'credential', 'model', 'endpoint', 'dateFrom', 'dateTo'];
const initialFilters = () => Object.fromEntries(filterNames.map(key => [key, '']));
const tabFromLocation = () => new URLSearchParams(location.search).get('tab') === 'aiUsage' ? 'aiUsage' : 'aiCalls';
const viewKey = 'model-dock-usage-columns-v1';

function columnView(kind, saved = {}) {
  const columns = kind === 'calls' ? callColumns : groupColumns;
  const keys = columns.map(([key]) => key);
  const hiddenByDefault = kind === 'calls' ? ['credential', 'speed', 'media']
    : ['cacheWriteTokens', 'reasoningTokens', 'images', 'videos', 'mediaSeconds', 'inputCharacters'];
  const rename = key => kind === 'calls' && key === 'feature' ? 'endpoint' : key;
  const hidden = Array.isArray(saved.hidden) ? saved.hidden.map(rename) : hiddenByDefault;
  const order = Array.isArray(saved.order) ? saved.order.map(rename).filter(key => keys.includes(key)) : [];
  const sortRules = Array.isArray(saved.sortRules) ? saved.sortRules.filter((rule, index, rules) => keys.includes(rule?.key)
    && rules.findIndex(item => item?.key === rule.key) === index).map(rule => ({ key: rule.key, ascending: Boolean(rule.ascending) }))
    : [{ key: 'totalTokens', ascending: false }];
  return { hidden: keys.filter((key, index) => index && hidden.includes(key)), order: [...new Set([...order, ...keys])],
    ...(kind === 'groups' && { sortRules }),
    widths: Object.fromEntries(columns.map(([key, width, min]) => {
      const savedWidth = saved.widths?.[key] ?? (key === 'endpoint' ? saved.widths?.feature : undefined);
      return [key, Number.isFinite(savedWidth) ? Math.max(min, Math.min(800, savedWidth)) : width];
    })) };
}

function loadColumnViews() {
  let saved;
  try { saved = JSON.parse(window.localStorage.getItem(viewKey)); } catch {}
  return { calls: columnView('calls', saved?.calls || {}), groups: columnView('groups', saved?.groups || {}) };
}

function findControl(root, key) {
  if (!key) return null;
  return [...root.querySelectorAll('[data-usage-focus]')].find(control => control.dataset.usageFocus === key);
}

export class UsageWorkspace {
  constructor({ api, escape, notify, editPrice }) {
    Object.assign(this, { api, escape, notify, editPrice, columnViews: loadColumnViews() });
    this.billing = new UsageBillingPanel(this);
    this.clear();
  }

  clear() {
    this.detach();
    this.report = this.error = this.chartBase = null;
    this.filters = initialFilters();
    this.offset = this.costOffset = 0;
    this.tab = 'aiCalls';
    this.mode = 'operations';
    this.filtersOpen = this.about = false;
    this.dimension = 'sources';
    this.sortingMenu = false;
    this.heatMetric = this.shareMetric = 'tokens';
    this.trendMetric = 'calls';
    this.priceModel = this.selectedGroup = this.columnMenu = '';
    this.children = new Map();
    this.scroll = new Map();
  }

  mount(root, state) {
    this.root = root;
    this.state = state;
    root.addEventListener('click', event => this.click(event));
    root.addEventListener('change', event => this.change(event));
    root.addEventListener('contextmenu', event => this.showRowMenu(event));
    root.addEventListener('keydown', event => this.keydown(event));
    root.addEventListener('pointerdown', event => this.startPointer(event));
    this.draw();
  }

  detach() {
    this.request?.abort();
    this.request = null;
    this.modeTransition = this.failedMode = null;
    this.clearChildren();
    this.dialog?.close();
    this.billing.reset();
    this.root = null;
  }

  clearChildren() {
    this.children?.forEach(item => item.request?.abort());
    this.children?.clear();
  }

  params(extra = {}) {
    const values = { version: 2, ...this.filters, mode: this.mode, offset: this.offset, costOffset: this.costOffset, ...extra };
    return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value != null));
  }

  listUrl(extra) {
    return `/admin/usage/analytics?${this.params(extra)}`;
  }

  enter() {
    const tab = tabFromLocation();
    if (tab !== this.tab) this.offset = this.costOffset = 0;
    this.tab = tab;
    return this.refresh();
  }

  async refresh(nextMode = null) {
    if (!this.root) return;
    this.request?.abort();
    this.clearChildren();
    const url = this.listUrl(nextMode ? { mode: nextMode, offset: 0 } : {});
    const focus = this.root.contains(document.activeElement) ? document.activeElement.dataset.usageFocus : '';
    const request = new AbortController();
    this.request = request;
    this.modeTransition = nextMode;
    this.failedMode = null;
    this.error = null;
    this.draw();
    try {
      const report = await this.api(url, { signal: request.signal });
      if (request.signal.aborted) return;
      if (nextMode) {
        this.mode = nextMode;
        this.offset = 0;
      }
      this.report = report;
      this.reportUrl = url;
    } catch (error) {
      if (!request.signal.aborted) {
        this.error = error;
        this.failedMode = nextMode;
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        this.modeTransition = null;
        this.draw(document.activeElement === document.body ? focus : '');
      }
    }
  }

  draw(focusKey) {
    const root = this.root;
    if (!root?.isConnected) return;
    focusKey ||= root.contains(document.activeElement) ? document.activeElement.dataset.usageFocus : '';
    const focused = findControl(root, focusKey);
    const selection = focused?.tagName === 'INPUT' && focused.type === 'text'
      ? [focused.selectionStart, focused.selectionEnd] : null;
    for (const element of root.querySelectorAll('[data-usage-scroll]')) this.scroll.set(element.dataset.usageScroll, element.scrollLeft);
    this.menu = null;
    root.innerHTML = usageView({ ...this, loading: Boolean(this.request), current: this.reportUrl === this.listUrl() }, this.escape);
    this.applyWidths();
    for (const element of root.querySelectorAll('[data-usage-scroll]')) element.scrollLeft = this.scroll.get(element.dataset.usageScroll) || 0;
    const control = findControl(root, focusKey);
    control?.focus({ preventScroll: true });
    if (control && selection) control.setSelectionRange(...selection);
  }

  switchTab(tab) {
    if (this.tab === tab) return;
    this.tab = tab;
    this.offset = this.costOffset = 0;
    this.columnMenu = '';
    this.sortingMenu = false;
    const params = new URLSearchParams(location.search);
    params.set('tab', tab);
    history.pushState(null, '', `${location.pathname}?${params}`);
    this.draw(tab);
    void this.refresh();
  }

  change(event) {
    if (event.target.dataset.usageBillingField) {
      void this.billing.change(event.target).catch(error => this.notify(errorText(error), true));
      return;
    }
    const ruleField = event.target.dataset.usageSortRule;
    if (ruleField) {
      const rule = this.columnViews.groups.sortRules[Number(event.target.dataset.index)];
      if (ruleField === 'key') rule.key = event.target.value;
      else rule.ascending = event.target.value === 'asc';
      this.saveColumns();
      this.draw();
      return;
    }
    const { usageFilter: filter, usageColumn: column, usageChange: field, column: key } = event.target.dataset;
    if (filter) {
      const value = event.target.value;
      if (filter === 'credential') this.filters.model = '';
      if (filter === 'credential' || filter === 'model') this.filters.endpoint = '';
      this.filters[filter] = value;
      this.chartBase = null;
      this.selectedGroup = '';
      this.offset = this.costOffset = 0;
      void this.refresh();
    } else if (column) {
      const view = this.columnViews[column];
      view.hidden = event.target.checked ? view.hidden.filter(value => value !== key) : [...view.hidden, key];
      this.saveColumns();
      this.draw();
    } else if (field) {
      this[field] = event.target.value;
      if (field === 'dimension') this.selectedGroup = '';
      if (field !== 'priceModel') this.draw();
    }
  }

  async click(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const data = button.dataset, action = data.usageAction;
    try {
      if (data.usageBillingAction) {
        await this.billing.click(data.usageBillingAction, button);
        return;
      }
      if (data.usageTab) this.switchTab(data.usageTab);
      if (data.usagePage) {
        const offset = Number(data.offset);
        if (data.usagePage.startsWith('child:')) await this.loadChild(data.usagePage.slice(6), offset);
        else if (data.usagePage === 'main') {
          this.offset = offset;
          await this.refresh();
        } else if (data.usagePage === 'cost') {
          this.costOffset = offset;
          await this.refresh();
        }
      }
      if (data.usageChartDate || data.usageChartModel) {
        this.chartBase ||= { ...this.filters };
        if (data.usageChartDate) this.filters.dateFrom = this.filters.dateTo = data.usageChartDate;
        if (data.usageChartModel) this.filters.model = data.usageChartModel;
        this.offset = this.costOffset = 0;
        await this.refresh();
      }
      if (data.usageSort) {
        const current = this.columnViews.groups.sortRules[0];
        this.columnViews.groups.sortRules = [{ key: data.usageSort, ascending: current?.key === data.usageSort && !current.ascending }];
        this.saveColumns();
        this.draw();
      }
      if (data.usageColumnMove) {
        const { order } = this.columnViews[data.usageColumnMove];
        const index = order.indexOf(data.column), destination = index + Number(data.direction);
        if (destination >= 0 && destination < order.length) {
          [order[index], order[destination]] = [order[destination], order[index]];
          this.saveColumns();
          this.draw();
        }
      }
      switch (action) {
        case 'refresh': await this.refresh(this.failedMode); break;
        case 'filters': this.filtersOpen = !this.filtersOpen; this.draw(); break;
        case 'about': this.about = !this.about; this.draw(); break;
        case 'undo-chart':
          this.filters = this.chartBase;
          this.chartBase = null;
          this.offset = this.costOffset = 0;
          await this.refresh();
          break;
        case 'mode':
          await this.refresh(this.mode === 'operations' ? 'calls' : 'operations');
          break;
        case 'columns': this.sortingMenu = false; this.columnMenu = this.columnMenu === data.kind ? '' : data.kind; this.draw(); break;
        case 'sorting': this.columnMenu = ''; this.sortingMenu = !this.sortingMenu; this.draw(); break;
        case 'add-sort': {
          const rules = this.columnViews.groups.sortRules;
          const next = groupColumns.find(([key]) => !rules.some(rule => rule.key === key));
          if (next) {
            rules.push({ key: next[0], ascending: false });
            this.saveColumns();
            this.draw(`sort-key-${rules.length - 1}`);
          }
          break;
        }
        case 'remove-sort':
          this.columnViews.groups.sortRules.splice(Number(data.index), 1);
          this.saveColumns(); this.draw('add-sort');
          break;
        case 'reset-columns': this.columnViews[data.kind] = columnView(data.kind); this.saveColumns(); this.draw(); break;
        case 'group': this.selectedGroup = this.selectedGroup === data.key ? '' : data.key; this.draw(); break;
        case 'expand': this.toggleChild(data.key); break;
        case 'retry-child': await this.loadChild(data.key); break;
        case 'detail': this.openCall(this.findCall(data.key), button); break;
        case 'task-detail': this.openTask(data.key, button); break;
        case 'export': await this.download(`/admin/usage/calls.csv?${this.params({ offset: null, costOffset: null })}`, 'model-dock-ai-calls.csv', button); break;
        case 'price': this.editPrice(this.root.querySelector('[data-usage-change="priceModel"]')?.value); break;
      }
    } catch (error) { this.notify(errorText(error), true); }
  }

  async download(url, filename, button) {
    button.disabled = true;
    try {
      const response = await this.api(url, {}, true);
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } finally { button.disabled = false; }
  }

  toggleChild(key) {
    if (!this.children.has(key)) { void this.loadChild(key); return; }
    this.children.get(key).request?.abort();
    this.children.delete(key);
    this.draw();
  }

  async loadChild(key, offset = 0) {
    const entry = this.children.get(key) || {};
    entry.request?.abort();
    const request = new AbortController();
    Object.assign(entry, { request, loading: true, error: null });
    this.children.set(key, entry);
    this.draw();
    try {
      const data = await this.api(this.listUrl({ mode: 'calls', offset, operation: key }), { signal: request.signal });
      if (!request.signal.aborted) entry.data = data;
    } catch (error) {
      if (!request.signal.aborted) entry.error = error;
    } finally {
      if (entry.request === request && !request.signal.aborted) {
        entry.loading = false;
        this.draw();
      }
    }
  }

  findCall(id) {
    for (const row of this.report?.rows || []) {
      const call = row.representative || row;
      if (call.id === id) return call;
    }
    for (const { data } of this.children.values()) {
      const call = data?.rows.find(row => row.id === id);
      if (call) return call;
    }
    return this.report?.cost.rows.find(call => call.id === id);
  }

  keydown(event) {
    const tab = event.target.dataset.usageTab;
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      this.switchTab(event.key === 'Home' ? 'aiCalls' : event.key === 'End' ? 'aiUsage' : tab === 'aiCalls' ? 'aiUsage' : 'aiCalls');
    }
    if (event.key === 'Escape') {
      if (this.menu) this.closeRowMenu(true);
      else if (this.columnMenu || this.about || this.sortingMenu) {
        const focus = this.columnMenu ? 'columns' : this.sortingMenu ? 'sorting' : 'about';
        this.columnMenu = '';
        this.about = this.sortingMenu = false;
        this.draw(focus);
      }
    }
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') this.showRowMenu(event);
    const kind = event.target.dataset.usageResize;
    if (kind && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const key = event.target.dataset.column;
      this.resize(kind, key, this.columnViews[kind].widths[key] + (event.key === 'ArrowLeft' ? -12 : 12));
      this.saveColumns();
    }
  }

  closeRowMenu(focus) {
    const menu = this.menu;
    menu?.remove();
    this.menu = null;
    if (focus && menu?.anchor?.isConnected) menu.anchor.focus({ preventScroll: true });
  }

  showRowMenu(event) {
    const row = event.target.closest('[data-usage-record]');
    if (!row) return;
    event.preventDefault();
    this.closeRowMenu();
    const anchor = row.querySelector('[data-usage-action="task-detail"], [data-usage-action="detail"]');
    const key = row.dataset.usageOperation || row.dataset.usageRecord;
    const safe = this.escape(key), op = Boolean(row.dataset.usageOperation);
    const menu = document.createElement('div');
    menu.className = 'usage-popover usage-row-menu';
    menu.anchor = anchor;
    const canExpand = op && this.report.rows.some(item => item.key === key && item.count > 1);
    menu.innerHTML = `${canExpand ? `<button type="button" data-usage-action="expand" data-key="${safe}">${t(this.children.has(key) ? 'usage.collapseTask' : 'usage.expandTask')}</button>` : ''}
      <button type="button" data-usage-action="${op ? 'task-detail' : 'detail'}" data-key="${safe}">${t(op ? 'usage.taskDetail' : 'usage.callDetail')}</button>`;
    const point = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 210, event.clientX || point.left))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - 110, event.clientY || point.bottom))}px`;
    this.root.append(menu);
    this.menu = menu;
    menu.querySelector('button').focus({ preventScroll: true });
  }

  saveColumns() {
    try { window.localStorage.setItem(viewKey, JSON.stringify(this.columnViews)); } catch {}
  }

  applyWidths() {
    for (const table of this.root.querySelectorAll('[data-usage-table]')) {
      const kind = table.dataset.usageTable;
      const widths = this.columnViews[kind].widths;
      let total = 0;
      for (const col of table.querySelectorAll('[data-usage-col]')) {
        const width = widths[col.dataset.usageCol];
        col.style.width = `${width}px`;
        total += width;
      }
      table.style.width = `${total}px`;
    }
  }

  resize(kind, key, width) {
    const definition = visibleColumns(this, kind).find(column => column[0] === key);
    this.columnViews[kind].widths[key] = Math.round(Math.max(definition[2], Math.min(800, width)));
    this.applyWidths();
  }

  startPointer(event) {
    if (this.menu && !this.menu.contains(event.target)) this.closeRowMenu();
    if (event.button !== 0) return;
    const handle = event.target.closest('[data-usage-resize]');
    const scroller = event.target.closest('[data-usage-scroll]');
    if (!scroller || (!handle && (event.pointerType !== 'mouse' || event.target.closest('button, a, input, th')))) return;
    const kind = handle?.dataset.usageResize, key = handle?.dataset.column;
    const start = event.clientX, original = handle ? this.columnViews[kind].widths[key] : scroller.scrollLeft;
    const move = next => {
      if (next.pointerId !== event.pointerId) return;
      const delta = next.clientX - start;
      if (handle) this.resize(kind, key, original + delta);
      else scroller.scrollLeft = original - delta;
    };
    const end = next => {
      if (next.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      scroller.classList.remove('usage-dragging');
      if (handle) this.saveColumns();
    };
    event.preventDefault();
    scroller.classList.add('usage-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  modal(title, anchor) {
    const focus = this.menu?.anchor || anchor;
    this.closeRowMenu();
    this.dialog?.close();
    const dialog = document.createElement('dialog');
    const controller = new AbortController();
    dialog.className = 'usage-dialog';
    dialog.setAttribute('aria-labelledby', 'usage-dialog-title');
    dialog.innerHTML = `<div class="usage-dialog-heading"><h2 id="usage-dialog-title">${this.escape(title)}</h2>
      <button type="button" aria-label="${t('common.close')}" autofocus>×</button></div><div class="usage-dialog-body"></div>`;
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      controller.abort();
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    this.dialog = dialog;
    return { body: dialog.querySelector('.usage-dialog-body'), signal: controller.signal };
  }

  openCall(call, anchor) {
    if (!call) return;
    const { body, signal } = this.modal(t('usage.callDetail'), anchor);
    this.renderCallDetail(body, call, signal);
  }

  renderCallDetail(body, call, signal) {
    body.innerHTML = usageCallDetail(call, this.escape);
    const summary = call.audit?.development;
    const section = document.createElement('section');
    section.className = 'usage-development';
    const parts = ['input', 'reasoning', 'output'];
    section.innerHTML = `<h3>${t('usage.development.title')}</h3>${
      !this.report?.developmentEnabled ? `<p class="usage-muted">${t('usage.development.disabled')}</p>` :
      summary?.status === 'failed' ? `<p class="usage-alert">${t(`usage.development.${summary.reason}`)}</p>` :
      parts.map(key => summary?.parts?.includes(key) ? `<details data-capture="${key}">
        <summary>${t(`usage.development.${key}`)}</summary><pre></pre></details>` :
        `<p class="usage-muted">${t('usage.development.missing', t(`usage.development.${key}`))}</p>`).join('')
    }`;
    body.append(section);
    let detail;
    for (const item of section.querySelectorAll('[data-capture]')) {
      const value = item.querySelector('pre');
      item.addEventListener('toggle', async () => {
        if (!item.open || item.dataset.loaded) return;
        value.textContent = t('usage.loading');
        try {
          detail ||= this.api(`/admin/usage/development/${encodeURIComponent(call.id)}`, { signal });
          const { data } = await detail;
          if (signal.aborted || !item.isConnected) return;
          const content = data[item.dataset.capture];
          value.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
          item.dataset.loaded = 'true';
        } catch (error) {
          detail = null;
          if (!signal.aborted) value.textContent = errorText(error);
        }
      });
    }
  }

  openTask(key, anchor) {
    const group = this.report?.rows.find(row => row.key === key);
    if (!group) return;
    const { body, signal } = this.modal(t('usage.taskDetail'), anchor);
    const load = async offset => {
      body.innerHTML = `<p role="status">${t('usage.loading')}</p>`;
      try {
        const { rows, pagination: page } = await this.api(this.listUrl({ mode: 'calls', operation: key, offset }), { signal });
        if (signal.aborted) return;
        const detail = document.createElement('section');
        body.innerHTML = `<div class="usage-task-call-list">${rows.map((call, index) =>
          `<button type="button" data-call="${index}" aria-pressed="${index === 0}">${this.escape(`${dateTime(call.startedAt)} · ${modelName(call)} · ${endpointName(call.endpoint)}`)}</button>`).join('')}</div>
          ${pagination('task', page)}`;
        body.append(detail);
        if (rows[0]) this.renderCallDetail(detail, rows[0], signal);
        for (const button of body.querySelectorAll('[data-call]')) {
          button.addEventListener('click', () => {
            body.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
            button.setAttribute('aria-pressed', 'true');
            this.renderCallDetail(detail, rows[Number(button.dataset.call)], signal);
          });
        }
        for (const button of body.querySelectorAll('[data-offset]')) button.addEventListener('click', () => void load(Number(button.dataset.offset)));
      } catch (error) {
        if (signal.aborted) return;
        body.innerHTML = `<p role="alert">${this.escape(errorText(error))}</p><button type="button">${t('usage.retry')}</button>`;
        body.querySelector('button').addEventListener('click', () => void load(offset));
      }
    };
    void load(0);
  }
}
