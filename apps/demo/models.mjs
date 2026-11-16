// Framework-independent model settings, adapted from the reference capability manager.
import { errorText, number, t } from '../../packages/ui/i18n.mjs';
import { featureName, groupName } from '../../packages/ui/feature-labels.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const groupOf = route => route.group || '';
const selected = (route, id) => route.allowedModelIds.includes(id);
const compatible = (route, model) => Boolean(model) && model.capabilities?.text !== false && (route.kind !== 'extract' || model.capabilities?.structured !== false);
const relevant = (route, model) => compatible(route, model) || selected(route, model.id)
  || route.modelId === model.id || Boolean(route.reasoningOverrides?.[model.id]);
const requirements = route => route.kind === 'extract' ? t('manager.structuredRequirements') : t('common.textGeneration');
const focusKey = node => node.dataset.focus || ['mm', 'id', 'value', 'group', 'route', 'level'].map(key => node.dataset[key] || '').join('|');
const labels = { none: 'common.off', minimal: 'effort.minimal', low: 'effort.low', medium: 'effort.medium', high: 'effort.high', xhigh: 'effort.xhigh', max: 'effort.max', ultra: 'effort.ultra' };
const effortLabel = level => Object.hasOwn(labels, level) ? t(labels[level]) : level;
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const pin = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5-4 1-4 4 1 3-2 2-6-6 2-2 3 1 4-4z"/><path d="m8 16-5 5"/></svg>';
const refresh = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/></svg>';
const sourceLabels = { openai: 'common.modelApi', ollama: 'common.localOllama', codex: 'common.localCodex', pool: 'pools.source' };
const storageKey = 'model-dock-demo-draft-v1';
const columns = { connections: [['provider', 'common.credentialService', 152, 120], ['model', 'common.model', 256, 180], ['effort', 'common.effortsHeading', 320, 180]], functions: [['feature', 'manager.feature', 200, 120], ['model', 'common.model', 416, 240]] };
const config = state => ({ models: state.models.map(model => ({ id: model.id, enabled: model.enabled, reasoningPolicy: model.reasoningPolicy || null, groupPolicies: model.groupPolicies || {} })), routes: clone(state.routes) });
function fallback(levels, previous) {
  const rank = Object.keys(labels), index = rank.indexOf(previous);
  return [...levels].reverse().find(level => rank.indexOf(level) <= index) || levels[0];
}
function narrowed(policy, available) {
  if (!policy) return null;
  const allowedEfforts = policy.allowedEfforts.filter(level => available.includes(level));
  if (!allowedEfforts.length) allowedEfforts.push(available[0]);
  return { allowedEfforts, defaultEffort: allowedEfforts.includes(policy.defaultEffort) ? policy.defaultEffort : fallback(allowedEfforts, policy.defaultEffort) };
}

