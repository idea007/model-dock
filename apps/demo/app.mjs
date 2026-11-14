import { ModelManager } from './models.mjs';
import { sse } from './events.mjs';
import { apiDocsPage } from './api-docs.mjs';
import * as imageOptions from './image-options.mjs';
import { LocalizedError, dateTime, errorText, initLanguage, language, languagePicker, number, requestMetadata, selectLanguage, t } from '../../packages/ui/i18n.mjs';
import { featureName, groupName } from '../../packages/ui/feature-labels.mjs';

const titleKey = 'client.documentTitle';
initLanguage(titleKey);
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const kinds = { chat: 'feature.chat', extract: 'feature.extract', summarize: 'feature.summarize', rewrite: 'feature.rewrite', translate: 'feature.translate', explain: 'feature.explain', review: 'feature.review' };
const examples = { chat: 'example.chat', extract: 'example.extract', summarize: 'example.summarize', rewrite: 'example.rewrite', translate: 'example.translate', explain: 'const unique = values => [...new Set(values)];', review: 'async function loadProfile(id) {\n  return fetch(`/users/${id}`).then(res => res.json());\n}' };
const navigation = [
  ['settings', 'client.settings', '⚙'],
  ['models', 'client.models', '◈'],
  ['api', 'common.apiDocs', '▤'],
  ['experience', 'client.experience', '▷']
];
const currentView = () => navigation.find(([id]) => id === new URLSearchParams(location.search).get('view'))?.[0] || 'experience';
let token = '', state, view = currentView();
let expandedApiEndpoints = new Set();
let featureId = 'chat', chosenModel = '', prompt = '', promptFeature = '', promptEdited = false;
let generation, toastTimer, busy = false, startupFailure, connectionFailure, runResponse;
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
sessionStorage.removeItem('model-dock-demo-token');
const listeners = new window.AbortController();
const on = (target, event, handler) => target.addEventListener(event, handler, { signal: listeners.signal });
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}, retry = true) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (response.status === 401 && data.error?.code === 'local_session_required' && retry) { await session(); return api(url, options, false); }
  if (!response.ok) {
    const error = data.error?.message ? new Error(data.error.message) : new LocalizedError('common.requestFailedStatus', response.status);
    error.code = data.error?.code;
    throw error;
  }
  return data;
}
async function session() { token = (await api('/api/session', { method: 'POST', headers: { 'x-model-dock-client': '1' } }, false)).session; }
const manager = new ModelManager({ api, onState: next => { state = next; updateConnectionStatus(); }, notify: toast, onDetails: model => dialog(model.name, t('client.modelDetailsHelp'), `<dl class="cm-details"><dt>${t('common.modelId')}</dt><dd>${esc(model.id)}</dd><dt>${t('client.modelSource')}</dt><dd>${esc(model.source?.name)}</dd><dt>${t('client.contextLimit')}</dt><dd>${model.contextWindow ? number(model.contextWindow) + ' tokens' : t('client.undeclared')}</dd><dt>${t('client.reasoningLevel')}</dt><dd>${esc(model.reasoningEfforts.join(' / ') || t('client.undeclared'))}</dd></dl>`, t('common.close'), async () => $('#dialog').close()) });
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : null;
const usable = model => model?.enabled && model.available !== false && !state.connection.error;
const compatible = (feature, model) => model?.capabilities?.text !== false && (feature.kind !== 'extract' || model?.capabilities?.structured !== false);
const candidates = feature => state.models.filter(model => usable(model) && feature.allowedModelIds.includes(model.id) && compatible(feature, model));
const selectedFeature = () => state?.routes.find(feature => feature.id === featureId) || state?.routes[0];
async function load() {
  startupFailure = undefined;
  $('#app').innerHTML = `<div class="loading" role="status">${t('client.loading')}</div>`;
  try { await session(); state = await api('/api/state'); manager.accept(state); render(); if (state.connection.configured) await refreshModels(false); }
  catch (error) { startupFailure = error; showStartupError(); }
}
function showStartupError() {
  $('#app').innerHTML = `<main class="startup-error"><h1>${t('client.startupError')}</h1><p class="form-error" role="alert">${esc(errorText(startupFailure))}</p><button class="primary" data-action="retry">${t('client.reconnect')}</button>${languagePicker()}</main>`;
}
function connectionFields() {
  return `<label>${t('client.serverApiUrl')}<input name="baseUrl" type="url" value="${esc(state.connection.baseUrl)}" placeholder="http://127.0.0.1:4317/v1" autocomplete="url" required></label><label>${t('client.serverProjectKey')}<input name="apiKey" type="password" placeholder="${t('client.enterProjectKey')}" autocomplete="off" spellcheck="false" required><small>${t('client.projectKeyHelp')}</small></label>`;
}
function connectionPanel() {
  return `<section class="connect-panel" aria-labelledby="connect-title">
    <div><span class="eyebrow">${t('client.connectEyebrow')}</span><h2 id="connect-title">${t('client.serverConnection')}</h2><p>${state.connection.configured ? t('client.savedKeyHelp') : t('client.connectHelp')}</p></div>
    <form id="connection-form">
      <div class="form-grid">${connectionFields()}</div>
      <div class="connection-actions"><small>${t('client.keyStorageHelp')}</small><button type="submit" class="primary">${t('client.connectAndLoad')}</button></div>
      <div class="form-error" role="alert">${connectionFailure ? esc(errorText(connectionFailure)) : ''}</div>
    </form>
  </section>`;
}
function catalogSummary() {
  const count = state.models.filter(model => model.available !== false).length;
  const time = state.connection.refreshedAt ? dateTime(state.connection.refreshedAt) : t('client.notSynced');
  return `<div><dt>${t('client.authorizedAvailableModels')}</dt><dd>${t('client.modelCount', number(count))}</dd></div><div><dt>${t('client.lastSync')}</dt><dd>${esc(time)}</dd></div>`;
}
function settings() {
  return `<div class="connection-settings">${connectionPanel()}<section class="catalog-panel" aria-labelledby="catalog-title"><h2 id="catalog-title">${t('client.authorizedCatalog')}</h2><p>${t('client.syncHelp')}</p><dl id="catalog-summary" class="catalog-summary">${catalogSummary()}</dl><div class="row wrap"><button class="primary" data-action="refresh-models" ${!state.connection.configured ? 'disabled' : ''}>${t('common.refreshModels')}</button><button data-view="models">${t('client.viewModels')}</button></div></section></div>`;
}
function connectionStatus() { return state.connection.error ? t('common.connectionIssue') : state.connection.configured ? t('client.connected') : t('client.disconnected'); }
function updateConnectionStatus() {
  for (const node of document.querySelectorAll('[data-connection-status]')) {
    node.textContent = connectionStatus();
    node.classList.toggle('error', Boolean(state.connection.error)); node.classList.toggle('pending', !state.connection.configured);
  }
  const error = $('#connection-error');
  if (error) { error.textContent = state.connection.error ? errorText(state.connection.error) : ''; error.hidden = !state.connection.error; }
  if ($('#catalog-summary')) $('#catalog-summary').innerHTML = catalogSummary();
  for (const button of document.querySelectorAll('[data-action="refresh-models"]')) { button.disabled = busy || !state.connection.configured; button.textContent = busy ? t('common.refreshing') : t('common.refreshModels'); }
}
async function refreshModels(notify = true) {
  if (busy || manager.busy || generation) return;
  busy = true; updateConnectionStatus();
  try { await manager.handle({ dataset: { mm: 'refresh' } }); }
  finally { busy = false; if (view === 'settings') updateConnectionStatus(); else render(); }
  if (notify) toast(manager.error || t(manager.notice), Boolean(manager.error));
}
function pageContent(status) {
  const { baseUrl, configured, error } = state.connection;
  if (view === 'api') {
    return apiDocsPage({
      baseUrl,
      models: configured ? state.models.filter(model => model.available !== false) : [],
      version: state.version,
      expanded: expandedApiEndpoints,
      client: true
    }, imageOptions);
  }
  const title = view === 'experience' ? t('client.experienceTitle') : t(navigation.find(([id]) => id === view)[1]);
  const description = { experience: t('client.experienceHelp'), settings: t('client.settingsHelp') }[view];
  return `<div class="between demo-heading ${view === 'models' ? 'models-heading' : ''}">
    <div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div>
    <div class="row connection-status">
      <span data-connection-status class="mode-badge ${error ? 'error' : !configured ? 'pending' : ''}">${status}</span>
      ${view === 'experience' && configured ? `<button data-action="refresh-models">${t('common.refreshModels')}</button>` : ''}
    </div>
  </div>
  <div id="connection-error" class="cm-feedback error" role="alert" ${!error ? 'hidden' : ''}>${esc(error ? errorText(error) : '')}</div>
  ${!configured && view !== 'settings' ? `<div class="connect-banner"><p>${t('client.connectBanner')}</p><button data-view="settings">${t('client.goToSettings')}</button></div>` : ''}
  ${view === 'settings' ? settings() : view === 'models' ? '<div id="model-manager"></div>' : experience()}`;
}
function render() {
  if (!state) return;
  const endpoints = $('.api-endpoints');
  if (endpoints) {
    expandedApiEndpoints = new Set([...endpoints.querySelectorAll('details[open]')].map(detail => detail.dataset.apiId));
  }
  const status = connectionStatus();
  $('#app').innerHTML = `<div class="shell reference-layout demo-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">M</span>Model Dock</div>
      <div class="sidebar-sub">${t('client.sidebarSubtitle')}</div>
      <div class="nav-label">${t('client.applicationNav')}</div>
      <nav class="nav" aria-label="${t('client.navigation')}">${navigation.map(([id, label, icon]) => `<button data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}><span class="nav-symbol" aria-hidden="true">${icon}</span><span>${t(label)}</span></button>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="sidebar-status"><p data-connection-status>${status}</p></div>${languagePicker()}</div>
    </aside>
    <main class="page">${pageContent(status)}</main>
  </div>`;
  if (view === 'models') manager.mount($('#model-manager'), state);
}
function changeLanguage(next) {
  if (next === language()) return;
  if (generation) { toast(t('common.waitForRequest')); return; }
  if (busy || manager.busy || $('#dialog').open) { toast(t('common.busy')); return; }

  const connectionForm = $('#connection-form');
  const connectionDraft = connectionForm && {
    baseUrl: connectionForm.elements.baseUrl.value,
    apiKey: connectionForm.elements.apiKey.value
  };
  const runForm = $('#run-form');
  const runDraft = runForm && {
    reasoningEffort: runForm.elements.reasoningEffort.value,
    stream: runForm.elements.stream.checked
  };
  const resultScroll = $('#response-output')?.scrollTop || 0;
  const modelScroll = $('.cm-scroller')?.scrollLeft || 0;
  selectLanguage(next, titleKey);
  if (!promptEdited) prompt = t(examples[selectedFeature()?.kind] || '');
  clearTimeout(toastTimer);
  $('#toast').className = '';
  if (startupFailure) showStartupError();
  else render();
  if (connectionDraft) {
    const { elements } = $('#connection-form');
    elements.baseUrl.value = connectionDraft.baseUrl;
    elements.apiKey.value = connectionDraft.apiKey;
  }
  if (runDraft) {
    const { elements } = $('#run-form');
    elements.reasoningEffort.value = runDraft.reasoningEffort;
    elements.stream.checked = runDraft.stream;
    if (runResponse) {
      showRunResponse(runResponse);
      $('#response-output').scrollTop = resultScroll;
    }
  }
  const scroller = $('.cm-scroller');
  if (scroller) scroller.scrollLeft = modelScroll;
  $(`[data-language="${next}"]`)?.focus({ preventScroll: true });
}
function featureCard(feature) {
  const model = state.models.find(model => model.id === feature.modelId), ready = candidates(feature).some(item => item.id === feature.modelId);
  return `<button class="feature-card ${selectedFeature()?.id === feature.id ? 'active' : ''}" data-action="feature" data-id="${esc(feature.id)}" aria-pressed="${selectedFeature()?.id === feature.id}"><div class="between"><strong>${esc(featureName(feature))}</strong><span>${feature.selection === 'single' ? t('client.singleModel') : t('client.multipleModels')}</span></div><small>${ready ? esc(model.name) : feature.modelId ? t('common.defaultModelUnavailable') : t('client.chooseDefaultModel')}</small></button>`;
}
function experience() {
  const feature = selectedFeature(); if (!feature) return `<div class="empty"><h2>${t('client.noFeatures')}</h2><button data-view="models">${t('client.addFeature')}</button></div>`;
  featureId = feature.id;
  if (promptFeature !== feature.id) {
    prompt = t(examples[feature.kind] || ''); promptEdited = false; promptFeature = feature.id; chosenModel = '';
  }
  const available = candidates(feature), defaultModel = state.models.find(model => model.id === feature.modelId);
  const selectedId = chosenModel || feature.modelId;
  const model = available.find(row => row.id === selectedId);
  const prefs = model?.reasoningPolicy, group = own(model?.groupPolicies, feature.group), override = own(feature.reasoningOverrides, selectedId);
  const policy = override || group || prefs;
  const levels = policy?.allowedEfforts || model?.reasoningEfforts || [];
  const defaultLevel = policy?.defaultEffort || model?.defaultEffort || '';
  const groups = [...new Set(state.routes.map(row => row.group).filter(Boolean))];
  return `<div class="experience-layout"><section class="feature-menu" aria-label="${t('client.appFeatures')}"><h2>${t('client.standaloneFeatures')}</h2>${state.routes.filter(row => !row.group).map(featureCard).join('')}${groups.map(group => `<h2>${esc(groupName(group))} <small>${t('client.featureGroup')}</small></h2>${state.routes.filter(row => row.group === group).map(featureCard).join('')}`).join('')}</section><section class="run-panel"><div class="run-title"><div><span class="eyebrow">${esc(feature.group ? groupName(feature.group) : t('client.standaloneFeatures'))}</span><h2>${esc(featureName(feature))}</h2></div><button class="quiet small-button" data-view="models">${t('client.configureModels')}</button></div><form id="run-form" class="stack"><div class="form-grid"><label>${t('client.chooseModel')}<select name="modelId"><option value="">${t('client.defaultModel', esc(defaultModel?.name || t('client.notSelected')), !available.some(row => row.id === feature.modelId) ? t('client.modelUnavailableSuffix') : '')}</option>${available.map(row => `<option value="${esc(row.id)}" ${chosenModel === row.id ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}</select></label><label>${t('client.reasoningLevel')}<select name="reasoningEffort" ${!levels.length ? 'disabled' : ''}><option value="">${levels.length ? defaultLevel ? t('client.defaultValue', esc(defaultLevel)) : t('client.defaultOption') : t('client.reasoningUnavailable')}</option>${levels.map(level => `<option value="${esc(level)}">${esc(level)}</option>`).join('')}</select></label></div>${!model ? `<p class="selection-warning" role="status">${t('client.chooseAvailableCandidate')}</p>` : ''}<label>${t('client.prompt')}<textarea name="prompt" rows="6" required maxlength="20000">${esc(prompt)}</textarea></label><div class="between"><label class="checkbox-label"><input name="stream" type="checkbox" checked>${t('common.streamOutput')}</label><div class="row"><button type="button" data-action="stop" id="stop-button" disabled>${t('common.stop')}</button><button class="primary" id="run-button" ${!model ? 'disabled' : ''}>${t('client.runFeature')}</button></div></div></form><div class="result-heading between"><h3>${t('client.runResult')}</h3><span class="tag" id="response-status">${t('client.awaitingInput')}</span></div><div class="response empty-output" id="response-output" role="log" aria-live="polite">${t('client.resultPlaceholder')}</div><p id="response-meta" class="output-meta">${t('client.requestQuotaHelp')}</p></section></div>`;
}
function dialog(title, description, fields, label, callback) {
  $('#dialog').innerHTML = `<div class="modal-heading"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><form id="modal-form" class="modal-form">${fields}<div class="form-error" id="modal-error" role="alert"></div><div class="modal-actions"><button type="button" data-action="close-dialog">${t('common.cancel')}</button><button type="submit" class="primary">${esc(label)}</button></div></form>`;
  $('#modal-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; busy = true;
    try { await callback(new FormData(event.target)); } catch (error) { if ($('#modal-error')) $('#modal-error').textContent = errorText(error); }
    finally { button.disabled = false; busy = false; }
  });
  if (!$('#dialog').open) $('#dialog').showModal();
}
async function connect(form) {
  if (manager.dirtyCount) throw new LocalizedError('client.saveOrDiscardFirst');
  const result = await api('/api/connection', { method: 'POST', body: { revision: state.revision, baseUrl: form.get('baseUrl').trim(), apiKey: form.get('apiKey').trim() } });
  state = result.state; manager.accept(state, true);
  render(); toast(t('client.connectionSaved'));
}
function featureDialog(existing) {
  const name = existing ? featureName(existing) : '';
  const groups = manager.groups().map(group => group.name);
  const groupLabel = value => groups.includes(groupName(value)) ? value : groupName(value);
  const groupOptions = new Map(groups.map(value => [groupLabel(value), value]));
  const fields = `
    <label>${t('client.featureName')}<input name="name" required maxlength="100" value="${esc(name)}"></label>
    <label>${t('client.featureId')}<input name="id" required maxlength="80" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9._]|-)*" value="${esc(existing?.id || '')}" ${existing ? 'readonly' : ''} placeholder="${t('client.featureIdExample')}"></label>
    <label>${t('client.behaviorTemplate')}<select name="kind">
      ${Object.entries(kinds).map(([id, label]) => `<option value="${id}" ${existing?.kind === id ? 'selected' : ''}>${t(label)}</option>`).join('')}
    </select></label>
    <div class="form-grid">
      <label>${t('client.featureGroup')}<input name="group" value="${esc(groupLabel(existing?.group || ''))}" placeholder="${t('client.standaloneGroupPlaceholder')}" maxlength="80" list="feature-groups">
        <datalist id="feature-groups">${[...groupOptions.keys()].map(label => `<option value="${esc(label)}"></option>`).join('')}</datalist>
      </label>
      <label>${t('client.modelSelection')}<select name="selection">
        <option value="single" ${existing?.selection !== 'multiple' ? 'selected' : ''}>${t('client.useSingleModel')}</option>
        <option value="multiple" ${existing?.selection === 'multiple' ? 'selected' : ''}>${t('client.useMultipleModels')}</option>
      </select></label>
    </div>`;
  dialog(existing ? t('client.editAppFeature') : t('client.addAppFeature'), t('client.editFeatureHelp'), fields, t('client.addToDraft'), async form => {
    const next = Object.fromEntries(form);
    if (!existing && manager.draft.routes.some(row => row.id === next.id.trim())) throw new Error(t('client.duplicateFeature'));
    if (existing && next.name.trim() === name) next.name = existing.name;
    next.group = groupOptions.get(next.group.trim()) ?? next.group;
    manager.upsertRoute(next); $('#dialog').close(); toast(t('client.featureAddedToDraft'));
  });
}
async function run(form) {
  if (generation) return;
  const fields = new FormData(form), controller = new AbortController(); generation = controller;
  const streaming = fields.has('stream'), output = $('#response-output'), started = performance.now();
  let content = '', usage, failure, status = 'common.completed', ended = false;
  // Lock controls for the duration so a result always belongs to the displayed feature/model.
  form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; }); $('#stop-button').disabled = false;
  $('#response-status').textContent = t('client.running'); output.textContent = ''; output.classList.remove('empty-output');
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ featureId, prompt: fields.get('prompt'), modelId: fields.get('modelId'), reasoningEffort: fields.get('reasoningEffort') || '', stream: streaming }) });
    if (!response.ok) { const data = await response.json(); throw data.error || new LocalizedError('client.runFailed'); }
    if (streaming) {
      for await (const raw of sse(response.body)) {
        if (raw === '[DONE]') { ended = true; break; }
        const chunk = JSON.parse(raw); if (chunk.error) throw chunk.error;
        content += chunk.choices?.[0]?.delta?.content || ''; output.textContent = content; if (chunk.usage) usage = chunk.usage;
      }
      if (!ended) throw new LocalizedError('common.streamIncomplete');
    } else { const data = await response.json(); content = data.choices?.[0]?.message?.content || ''; usage = data.usage; }
  } catch (error) {
    status = controller.signal.aborted ? 'common.stopped' : 'common.failed';
    if (!controller.signal.aborted) failure = error;
  }
  finally {
    generation = null; form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = false; }); $('#stop-button').disabled = true;
    if (form.elements.reasoningEffort.options.length === 1) form.elements.reasoningEffort.disabled = true;
    runResponse = { content, failure, status, usage, seconds: (performance.now() - started) / 1000 };
    showRunResponse(runResponse);
  }
}
function showRunResponse(response) {
  const { content, failure, status } = response;
  const output = $('#response-output');
  output.classList.remove('empty-output');
  output.textContent = failure ? [content, errorText(failure)].filter(Boolean).join('\n\n') : content;
  $('#response-status').textContent = t(status);
  $('#response-meta').textContent = requestMetadata(response);
}
on(document, 'submit', async event => {
  if (event.target.id === 'connection-form') {
    event.preventDefault(); if (busy) return;
    const form = event.target, button = event.submitter, error = form.querySelector('.form-error');
    busy = true; button.disabled = true; button.textContent = t('client.connecting');
    connectionFailure = undefined; error.textContent = '';
    try { await connect(new FormData(form)); } catch (failure) { connectionFailure = failure; error.textContent = errorText(failure); }
    finally { busy = false; button.disabled = false; button.textContent = t('client.connectAndLoad'); }
  } else if (event.target.id === 'run-form') { event.preventDefault(); void run(event.target); }
});
on(document, 'input', event => {
  if (event.target.matches('#run-form [name="prompt"]')) { prompt = event.target.value; promptEdited = true; }
});
on(document, 'change', event => { if (event.target.name === 'modelId' && event.target.closest('#run-form')) { chosenModel = event.target.value; runResponse = undefined; render(); } });
on(document, 'click', async event => {
  if (event.target.closest('[data-mm]')) return;
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.language) { changeLanguage(button.dataset.language); return; }
  const { action, id } = button.dataset;
  if (action === 'copy-endpoint' || action === 'copy-api-example') {
    const copyingAddress = action === 'copy-endpoint';
    const value = copyingAddress ? state.connection.baseUrl : document.getElementById(button.dataset.codeId).textContent;
    try {
      await navigator.clipboard.writeText(value);
      toast(copyingAddress ? t('common.addressCopied') : t('common.apiExampleCopied'));
    } catch { toast(t('client.copyFailed'), true); }
    return;
  }
  if (generation && action !== 'stop') { toast(t('common.waitForRequest')); return; }
  if ((busy || manager.busy) && action !== 'stop') return;
  if (button.dataset.view) {
    runResponse = connectionFailure = undefined;
    view = button.dataset.view;
    history.pushState(null, '', `?view=${view}`);
    render();
    return;
  }
  if (action === 'refresh-models') void refreshModels();
  if (action === 'feature') { featureId = id; runResponse = undefined; render(); }
  if (action === 'close-dialog') $('#dialog').close();
  if (action === 'add-route') featureDialog();
  if (action === 'edit-route') featureDialog(manager.draft.routes.find(row => row.id === id));
  if (action === 'delete-route') dialog(t('client.deleteAppFeature'), t('client.deleteFeatureHelp'), '', t('client.deleteFeature'), async () => { manager.removeRoute(id); $('#dialog').close(); });
  if (action === 'stop') generation?.abort();
  if (action === 'retry') void load();
});
on($('#dialog'), 'close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
on(window, 'popstate', () => { if (generation) return; runResponse = connectionFailure = undefined; view = currentView(); render(); });
await load();
export function dispose() { generation?.abort(); listeners.abort(); manager.dispose(); clearTimeout(toastTimer); }