export class ModelManager {
  constructor({ api, onState, notify, onDetails }) {
    Object.assign(this, { api, onState, notify, onDetails, view: 'connections', filter: 'all', search: '', open: {}, widths: {}, busy: false, notice: '' });
    this.unload = event => { if (this.dirtyCount) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', this.unload);
  }
  reset() { this.snapshot = this.base = this.draft = null; this.restored = false; this.failure = undefined; this.notice = ''; sessionStorage.removeItem(storageKey); }
  get error() { return this.failure?.() || ''; }
  accept(state, discard = false) {
    this.latest = state;
    if (!discard && this.dirtyCount) { this.acceptCatalog(state); return; }
    this.snapshot = state; this.base = config(state); this.draft = clone(this.base);
    if (discard) { this.restored = true; this.remember(); }
    if (!this.restored && !discard) {
      this.restored = true;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        if (state.connection?.configured === false && saved?.snapshot?.models?.length) {
          sessionStorage.removeItem(storageKey); this.notice = 'manager.connectFirst';
        } else if (saved?.base && Array.isArray(saved.draft?.models) && Array.isArray(saved.draft?.routes) && saved.snapshot && Array.isArray(saved.snapshot.models) && Array.isArray(saved.snapshot.connections)) {
          this.snapshot = saved.snapshot; this.base = saved.base; this.draft = saved.draft; for (const key of ['view', 'filter', 'search', 'open']) if (saved.ui?.[key] !== undefined) this[key] = saved.ui[key]; this.notice = 'manager.draftRestored';
          this.acceptCatalog(state);
        } else if (saved) this.notice = 'manager.loadedLatest';
      } catch { this.notice = 'manager.draftRestoreFailed'; }
    }
    try { this.widths = JSON.parse(sessionStorage.getItem('model-dock-demo-columns') || '{}'); } catch { this.widths = {}; }
  }
  acceptCatalog(state) {
    const next = config(state), additions = next.models.filter(model => !this.base.models.some(row => row.id === model.id));
    // Only metadata and new disabled models may advance a draft's revision.
    // Concurrent edits to saved application preferences still require review.
    const unchanged = this.snapshot.settingsRevision === state.settingsRevision && same(this.base.routes, next.routes)
      && this.base.models.every(model => same(model, next.models.find(row => row.id === model.id)))
      && additions.every(model => !model.enabled && !model.reasoningPolicy && !Object.keys(model.groupPolicies).length);
    this.snapshot = { ...state, revision: unchanged ? state.revision : this.snapshot.revision, settingsRevision: unchanged ? state.settingsRevision : this.snapshot.settingsRevision };
    this.base.models.push(...clone(additions)); this.draft.models.push(...clone(additions));
    if (unchanged) this.base = next;
    this.remember();
  }
  get dirtyCount() {
    if (!this.base || !this.draft) return 0;
    const changed = type => new Set([...this.base[type], ...this.draft[type]].map(row => row.id));
    return ['models', 'routes'].reduce((total, type) => total + [...changed(type)].filter(id => !same(this.base[type].find(row => row.id === id), this.draft[type].find(row => row.id === id))).length, 0);
  }
  model(id) { return this.snapshot.models.find(row => row.id === id); }
  form(id) { return this.draft.models.find(row => row.id === id); }
  usable(id) { const model = this.model(id); return Boolean(model && this.form(id)?.enabled && model.available !== false && this.snapshot.connections.some(connection => connection.id === model.connectionId && connection.enabled)); }
  levels(id) { return this.model(id)?.reasoningEfforts || []; }
  policy(id, group, routeId) {
    const form = this.form(id), model = this.model(id), levels = this.levels(id);
    const root = form.reasoningPolicy || { allowedEfforts: levels, defaultEffort: levels.includes(model.defaultEffort) ? model.defaultEffort : levels[0] };
    const parent = group && Object.hasOwn(form.groupPolicies, group) && form.groupPolicies[group] || root;
    return routeId ? this.draft.routes.find(route => route.id === routeId)?.reasoningOverrides?.[id] || parent : group ? parent : root;
  }
  remember() {
    try {
      if (this.dirtyCount) sessionStorage.setItem(storageKey, JSON.stringify({ revision: this.snapshot.revision, snapshot: { revision: this.snapshot.revision, settingsRevision: this.snapshot.settingsRevision, models: this.snapshot.models, connections: this.snapshot.connections }, base: this.base, draft: this.draft, ui: { view: this.view, filter: this.filter, search: this.search, open: this.open } }));
      else sessionStorage.removeItem(storageKey);
    } catch { this.failure = () => t('manager.draftStorageFailed'); }
  }
  changed() { this.notice = ''; this.failure = undefined; this.remember(); this.render(); }
  upsertRoute(route) {
    route = { ...route, id: route.id.trim(), name: route.name.trim(), group: route.group.trim() };
    if (!route.name) throw new Error(t('manager.featureNameRequired'));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(route.id)) throw new Error(t('manager.featureIdFormat'));
    const previous = this.draft.routes.find(item => item.id === route.id);
    const next = { modelId: '', allowedModelIds: [], reasoningOverrides: {}, ...previous, ...route };
    if (previous?.kind !== next.kind) next.allowedModelIds = next.allowedModelIds.filter(id => compatible(next, this.model(id)));
    if (next.selection === 'single' && next.allowedModelIds.length > 1) next.allowedModelIds = next.allowedModelIds.includes(next.modelId) ? [next.modelId] : [];
    if (previous?.group !== next.group) next.reasoningOverrides = {};
    if (previous) this.draft.routes[this.draft.routes.indexOf(previous)] = next; else this.draft.routes.push(next);
    this.changed();
  }
  removeRoute(id) { this.draft.routes = this.draft.routes.filter(route => route.id !== id); this.changed(); }
  groups() { return [...new Set(this.draft.routes.map(groupOf).filter(Boolean))].map(name => ({ name, routes: this.draft.routes.filter(route => groupOf(route) === name) })); }
  width(key) { const column = columns[this.view].find(row => row[0] === key); return Math.max(column[3], Math.min(1200, Number(this.widths[this.view]?.[key]) || column[2])); }
  setWidth(key, width, persist = true) {
    const column = columns[this.view].find(row => row[0] === key);
    (this.widths[this.view] ||= {})[key] = Math.max(column[3], Math.min(1200, Math.round(width)));
    const table = this.root.querySelector('.cm-table');
    table?.style.setProperty(`--cm-${key}`, `${this.width(key)}px`);
    this.root.querySelector(`[data-column="${key}"]`)?.setAttribute('aria-valuenow', this.width(key));
    if (persist) { try { sessionStorage.setItem('model-dock-demo-columns', JSON.stringify(this.widths)); } catch { this.notify(t('manager.columnStorageFailed'), true); } }
  }
  mount(root, state) {
    this.endResize?.(); this.listeners?.abort(); this.listeners = new window.AbortController();
    const on = (type, listener) => root.addEventListener(type, listener, { signal: this.listeners.signal });
    this.root = root; this.accept(state); this.render();
    on('click', event => { const control = event.target.closest('[data-mm]'); if (control && !control.disabled) void this.handle(control); });
    on('input', event => { if (event.target.id === 'model-search') { this.search = event.target.value; this.remember(); this.renderTable(); } });
    on('keydown', event => {
      const radio = event.target.closest('input[type="radio"][data-mm]');
      if (radio?.checked && !radio.disabled && event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) void this.handle(radio);
        return;
      }
      const handle = event.target.closest('[data-column]');
      if (!handle || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); const key = handle.dataset.column;
      this.setWidth(key, event.key === 'Home' ? columns[this.view].find(row => row[0] === key)[2] : this.width(key) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8));
    });
    on('dblclick', event => { const handle = event.target.closest('[data-column]'); if (handle) this.setWidth(handle.dataset.column, columns[this.view].find(row => row[0] === handle.dataset.column)[2]); });
    on('pointerdown', event => {
      const handle = event.target.closest('[data-column]'); if (!handle || event.button !== 0) return;
      event.preventDefault(); const key = handle.dataset.column, start = event.clientX, width = this.width(key);
      handle.setPointerCapture?.(event.pointerId); document.body.classList.add('cm-resizing');
      const move = next => this.setWidth(key, width + next.clientX - start, false);
      const end = () => { document.body.classList.remove('cm-resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); this.setWidth(key, this.width(key)); this.endResize = null; };
      this.endResize = end; window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    });
  }
  render() {
    if (!this.root?.isConnected) return;
    const scroll = this.root.querySelector('.cm-scroller')?.scrollLeft || 0;
    const focused = this.root.contains(document.activeElement) ? document.activeElement : null;
    const focus = focused && focusKey(focused);
    const dirty = this.dirtyCount, enabled = this.draft.models.filter(model => this.usable(model.id)).length;
    const conflict = dirty && this.latest.revision !== this.snapshot.revision;
    this.root.innerHTML = `<section class="cm-manager" aria-label="${t('manager.region')}" aria-busy="${this.busy}">
      <div class="cm-toolbar"><div class="cm-filters" role="group" aria-label="${t('common.modelTypeFilters')}">${[['all', t('common.all')], ['text', t('common.textUnderstanding')]].map(([key, label]) => `<button data-mm="filter" data-value="${key}" aria-pressed="${this.filter === key}">${label}</button>`).join('')}</div><div class="cm-actions"><div class="cm-segment" role="group" aria-label="${t('manager.views')}"><button data-mm="view" data-value="connections" data-model-view="connections" aria-pressed="${this.view === 'connections'}">${t('manager.byCredential')}</button><button data-mm="view" data-value="functions" data-model-view="functions" aria-pressed="${this.view === 'functions'}">${t('manager.byFeature')}</button></div><span class="cm-count">${t('common.enabledCount', enabled, this.draft.models.length)}</span><button class="cm-save ${dirty ? 'primary' : ''}" data-mm="save" ${!dirty || this.busy ? 'disabled' : ''}>${this.busy ? t('common.working') : dirty ? t('common.saveChangesCount', dirty) : t('common.saved')}</button></div></div>
      <div class="cm-secondary"><input id="model-search" data-focus="model-search" type="search" aria-label="${t('manager.searchLabel')}" placeholder="${t('manager.searchPlaceholder')}" value="${esc(this.search)}"><div class="cm-actions"><button class="cm-text" data-mm="revert" ${!dirty || this.busy ? 'disabled' : ''}>${t('common.discardChanges')}</button><button class="cm-text" data-mm="refresh" ${this.busy || this.latest.connection?.configured === false ? 'disabled' : ''}>${this.busy ? t('common.working') : t('common.refreshModels')}</button><button class="cm-text" data-action="add-route" ${this.busy ? 'disabled' : ''}>${t('manager.addFeature')}</button></div></div>
      ${this.error ? `<div class="cm-feedback error" role="alert">${esc(this.error)}</div>` : ''}${conflict ? `<div class="cm-feedback" role="status">${t('manager.settingsConflict')}</div>` : ''}${this.notice ? `<div class="cm-feedback" role="status">${esc(t(this.notice))}</div>` : ''}
      <div id="model-list"></div></section>`;
    this.renderTable();
    const scroller = this.root.querySelector('.cm-scroller'); if (scroller) scroller.scrollLeft = scroll;
    if (focus) [...this.root.querySelectorAll('[data-focus], [data-mm]')].find(node => focusKey(node) === focus)?.focus({ preventScroll: true });
  }
  header() {
    return `<div class="cm-header">${columns[this.view].map(([key, label, , min]) => `<span>${t(label)}<button type="button" class="cm-resizer" data-column="${key}" role="separator" aria-orientation="vertical" aria-label="${t('common.resizeColumn', t(label))}" aria-valuemin="${min}" aria-valuemax="1200" aria-valuenow="${this.width(key)}" title="${t('common.resizeColumnHelp')}"></button></span>`).join('')}<span>${this.view === 'connections' ? t('manager.availableFeatures') : t('common.effortsHeading')}</span></div>`;
  }
  renderTable() {
    const target = this.root.querySelector('#model-list');
    if (!target) return;
    const scroll = target.querySelector('.cm-scroller')?.scrollLeft || 0;
    const needle = this.search.trim().toLowerCase();
    const models = this.snapshot.models.filter(model => this.filter === 'all' || model.capabilities?.text !== false);
    const matches = values => values.join(' ').toLowerCase().includes(needle);
    const modelMatches = model => {
      const connection = this.source(model);
      return matches([model.name, model.id, model.nativeId, connection?.name, sourceLabels[connection?.type] && t(sourceLabels[connection.type])]);
    };
    const featureMatches = route => matches([route.name, featureName(route), route.id, route.group, groupName(route.group)]);
    const html = this.view === 'connections' ? this.credentialRows(models, modelMatches, featureMatches)
      : this.functionRows(models, modelMatches, featureMatches);
    if (!html) {
      const message = !models.length ? t('manager.emptyCatalog') : t('manager.noMatches');
      target.innerHTML = `<p class="cm-empty">${message}</p>`;
      return;
    }
    target.innerHTML = `<div class="cm-scroller" tabindex="0" role="region" aria-label="${t('manager.tableAria', this.view === 'connections' ? t('manager.byCredential') : t('manager.byFeature'))}">
      <div class="cm-table cm-${this.view}">${this.header()}${html}</div>
    </div>`;
    const table = target.querySelector('.cm-table');
    for (const [key] of columns[this.view]) table.style.setProperty(`--cm-${key}`, `${this.width(key)}px`);
    target.querySelectorAll('input[data-mixed="true"]').forEach(input => { input.indeterminate = true; });
    target.querySelector('.cm-scroller').scrollLeft = scroll;
  }

  source(model) {
    return this.snapshot.connections.find(connection => connection.id === model.connectionId);
  }

  credentialRows(models, modelMatches, featureMatches) {
    return this.snapshot.connections.map(connection => {
      const rows = models.filter(model => model.connectionId === connection.id).map(model => {
        const applicable = this.draft.routes.filter(route => relevant(route, model));
        const matching = modelMatches(model);
        const visible = matching ? applicable : applicable.filter(featureMatches);
        return { model, applicable, visible, matching };
      }).filter(({ matching, visible }) => matching || visible.length);
      if (!rows.length) return '';
      const all = this.snapshot.models.filter(model => model.connectionId === connection.id);
      const status = connection.status === 'error' ? 'error' : connection.enabled ? connection.status : 'disabled';
      const label = { connected: t('manager.catalogAvailable'), error: t('manager.catalogCheckFailed'), disabled: t('manager.catalogUnavailable') }[status] || t('common.notChecked');
      return `<section class="cm-provider-row" aria-label="${t('common.connectionModelsAria', esc(connection.name))}">
        <div class="cm-provider-info">
          <h2>${esc(connection.name)}</h2>
          <p>${esc(t(sourceLabels[connection.type]))}</p>
          <span class="cm-badge">${t('manager.authorizedCount', all.filter(model => model.available !== false).length, all.length)}</span>
          <div class="cm-runtime" data-status="${esc(status)}"><span aria-hidden="true"></span>${label}
            <button class="cm-status-refresh" data-mm="discover" data-id="${esc(connection.id)}" aria-label="${t('manager.refreshCatalogAria', esc(connection.name))}" ${this.busy ? 'disabled' : ''}>${refresh}</button>
          </div>
        </div>
        <div>${rows.map(({ model, applicable, visible }) => this.modelRow(model, applicable, visible)).join('')}</div>
      </section>`;
    }).join('');
  }

  modelRow(model, applicable, visible) {
    const enabled = this.usable(model.id), levels = this.levels(model.id), settings = this.policy(model.id);
    const form = this.form(model.id), tags = [];
    if (model.capabilities?.text === true) tags.push(t('common.textGeneration'));
    if (model.capabilities?.tools) tags.push(t('common.toolCalls'));
    if (model.capabilities?.structured) tags.push(t('common.structuredOutput'));
    if (levels.length || model.capabilities?.thinking) tags.push(t('common.deepReasoning'));
    if (model.capabilities?.text == null) tags.push(t('manager.capabilitiesUnverified'));
    const policies = [form.reasoningPolicy, ...Object.values(form.groupPolicies), ...this.draft.routes.map(route => route.reasoningOverrides?.[model.id])];
    const obsolete = policies.some(policy => policy && (!levels.includes(policy.defaultEffort) || policy.allowedEfforts.some(level => !levels.includes(level))));
    const groupRows = this.groups().map(group => {
      const shown = visible.filter(route => route.group === group.name && route.selection === 'multiple');
      if (!shown.length) return '';
      const complete = applicable.filter(route => route.group === group.name && route.selection === 'multiple').length === shown.length;
      return complete ? this.credentialGroup(model, { name: group.name, routes: shown })
        : `<div class="cm-feature-group"><p class="cm-match-group">${esc(groupName(group.name))}</p><div class="cm-children">${shown.map(route => this.association(model, route, true)).join('')}</div></div>`;
    }).join('');
    const standalone = visible.filter(route => !route.group || route.selection === 'single');
    return `<div class="cm-model-row" data-enabled="${enabled}" data-model-id="${esc(model.id)}">
      <div class="cm-model-info">
        <h3>${esc(model.name)}</h3>
        <div class="cm-capabilities">${tags.map(tag => `<span class="cm-badge">${tag}</span>`).join('')}</div>
        <div class="cm-limits">${model.contextWindow ? t('manager.contextTokens', number(model.contextWindow)) : t('manager.noContextLimit')}
          <button class="cm-info" data-mm="details" data-id="${esc(model.id)}" aria-label="${t('manager.detailsAria', esc(model.name))}" aria-haspopup="dialog">ⓘ</button>
        </div>
        ${levels.length ? `<span class="cm-caption">${t('common.allowedEfforts')}</span><div class="cm-levels" role="group" aria-label="${t('common.allowedEffortsAria', esc(model.name))}">
          ${levels.map(level => {
            const on = settings.allowedEfforts.includes(level);
            return `<button data-mm="model-effort" data-id="${esc(model.id)}" data-level="${esc(level)}" aria-pressed="${on}"
              ${this.busy || !enabled || on && settings.allowedEfforts.length === 1 ? 'disabled' : ''}>${esc(effortLabel(level) === level ? level : t('common.effortWithId', effortLabel(level), level))}</button>`;
          }).join('')}
        </div>` : ''}
        ${obsolete ? `<span class="cm-caption">${t('manager.resetReasoningHelp')}</span><button class="cm-text" data-mm="reset-reasoning" data-id="${esc(model.id)}" ${this.busy ? 'disabled' : ''}>${t('manager.resetReasoning')}</button>` : ''}
        <button class="cm-toggle" role="switch" aria-checked="${form.enabled}" aria-label="${t('manager.enableAria', esc(model.name))}" data-mm="toggle-model" data-action="toggle-model"
          data-id="${esc(model.id)}" ${this.busy || !form.enabled && (model.available === false || !this.source(model)?.enabled) ? 'disabled' : ''}>
          <span class="cm-track" aria-hidden="true"><span></span></span>${model.available === false ? t('manager.modelUnavailable') : form.enabled ? t('common.enabled') : t('common.disabled')}
        </button>
      </div>
      <div class="cm-associations">${groupRows}${standalone.map(route => this.association(model, route)).join('')}
        ${!visible.length ? `<p class="cm-empty">${t('manager.noFeatures')}</p>` : ''}
      </div>
    </div>`;
  }

  association(model, route, child = false) {
    const configured = selected(route, model.id) || route.reasoningOverrides?.[model.id];
    return `<div class="cm-association">
      <div class="cm-effort-cell">${configured ? this.effortPicker(model, route.group, route.id, !selected(route, model.id) || !compatible(route, model)) : '<span class="cm-muted">—</span>'}</div>
      <div class="cm-feature-cell ${child ? '' : 'cm-standalone'}">${this.routeChoice(model, route)}
        <button class="cm-text cm-edit" data-action="edit-route" data-id="${esc(route.id)}" aria-label="${t('manager.editFeatureAria', esc(featureName(route)))}" ${this.busy ? 'disabled' : ''}>${t('common.edit')}</button>
      </div>
    </div>`;
  }

  credentialGroup(model, group) {
    const key = `${model.id}:${group.name}`;
    const controls = `children-${encodeURIComponent(model.id)}:${encodeURIComponent(group.name)}`;
    const expanded = Boolean(this.open[key]);
    const { count, total, overrides } = this.groupSummary(model, group);
    return `<div class="cm-feature-group">
      <div class="cm-association">
        <div class="cm-effort-cell">${count ? this.effortPicker(model, group.name, null, false) : '<span class="cm-muted">—</span>'}</div>
        <div class="cm-feature-cell">
          <button class="cm-disclosure" data-mm="expand" data-value="${esc(key)}" aria-label="${t('manager.groupDisclosureAria', expanded ? t('manager.collapse') : t('manager.expand'), esc(model.name), esc(groupName(group.name)))}" aria-expanded="${expanded}" aria-controls="${controls}">${chevron}</button>
          ${this.groupCheck(model, group)}
          <button class="cm-text" data-mm="expand" data-value="${esc(key)}" data-focus="count:${esc(key)}" aria-expanded="${expanded}" aria-controls="${controls}">${t('manager.selectedSubfeatureCount', count, total)}</button>
          ${overrides ? `<span class="cm-badge">${t('manager.overrideCount', overrides)}</span>` : ''}
        </div>
      </div>
      <div class="cm-children" id="${controls}" ${expanded ? '' : 'hidden'}>${expanded ? group.routes.map(route => this.association(model, route, true)).join('') : ''}</div>
    </div>`;
  }

  groupSummary(model, group) {
    const compatibleRoutes = group.routes.filter(route => compatible(route, model));
    return {
      count: this.usable(model.id) ? compatibleRoutes.filter(route => selected(route, model.id)).length : 0,
      total: compatibleRoutes.length,
      overrides: group.routes.filter(route => route.reasoningOverrides?.[model.id]).length
    };
  }

  groupCheck(model, group, featureView = false) {
    const { count, total } = this.groupSummary(model, group);
    const mixed = count > 0 && count < total;
    const checked = total > 0 && count === total;
    return `<label class="cm-check">
      <input type="checkbox" data-mm="bind-group" data-id="${esc(model.id)}" data-group="${esc(group.name)}"
        ${checked ? 'checked' : ''} data-mixed="${mixed}" aria-checked="${mixed ? 'mixed' : checked}"
        aria-label="${t('manager.bindGroupAria', esc(model.name), esc(groupName(group.name)))}" ${this.busy || !this.usable(model.id) || !total ? 'disabled' : ''}>
      ${featureView ? `<span class="cm-model-label"><small>${esc(this.source(model)?.name)}</small><span>${esc(model.name)}</span></span>` : `<strong>${esc(groupName(group.name))}</strong>`}
    </label>`;
  }

  routeChoice(model, route, featureView = false) {
    const bound = selected(route, model.id), active = this.usable(model.id) && compatible(route, model);
    const single = route.selection === 'single', chosen = route.modelId === model.id;
    const input = `choice-${encodeURIComponent(model.id)}:${encodeURIComponent(route.id)}`;
    const attrs = `data-id="${esc(model.id)}" data-route="${esc(route.id)}"`;
    return `<div class="cm-choice">
      <input id="${input}" type="${single ? 'radio' : 'checkbox'}" ${single ? `name="model-${esc(route.id)}"` : ''} data-mm="bind-route" ${attrs}
        ${bound ? 'checked' : ''} aria-label="${t(single ? 'manager.useModelAria' : 'manager.allowModelAria', esc(featureName(route)), esc(model.name))}" ${this.busy || !active && !bound ? 'disabled' : ''}
        title="${single && bound ? t('manager.clearSelection') : t('manager.selectModel')}">
      <div class="cm-choice-info">
        ${featureView ? `<label for="${input}" class="cm-choice-source">${esc(this.source(model)?.name)}</label>` : ''}
        <div class="cm-choice-title">
          <label for="${input}" class="${featureView ? 'cm-model-name' : ''}">${esc(featureView ? model.name : featureName(route))}</label>
          ${single ? '' : `<button type="button" class="cm-pin cm-default-pin" data-mm="default" ${attrs} aria-pressed="${chosen}"
            aria-label="${t('manager.defaultModelAria', esc(featureName(route)), esc(model.name))}" title="${chosen ? t('manager.clearDefault') : t('manager.setDefaultModel')}"
            ${this.busy || !chosen && !(bound && active) ? 'disabled' : ''}>${pin}</button>`}
        </div>
        ${featureView ? '' : `<label for="${input}" class="cm-requirements">${t('manager.requirements', requirements(route))}</label>`}
      </div>
    </div>`;
  }

  functionRows(models, modelMatches, featureMatches) {
    const candidates = new Map();
    for (const route of this.draft.routes) {
      const matching = featureMatches(route);
      const rows = models.filter(model => relevant(route, model) && (matching || modelMatches(model)));
      if (rows.length || matching && this.filter === 'all') candidates.set(route.id, rows);
    }
    const standalone = this.draft.routes.filter(route => !route.group && candidates.has(route.id));
    const groups = this.groups().map(group => {
      const visible = group.routes.filter(route => candidates.has(route.id));
      if (!visible.length) return '';
      const rows = models.filter(model => visible.some(route => candidates.get(route.id).includes(model)));
      const partial = visible.length < group.routes.length || rows.some(model => visible.some(route => compatible(route, model) && !candidates.get(route.id).includes(model)));
      // Bulk selection only appears when its affected children are in the result.
      if (partial || visible.some(route => route.selection === 'single')) {
        return `<section class="cm-module" aria-label="${t('manager.groupFeaturesAria', esc(groupName(group.name)))}">
          <h2 class="cm-match-group">${esc(groupName(group.name))}</h2>${visible.map(route => this.featureRow(route, candidates.get(route.id), true)).join('')}
        </section>`;
      }
      return this.functionGroup({ name: group.name, routes: visible }, rows, candidates);
    }).join('');
    return groups + standalone.map(route => this.featureRow(route, candidates.get(route.id))).join('');
  }

  functionGroup(group, rows, candidates) {
    const key = `features:${group.name}`, controls = `feature-children-${encodeURIComponent(group.name)}`;
    const expanded = Boolean(this.open[key]);
    const summaries = rows.map(model => this.groupSummary(model, group));
    const count = summaries.filter(summary => summary.count > 0).length;
    const overrides = summaries.reduce((total, summary) => total + summary.overrides, 0);
    return `<section class="cm-module" aria-label="${t('manager.groupFeaturesAria', esc(groupName(group.name)))}">
      <div class="cm-function-row">
        <div class="cm-function-info">
          <button class="cm-function-title" data-mm="expand" data-value="${esc(key)}" aria-expanded="${expanded}" aria-controls="${controls}">
            ${chevron}<strong>${esc(groupName(group.name))}</strong>
          </button>
          <div class="cm-group-summary">
            <p>${t('manager.linkedModelCount', count)}</p>
            <button class="cm-text" data-mm="expand" data-value="${esc(key)}" data-focus="count:${esc(key)}" aria-expanded="${expanded}" aria-controls="${controls}">${t('manager.subfeatureCount', group.routes.length)}</button>
            ${overrides ? `<span class="cm-badge">${t('manager.overrideCount', overrides)}</span>` : ''}
          </div>
        </div>
        <div>${rows.length ? rows.map((model, index) => `<div class="cm-feature-model" data-enabled="${this.usable(model.id)}">
          <div class="cm-feature-model-cell">${this.groupCheck(model, group, true)}</div>
          <div class="cm-effort-cell">${summaries[index].count ? this.effortPicker(model, group.name, null, false) : '<span class="cm-muted">—</span>'}</div>
        </div>`).join('') : `<p class="cm-empty">${t('manager.noCompatibleModels')}</p>`}</div>
      </div>
      <div id="${controls}" ${expanded ? '' : 'hidden'}>${expanded ? group.routes.map(route => this.featureRow(route, candidates.get(route.id), true)).join('') : ''}</div>
    </section>`;
  }

  featureRow(route, models, child = false) {
    const bound = this.usable(route.modelId) && selected(route, route.modelId) && compatible(route, this.model(route.modelId));
    const count = route.allowedModelIds.filter(id => this.usable(id) && compatible(route, this.model(id))).length;
    return `<section class="cm-function-row ${child ? 'cm-child-function' : ''}" aria-label="${esc(featureName(route))}">
      <div class="cm-function-info">
        <h3>${esc(featureName(route))}</h3>
        <p class="cm-meta">${t('manager.featureModelCount', count, route.selection === 'single' ? t('manager.singleSelectionNote') : '')}</p>
        <p class="cm-requirements">${t('manager.requirements', requirements(route))}</p>
        ${!bound ? `<p class="cm-meta cm-warning">${route.modelId ? t('common.defaultModelUnavailable') : t('manager.noDefaultModel')}</p>` : ''}
        <div class="cm-actions">
          <button class="cm-text" data-action="edit-route" data-id="${esc(route.id)}" aria-label="${t('manager.editFeatureAria', esc(featureName(route)))}" ${this.busy ? 'disabled' : ''}>${t('common.edit')}</button>
          <button class="cm-text" data-action="delete-route" data-id="${esc(route.id)}" aria-label="${t('manager.deleteFeatureAria', esc(featureName(route)))}" ${this.busy ? 'disabled' : ''}>${t('manager.delete')}</button>
        </div>
      </div>
      <div>${models.length ? models.map(model => `<div class="cm-feature-model" data-enabled="${this.usable(model.id)}">
        <div class="cm-feature-model-cell">${this.routeChoice(model, route, true)}</div>
        <div class="cm-effort-cell">${selected(route, model.id) || route.reasoningOverrides?.[model.id]
          ? this.effortPicker(model, route.group, route.id, !selected(route, model.id) || !compatible(route, model)) : '<span class="cm-muted">—</span>'}</div>
      </div>`).join('') : `<p class="cm-empty">${t('manager.noCompatibleModels')}</p>`}</div>
    </section>`;
  }
  effortPicker(model, group, routeId, unbound) {
    const levels = this.levels(model.id);
    if (!levels.length) return `<span class="cm-muted" title="${t('manager.noUpstreamLevels')}">—</span>`;
    const settings = this.policy(model.id, group, routeId), available = this.policy(model.id, routeId ? group : null).allowedEfforts;
    const disabled = this.busy || !this.usable(model.id) || unbound;
    const label = `${model.name} · ${routeId ? this.draft.routes.find(row => row.id === routeId).name : group}`;
    const attrs = `data-id="${esc(model.id)}" data-group="${esc(group)}" ${routeId ? `data-route="${esc(routeId)}"` : ''}`;
    const override = routeId ? this.draft.routes.find(row => row.id === routeId).reasoningOverrides?.[model.id]
      : Object.hasOwn(this.form(model.id).groupPolicies, group) && this.form(model.id).groupPolicies[group];
    return `<div class="cm-efforts" role="group" aria-label="${t('manager.effortsAria', esc(label))}">${levels.map(level => {
      const on = settings.allowedEfforts.includes(level), pinned = settings.defaultEffort === level;
      return `<span class="cm-effort-option" data-allowed="${on}" data-unavailable="${disabled || !available.includes(level)}"><button class="cm-effort-toggle" data-mm="effort" ${attrs} data-level="${esc(level)}" data-focus="${esc(label + level)}" aria-label="${t('common.effortOptionAria', esc(label), esc(effortLabel(level)))}" aria-pressed="${on}" title="${on && settings.allowedEfforts.length === 1 ? t('manager.keepOneLevel') : on ? t('manager.disableEffort') : t('manager.enableEffort')}" ${disabled || !available.includes(level) || on && settings.allowedEfforts.length === 1 ? 'disabled' : ''}>${esc(effortLabel(level))}</button><button class="cm-pin cm-effort-pin" data-mm="pin" ${attrs} data-level="${esc(level)}" aria-label="${t('common.effortDefaultAria', esc(label), esc(effortLabel(level)))}" aria-pressed="${pinned}" title="${pinned ? t('common.defaultEffort') : t('manager.setDefaultEffort')}" ${disabled || !on || !available.includes(level) ? 'disabled' : ''}>${pin}</button></span>`;
    }).join('')}${override ? `<button class="cm-text" data-mm="inherit" ${attrs} ${this.busy ? 'disabled' : ''}>${t('manager.restoreInheritance')}</button>` : ''}</div>`;
  }
  updateEffort(data, pinOnly = false, modelOnly = false) {
    const model = this.form(data.id), current = clone(this.policy(data.id, modelOnly ? null : data.group, modelOnly ? null : data.route));
    const selected = current.allowedEfforts;
    if (pinOnly) current.defaultEffort = data.level;
    else if (selected.includes(data.level)) {
      if (selected.length === 1) return;
      current.allowedEfforts = selected.filter(level => level !== data.level);
      if (current.defaultEffort === data.level) current.defaultEffort = fallback(current.allowedEfforts, data.level);
    } else current.allowedEfforts = this.levels(data.id).filter(level => level === data.level || selected.includes(level));
    if (!current.allowedEfforts.includes(current.defaultEffort)) current.defaultEffort = fallback(current.allowedEfforts, current.defaultEffort);
    if (modelOnly) {
      model.reasoningPolicy = current;
      for (const [key, value] of Object.entries(model.groupPolicies)) model.groupPolicies[key] = narrowed(value, current.allowedEfforts);
    } else if (data.route) this.draft.routes.find(route => route.id === data.route).reasoningOverrides[data.id] = current;
    else model.groupPolicies = { ...model.groupPolicies, [data.group]: current };
    for (const route of this.draft.routes) {
      if (route.reasoningOverrides[data.id]) route.reasoningOverrides[data.id] = narrowed(route.reasoningOverrides[data.id], this.policy(data.id, groupOf(route)).allowedEfforts);
    }
    this.changed();
  }
  async handle(control) {
    const { mm, id, value, group, route } = control.dataset;
    if (this.busy && !['expand', 'view', 'filter'].includes(mm)) return;
    if (mm === 'view') { this.endResize?.(); this.view = value; this.remember(); this.render(); }
    if (mm === 'filter') { this.filter = value; this.remember(); this.render(); }
    if (mm === 'expand') { this.open[value] = !this.open[value]; this.remember(); this.render(); }
    if (mm === 'toggle-model') { this.form(id).enabled = !this.form(id).enabled; this.changed(); }
    if (mm === 'model-effort' || mm === 'effort' || mm === 'pin') this.updateEffort(control.dataset, mm === 'pin', mm === 'model-effort');
    if (mm === 'inherit') {
      if (route) delete this.draft.routes.find(item => item.id === route).reasoningOverrides[id];
      else delete this.form(id).groupPolicies[group];
      this.changed();
    }
    if (mm === 'default') { const feature = this.draft.routes.find(item => item.id === route); feature.modelId = feature.modelId === id ? '' : id; this.changed(); }
    if (mm === 'bind-route' || mm === 'bind-group') {
      const routes = mm === 'bind-route' ? this.draft.routes.filter(item => item.id === route) : this.draft.routes.filter(item => groupOf(item) === group && item.selection === 'multiple' && compatible(item, this.model(id)));
      const assign = !routes.every(item => selected(item, id));
      for (const item of routes) {
        if (assign) { item.allowedModelIds = item.selection === 'single' ? [id] : [...new Set([...item.allowedModelIds, id])]; if (item.selection === 'single') item.modelId = id; }
        else { item.allowedModelIds = item.allowedModelIds.filter(modelId => modelId !== id); if (item.selection === 'single') item.modelId = ''; }
      }
      this.changed();
    }
    if (mm === 'reset-reasoning') {
      this.form(id).reasoningPolicy = null; this.form(id).groupPolicies = {};
      for (const item of this.draft.routes) delete item.reasoningOverrides[id];
      this.changed();
    }
    if (mm === 'details') this.onDetails(this.model(id));
    if (mm === 'save') {
      this.busy = true; this.failure = undefined; this.render();
      try {
        const result = await this.api('/api/settings', { method: 'POST', body: { revision: this.snapshot.revision, ...this.draft } });
        this.accept(result.state, true); this.onState(result.state); this.remember(); this.notice = 'manager.settingsSaved'; this.notify(t(this.notice));
      } catch (error) { this.failure = () => t('manager.saveFailedWithDraft', errorText(error)); }
      finally { this.busy = false; this.render(); }
    }
    if (['revert', 'refresh', 'discover'].includes(mm)) {
      this.busy = true; this.failure = undefined; this.render();
      try {
        let next = await this.api('/api/state');
        // Always request current server metadata, including with a local draft.
        if (mm !== 'revert') {
          next = (await this.api('/api/refresh', { method: 'POST', body: { revision: next.revision } })).state;
        }
        this.accept(next, mm === 'revert'); this.onState(next); this.remember(); this.notice = mm === 'revert' ? 'manager.changesDiscarded' : this.dirtyCount ? 'manager.catalogUpdatedWithDraft' : 'manager.catalogUpdated';
      } catch (error) { this.failure = () => errorText(error); try { const next = await this.api('/api/state'); this.accept(next); this.onState(next); } catch {} }
      finally { this.busy = false; this.render(); }
    }
  }
  dispose() { this.listeners?.abort(); this.endResize?.(); window.removeEventListener('beforeunload', this.unload); }
}
