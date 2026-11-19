import { sse } from './events.mjs';
import { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes, maxImageRequestBytes, maxImageResultBytes, maxInferenceRequestBytes } from './image-options.mjs';
import { apiDocsPage } from './api-docs.mjs';
import { generateMedia, mediaExample, mediaFields, playgroundMode, playgroundModes, playgroundNeedsBinding, updateMediaFields, videoStatus } from './playground-media.mjs';
import { money, UsageWorkspace } from './usage.mjs';
import { LocalizedError, dateTime, duration, errorText, initLanguage, language, languagePicker, languageSeparator, number, requestMetadata, selectLanguage, t } from '../../packages/ui/i18n.mjs';

const titleKey = 'console.documentTitle';
initLanguage(titleKey);

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const imageModel = model => model?.capability === 'image_generation';
const playDrafts = new WeakMap();
let lastPlayMode, lastPlayVideo, playMediaUrl;
const imageRatioLabels = { '16:9': 'console.ratioLandscape', '9:16': 'console.ratioPortrait', '1:1': 'console.ratioSquare', '4:5': 'console.ratioPortraitFourFive' };
const referenceFormats = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
const icons = {
  dock: '<path d="M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  models: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  docs: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-5-5 3-3m-1 5 3-3"/>',
  usage: '<path d="M4 20h16M7 16v-5m5 5V5m5 11V9"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  down: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  terminal: '<path d="m5 6 5 6-5 6m8 0h6"/>',
  sliders: '<path d="M3 7h9m5 0h4M3 17h4m5 0h9"/><circle cx="14.5" cy="7" r="2.5"/><circle cx="9.5" cy="17" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>',
  cycle: '<path d="M22 4v6h-6M2 20v-6h6M22 10A10 10 0 0 0 3 7M2 14a10 10 0 0 0 19 3"/>',
  pin: '<path d="m16 3 5 5-4 1-4 4 1 3-2 2-6-6 2-2 3 1 4-4zM8 16l-5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11z"/>',
  computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.dock}</svg>`;
const providerTypes = {
  openai: { name: 'common.modelApi', icon: 'cloud', description: 'console.modelApiProviderHelp', addLabel: 'console.addApiCredential' },
  local: { name: 'console.localServices', icon: 'computer', description: 'console.localServicesHelp', addLabel: 'console.addLocalServiceConnection' },
  ollama: { name: 'Ollama', icon: 'computer', description: 'console.ollamaProviderHelp', addLabel: 'console.addOllama', defaultName: 'common.localOllama', baseUrl: 'http://127.0.0.1:11434', baseHelp: 'console.ollamaBaseUrlHelp' },
  codex: { name: 'Codex', icon: 'terminal', description: 'console.codexProviderHelp', addLabel: 'console.addCodex', defaultName: 'common.localCodex', baseUrl: '', concurrencyLimit: 16 },
  mflux: { name: 'MFLUX', concurrencyLimit: 4 },
  service: { name: 'console.providerService' }
};
const connectionGroups = ['openai', 'local', 'ollama', 'codex'];
const usesApiCredential = connection => ['openai', 'service', 'mflux'].includes(connection.type);
const isApiEndpointGroup = id => id === 'openai' || id === 'local';
function isLocalEndpoint(address) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname); }
  catch { return false; }
}
function providerType(id) {
  const provider = providerTypes[id];
  return provider && {
    ...provider,
    name: t(provider.name),
    defaultName: t(provider.defaultName)
  };
}
const views = { connections: ['console.connections', 'plug'], models: ['console.models', 'models'], api: ['common.apiDocs', 'docs'], playground: ['console.playground', 'play'], keys: ['console.projectAccess', 'key'], usage: ['usage.title', 'usage'] };
const expandedApiEndpoints = new Set();
const usage = new UsageWorkspace({ api, escape, notify: toast,
  editPrice: id => {
    if (busy || catalogRefresh) return toast(t('common.busy'));
    usagePriceDialog(state.models.find(model => model.id === id));
  } });
const apiImageOptions = { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes, maxImageRequestBytes, maxImageResultBytes, maxInferenceRequestBytes };
const settingsKey = 'model-dock-publication-draft';
const storedSessionKey = 'model-dock-console-session';
const manualTokenKey = 'model-dock-token';
let settingsDraft, settingsError = '';
let catalogRefresh, catalogNotice = '';
const catalogColumns = [
  { key: 'provider', label: 'common.credentialService', width: 152, min: 120 },
  { key: 'model', label: 'common.model', width: 256, min: 180 },
  { key: 'effort', label: 'common.effortsHeading', width: 320, min: 180 }
];
const catalogWidths = {};
const catalogWidthsKey = 'model-dock-catalog-columns';
try {
  const stored = JSON.parse(localStorage.getItem(catalogWidthsKey) || sessionStorage.getItem(catalogWidthsKey) || '{}');
  for (const column of catalogColumns) {
    if (Number.isFinite(stored?.[column.key])) catalogWidths[column.key] = catalogWidth(column, stored[column.key]);
  }
} catch {}
let state, view = new URLSearchParams(location.search).get('view') || 'connections', busy = false, generation, toastTimer;
if (!views[view]) view = 'connections';
let manualToken = sessionStorage.getItem(manualTokenKey) || '';
let consoleSession = readConsoleSession();
let token = manualToken || consoleSession;
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('session') || fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
if (fragment.has('token') && !fragment.has('session')) {
  manualToken = fragment.get('token');
  if (token !== manualToken) sessionStorage.removeItem(settingsKey);
  token = manualToken;
  sessionStorage.setItem(manualTokenKey, manualToken);
}
try {
  const saved = JSON.parse(sessionStorage.getItem(settingsKey) || 'null');
  if (Number.isSafeInteger(saved?.revision) && Array.isArray(saved.changes)) {
    const changes = new Map();
    for (const [id, value] of saved.changes.filter(Array.isArray)) {
      if (typeof id !== 'string') continue;
      const patch = {};
      if (typeof value === 'boolean') patch.enabled = value;
      if (typeof value?.enabled === 'boolean') patch.enabled = value.enabled;
      const policy = value?.reasoningPolicy;
      if (policy === null || validEffortList(policy?.allowedEfforts) && typeof policy.defaultEffort === 'string'
        && (policy.openEfforts === undefined || validEffortList(policy.openEfforts))) {
        patch.reasoningPolicy = policy;
      }
      if (Object.keys(patch).length) changes.set(id, patch);
    }
    if (changes.size) settingsDraft = { revision: saved.revision, changes };
  }
} catch { sessionStorage.removeItem(settingsKey); }
const usable = model => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);
const usableModels = () => state.models.filter(usable);
const callableModels = () => [...usableModels(), ...(state.pools || []).filter(pool => pool.enabled && pool.members.some(member => member.available))];
const modelById = id => state.models.find(model => model.id === id) || state.pools?.find(pool => pool.id === id);
const availableChoices = () => callableModels().map(model => {
  const connection = state.connections.find(item => item.id === model.connectionId);
  const source = model.members ? t('pools.source') : connection?.name;
  return {
    id: model.id, name: source && source !== model.name ? `${model.name} · ${source}` : model.name,
    mode: playgroundMode(model), service: model.service,
    requiresBinding: playgroundNeedsBinding(model, connection?.upstreamModel)
  };
});
const modelLabel = id => modelById(id)?.name || id;
const timestamp = value => value ? dateTime(value) : t('common.notChecked');
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}, raw = false) {
  const requestToken = token;
  const multipart = options.body instanceof FormData;
  const jsonBody = options.body && !multipart;
  const response = await fetch(url, { ...options, headers: { ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}),
    ...(jsonBody && { 'content-type': 'application/json' }), ...options.headers },
    body: jsonBody ? JSON.stringify(options.body) : options.body });
  if (raw && response.ok) return response;
  const data = await response.json().catch(error => { if (response.ok) throw error; });
  if (!response.ok) {
    if (response.status === 401 && url === '/admin/state' && requestToken === token) {
      if (requestToken === manualToken) {
        manualToken = '';
        sessionStorage.removeItem(manualTokenKey);
      }
      if (requestToken === consoleSession) {
        consoleSession = '';
        clearConsoleSession(requestToken);
      }
      token = '';
      if (state && !generation) {
        state = null;
        login(new LocalizedError('console.sessionExpired'));
      }
    }
    const error = data?.error?.message ? new Error(data.error.message) : new LocalizedError('common.requestFailedStatus', response.status);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}
async function load(renderPage = true) {
  const currentToken = token;
  const next = await api('/admin/state');
  if (token !== currentToken) return;
  state = next;
  if (renderPage) renderView();
}

function renderView() {
  render();
  if (view === 'usage' && token && state) void usage.enter();
}
async function mutate(url, method, body = {}, revision = state.revision) {
  if (busy || catalogRefresh) throw new Error(t('common.busy'));
  busy = true;
  try {
    const result = await api(url, { method, body: { ...body, revision } });
    state = result.state; return result;
  } catch (error) { try { await load(false); } catch {} throw error; }
  finally { busy = false; }
}
let loginError = '';
function login(error = '', showManual = false) {
  usage.clear();
  releasePlayMedia();
  lastPlayMode = lastPlayVideo = undefined;
  loginError = error;
  const message = error ? errorText(error) : '';
  $('#app').innerHTML = `<main class="login"><div class="login-card">
    <div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div>
    <h1>${t('console.openConsole')}</h1>
    <p>${t('console.loginOpenHelp', '<code>npm run console</code>')}</p>
    <p>${t('console.loginTabHelp', '<code>npm run --silent console -- --print</code>')}</p>
    ${showManual ? '' : `<div class="form-error" role="alert">${escape(message)}</div>`}
    <details${showManual ? ' open' : ''}>
      <summary>${t('console.useAdminToken')}</summary>
      <p>${t('console.loginTokenHelp', '<code>npm run --silent token</code>')}</p>
      <form id="login-form">
        <label>${t('console.adminToken')}<input name="token" type="password" placeholder="md_admin_…" autocomplete="off" required></label>
        ${showManual ? `<div class="form-error" role="alert">${escape(message)}</div>` : ''}
        <button class="primary">${t('console.enterConsole', icon('arrow'))}</button>
      </form>
    </details>
    ${languagePicker()}
  </div></main>`;
}
async function useConsoleLink(code) {
  const { session } = await api('/console/session', {
    method: 'POST', body: { code },
    headers: consoleSession ? { authorization: `Bearer ${consoleSession}` } : {}
  });
  manualToken = '';
  sessionStorage.removeItem(manualTokenKey);
  consoleSession = token = session;
  try { localStorage.setItem(storedSessionKey, session); } catch {}
}

function readConsoleSession() {
  try { return localStorage.getItem(storedSessionKey) || ''; } catch { return ''; }
}

function clearConsoleSession(session) {
  try {
    if (localStorage.getItem(storedSessionKey) === session) localStorage.removeItem(storedSessionKey);
  } catch {}
}

function empty(title, text, name = 'models') { return `<div class="empty">${icon(name)}<strong>${title}</strong><p>${text}</p></div>`; }
function render() {
  if (!token || !state) return login();
  if (view !== 'usage') usage.detach();
  if (view !== 'playground') releasePlayMedia();
  const current = views[view];
  const scroll = $('#catalog-table')?.scrollLeft || 0;
  const active = document.activeElement;
  const focus = active?.dataset?.catalogFocus;
  const apiFocus = active?.matches('.api-endpoint > summary') ? active.parentElement.dataset.apiId : null;
  const apiEndpoints = document.querySelectorAll('.api-endpoint');
  if (apiEndpoints.length) {
    expandedApiEndpoints.clear();
    for (const endpoint of apiEndpoints) if (endpoint.open) expandedApiEndpoints.add(endpoint.dataset.apiId);
  }
  const searchSelection = focus === 'search' ? [active.selectionStart, active.selectionEnd] : null;
  const page = view === 'connections' ? connectionsPage()
    : view === 'models' ? modelsPage()
    : view === 'api' ? apiDocsPage({ baseUrl: state.baseUrl, models: callableModels(), version: state.version, expanded: expandedApiEndpoints }, apiImageOptions)
    : view === 'playground' ? playgroundPage()
    : view === 'usage' ? '<div id="usage-workspace" class="usage-workspace"></div>'
    : keysPage();
  $('#app').innerHTML = `<div class="shell reference-layout">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div>
      <div class="sidebar-sub">${t('console.sidebarSubtitle')}</div>
      <div class="nav-label">${t('console.serverNav')}</div>
      <nav class="nav" aria-label="${t('console.mainNavigation')}">${Object.entries(views).map(([id, [label, symbol]]) =>
        `<button data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${t(label)}</span></button>`).join('')}</nav>
      <div class="sidebar-bottom">
        <div class="sidebar-status">
          <p><span class="local-dot"></span>${t('console.localGateway')}</p>
          <small>v${escape(state.version)} · 127.0.0.1</small>
          <div><button class="quiet" data-action="logout">${t('console.logout')}</button></div>
        </div>
        ${languagePicker()}
      </div>
    </aside>
    <div class="main">
      <header class="topbar"><div class="crumb"><span>${t('console.workspace')}</span><span>/</span><strong>${t(current[0])}</strong></div><span class="pill"><span class="local-dot"></span>${t('console.runningLocally')}</span></header>
      <main class="page">${page}<p class="footer-note">${t('console.footer')}</p></main>
    </div>
  </div>`;
  if (view === 'models') {
    const catalog = $('#catalog-table');
    applyCatalogWidths();
    catalog.scrollLeft = scroll;
    focusCatalogControl(focus);
    if (searchSelection) $('#catalog-search').setSelectionRange(...searchSelection);
  }
  if (view === 'playground') {
    const form = $('#play-form');
    playDrafts.set(form, { references: [], reading: false, result: null });
    updatePlayMode(form);
    showPlayVideo(form);
  }
  if (view === 'api' && apiFocus) document.querySelector(`.api-endpoint[data-api-id="${apiFocus}"] > summary`)?.focus({ preventScroll: true });
  if (view === 'usage') usage.mount($('#usage-workspace'), state);
}

function changeLanguage(next) {
  if (next === language()) return;
  if (generation) { toast(t('common.waitForRequest')); return; }
  const form = $('#play-form');
  const draft = form && playDrafts.get(form);
  if (busy || catalogRefresh || draft?.reading || $('#dialog').open || $('#login-form button:disabled')) {
    toast(t('common.busy'));
    return;
  }
  const playFields = ['endpoint', 'model', 'prompt', 'aspect_ratio', 'voice', 'speech_speed', 'audio_language', 'video_seconds', 'video_size'];
  const testFields = form && Object.fromEntries(playFields.map(name => [name, form.elements[name].value]));
  const playChecks = form && ['stream', 'transparent_background'].map(name => [name, form.elements[name].checked]);
  const uploads = form && ['audio_file', 'video_frame'].map(name => form.elements[name]).filter(field => field.files.length);
  const output = form && $('#response-output');
  const preview = output?.querySelector('img');
  const scroll = output?.scrollTop || 0;
  const manual = $('#login-form');
  const tokenInput = manual?.elements.token.value;
  const manualOpen = manual?.closest('details').open;
  selectLanguage(next, titleKey);
  clearTimeout(toastTimer);
  $('#toast').className = '';
  if (state && token) render();
  else login(loginError, manualOpen);
  if (manual) $('#login-form').elements.token.value = tokenInput;
  if (testFields) {
    const current = $('#play-form');
    current.elements.endpoint.value = testFields.endpoint;
    playDrafts.set(current, draft);
    updatePlayMode(current, testFields.model);
    for (const name of playFields.slice(2)) current.elements[name].value = testFields[name];
    for (const [name, checked] of playChecks) current.elements[name].checked = checked;
    for (const upload of uploads) current.elements[upload.name].replaceWith(upload);
    if (draft.editing) current.elements.prompt.placeholder = t('console.editPromptExample');
    if (draft.response) {
      const currentOutput = $('#response-output');
      if (preview) { preview.alt = t('console.generatedImage'); currentOutput.replaceChildren(preview); }
      showPlayResponse(draft.response, currentOutput);
      currentOutput.scrollTop = scroll;
    }
    showPlayVideo(current);
  }
  $(`[data-language="${next}"]`)?.focus({ preventScroll: true });
}

function focusCatalogControl(key) {
  if (key) {
    const control = [...document.querySelectorAll('.catalog-manager [data-catalog-focus]')].find(node => node.dataset.catalogFocus === key);
    control?.focus({ preventScroll: true });
  }
}
function connectionsPage() {
  return `<header class="between page-heading connections-heading">
    <h1>${t('console.connections')}</h1>
    <button class="quiet small-button" data-action="refresh">${t('console.refreshStatus', icon('refresh'))}</button>
  </header>
  <section class="endpoint connections-endpoint" aria-labelledby="connections-endpoint-title">
    <div>
      <div class="row wrap">
        <h2 id="connections-endpoint-title">${t('console.endpointTitle')}</h2>
        <span class="tag blue">OpenAI-compatible</span>
      </div>
      <code>${escape(state.baseUrl)}</code>
      <p>${t('console.endpointHelp')}</p>
    </div>
    <button data-action="copy-endpoint">${t('console.copyAddressButton', icon('copy'))}</button>
  </section>
  <section aria-labelledby="connections-title">
    <div class="section-header between wrap">
      <div>
        <h2 id="connections-title">${t('console.myConnections')}</h2>
        <p>${t('console.discoveryHelp')}</p>
      </div>
      <button class="quiet small-button" data-view="models">${t('console.manageModels', icon('arrow'))}</button>
    </div>
    <div class="provider-groups">${connectionGroups.map(providerGroup).join('')}</div>
  </section>`;
}

function providerGroup(id) {
  const provider = providerType(id);
  const cards = isApiEndpointGroup(id) ? namedApiCredentials().filter(credential => credential.local === (id === 'local')).map(apiCredentialCard)
    : state.connections.filter(connection => connection.type === id).map(connectionCard);
  return `<section class="card provider-group" aria-labelledby="provider-${id}-heading">
    <header class="provider-header between wrap">
      <div class="row">
        <span class="provider-icon ${id}">${icon(provider.icon)}</span>
        <div>
          <div class="row wrap">
            <h3 id="provider-${id}-heading">${provider.name}</h3>
            ${id === 'codex' ? `<span class="tag">${t('console.experimental')}</span>` : ''}
          </div>
          <p class="provider-description">${t(provider.description)}</p>
        </div>
      </div>
      ${providerActions(id, cards.length > 0)}
    </header>
    ${cards.length
      ? `<ul class="provider-connections" role="list">${cards.join('')}</ul>`
      : ''}
  </section>`;
}

function providerActions(id, hasConnections) {
  if (id === 'codex' && hasConnections) return '';
  const addAnotherInstance = id === 'ollama' && hasConnections;
  const addButton = isApiEndpointGroup(id)
    ? `<button class="provider-add" data-action="${id === 'local' ? 'add-local-endpoint' : 'add-api-credential'}">${icon('plus')} ${t(providerTypes[id].addLabel)}</button>`
    : `<button class="provider-add" data-action="add-connection" data-type="${id}">${icon('plus')} ${t(addAnotherInstance ? 'console.addInstance' : providerTypes[id].addLabel)}</button>`;
  return `<div class="provider-actions row wrap">
    ${hasConnections ? '' : `<span class="provider-empty">${t(id === 'openai' ? 'console.noApiCredentials' : 'console.noConnections')}</span>`}
    ${addAnotherInstance ? `<details class="provider-more">
      <summary aria-label="${t('console.moreOllamaActions')}">${t('console.more')}</summary>
      ${addButton}
    </details>` : addButton}
  </div>`;
}

function namedApiCredentials() {
  const counts = new Map(), positions = new Map();
  const credentials = (state.apiCredentials || []).map(credential => {
    const name = credential.name ?? new URL(credential.origin).host;
    const baseUrl = credential.baseUrl ?? credential.origin;
    const local = isLocalEndpoint(baseUrl);
    if (!local) counts.set(name, (counts.get(name) || 0) + 1);
    return { ...credential, name, baseUrl, local };
  });
  return credentials.map(credential => {
    const { name } = credential;
    if (credential.local || counts.get(name) === 1) return credential;
    const position = (positions.get(name) || 0) + 1;
    positions.set(name, position);
    return { ...credential, name: t('console.credentialOrdinal', name, position) };
  });
}

function apiCredentialCard({ id, name, baseUrl, hasKey, connectionIds, local }) {
  const keyStatus = local ? hasKey && t('console.localServiceTokenSaved') : t(hasKey ? 'console.keySaved' : 'console.noKey');
  return `<li class="connection-card api-credential-card">
    <div class="connection-heading between wrap">
      <div>
        <h4>${escape(name)}</h4>
        <p class="connection-url mono">${escape(baseUrl)}</p>
        <small>${connectionIds.length ? t('console.credentialSourceCount', connectionIds.length) : t('console.credentialUnused')}</small>
      </div>
      <div class="row wrap">
        ${keyStatus ? `<small>${keyStatus}</small>` : ''}
        <button class="quiet small-button" data-view="models" data-credential="${escape(id)}"
          aria-label="${t('console.modelsForCredential', escape(name))}">${t('console.viewCredentialModels')}</button>
        <button class="quiet small-button" data-action="edit-api-credential" data-id="${escape(id)}"
          aria-label="${t(local ? 'console.editLocalEndpointAria' : 'console.editApiCredentialAria', escape(name))}">${t('common.edit')}</button>
        ${connectionIds.length ? '' : `<button class="quiet small-button" data-action="delete-api-credential" data-id="${escape(id)}">${t('console.remove')}</button>`}
      </div>
    </div>
  </li>`;
}

function connectionSettingsButtons(connection) {
  const id = escape(connection.id);
  return `<button type="button" class="quiet small-button" data-action="edit-connection" data-id="${id}">${t('common.edit')}</button>
    <button type="button" class="quiet small-button" data-action="delete-connection" data-id="${id}">${t('console.remove')}</button>`;
}

function connectionCard(connection) {
  const models = state.models.filter(model => model.connectionId === connection.id);
  const status = !connection.enabled ? [t('console.disabled'), ''] : connection.status === 'connected' ? [t('console.checkSucceeded'), 'good'] : connection.status === 'error' ? [t('console.checkFailed'), 'error'] : [t('console.unchecked'), ''];
  const credential = connection.hasKey ? t('console.keySaved') : connection.type === 'codex' ? t('console.localSignIn') : t('console.noKey');
  return `<li class="connection-card">
    <div class="connection-heading between">
      <h4>${escape(connection.name)}</h4>
      <span class="tag ${status[1]}">${status[0]}</span>
    </div>
    ${connection.baseUrl ? `<p class="connection-url mono" title="${escape(connection.baseUrl)}">${escape(connection.baseUrl)}</p>` : ''}
    <div class="connection-meta between wrap">
      <small>${t('console.connectionModelCount', models.filter(model => model.available !== false).length, models.filter(usable).length)}</small>
      <small>${credential}</small>
    </div>
    <p class="status-line">${connection.checkedAt ? t('console.lastChecked', timestamp(connection.checkedAt)) : t('console.noDiscoveredModels')}${connection.errorCode ? ` · ${escape(connection.errorCode)}` : ''}</p>
    <div class="connection-actions between wrap">
      <button class="small-button" data-action="discover" data-id="${connection.id}">${t('console.discoverModels', icon('refresh'))}</button>
      <div class="row">${connectionSettingsButtons(connection)}</div>
    </div>
  </li>`;
}
let modelSearch = '', modelFilter = 'all';
const catalogCategories = [
  ['content_ai', 'common.textUnderstanding'],
  ['image_generation', 'console.imageGeneration'],
  ['video_generation', 'console.videoGeneration'],
  ['media_transcription', 'console.speechRecognition'],
  ['video_tts', 'console.speechSynthesis']
];
const catalogFilters = [['all', 'common.all'], ...catalogCategories];
const catalogOrder = new Map(catalogCategories.map(([category], index) => [category, index]));
const catalogServiceCategories = new Map([
  ['deepseek', 'content_ai'], ['deepseek-search', 'content_ai'], ['minimax-chat', 'content_ai'],
  ['seedream', 'image_generation'], ['minimax-image', 'image_generation'],
  ['seedance', 'video_generation'], ['minimax-video', 'video_generation'], ['local-ltx', 'video_generation'], ['wan', 'video_generation'],
  ['transcription', 'media_transcription'],
  ['minimax-speech', 'video_tts'], ['speech', 'video_tts'], ['edge-tts', 'video_tts'],
  ['embedding', 'embedding']
]);
const effortLabels = { none: 'common.off', minimal: 'effort.minimal', low: 'effort.low', medium: 'effort.medium', high: 'effort.high', xhigh: 'effort.xhigh', max: 'effort.max', ultra: 'effort.ultra' };
const catalogDash = '—';

function rememberSettings() {
  try {
    if (settingsDraft) {
      const { revision, changes } = settingsDraft;
      sessionStorage.setItem(settingsKey, JSON.stringify({ revision, changes: [...changes] }));
    } else sessionStorage.removeItem(settingsKey);
  } catch {
    if (settingsDraft) settingsError = t('console.draftStorageFailed');
  }
}

function modelTags(model, category) {
  const capabilities = model.capabilities || {};
  const tags = [];
  const categoryLabel = catalogCategories.find(([key]) => key === category)?.[1];
  if (categoryLabel && (category !== 'content_ai' || capabilities.text !== true)) tags.push(t(categoryLabel));
  if (capabilities.text === true) tags.push(t('common.textGeneration'));
  if (category === 'content_ai' && capabilities.image_input === true) tags.push(t('console.imageUnderstanding'));
  if (capabilities.tools === true) tags.push(t('common.toolCalls'));
  if (capabilities.structured === true) tags.push(t('common.structuredOutput'));
  if (capabilities.thinking === true || model.reasoningEfforts?.length) tags.push(t('common.deepReasoning'));
  return tags;
}

function draftModelSettings(model) {
  const changes = settingsDraft?.changes.get(model.id);
  return { enabled: model.enabled, reasoningPolicy: model.reasoningPolicy ?? null, ...changes };
}

function validEffortList(value) {
  return Array.isArray(value) && value.every(level => typeof level === 'string');
}

function chooseDefaultEffort(declared, levels, preferred) {
  if (levels.includes(preferred)) return preferred;
  if (!preferred) return levels.at(-1);
  const position = declared.indexOf(preferred);
  return levels.findLast(level => declared.indexOf(level) < position) ?? levels[0];
}

function reasoningLevels(model, policy) {
  const declared = [...new Set(model.reasoningEfforts || [])];
  const configured = policy?.allowedEfforts ?? declared;
  const openEfforts = policy?.openEfforts ?? configured;
  const opened = declared.filter(level => openEfforts.includes(level));
  const selected = opened.filter(level => configured.includes(level));
  const preferred = policy?.defaultEffort ?? model.defaultEffort;
  const defaultEffort = selected.includes(preferred) ? preferred : null;
  const inheritedDefault = chooseDefaultEffort(declared, opened, model.defaultEffort);
  const customized = Boolean(policy && (opened.length !== selected.length || preferred !== inheritedDefault));
  const obsolete = Boolean(policy && (!defaultEffort || opened.length !== openEfforts.length || selected.length !== configured.length));
  return { declared, opened, selected, defaultEffort, inheritedDefault, customized, obsolete };
}

const sameEfforts = (left, right) => left.length === right.length && left.every(level => right.includes(level));

function changeModelSettings(model, patch) {
  const changes = { ...settingsDraft?.changes.get(model.id), ...patch };
  if (changes.enabled === model.enabled) delete changes.enabled;
  if (Object.hasOwn(changes, 'reasoningPolicy')) {
    const saved = model.reasoningPolicy ?? null;
    const next = changes.reasoningPolicy;
    const baseline = saved || { allowedEfforts: model.reasoningEfforts || [], defaultEffort: model.defaultEffort };
    if (next === saved || next && next.defaultEffort === baseline.defaultEffort
      && sameEfforts(next.allowedEfforts, baseline.allowedEfforts)
      && sameEfforts(next.openEfforts ?? next.allowedEfforts, baseline.openEfforts ?? baseline.allowedEfforts)) delete changes.reasoningPolicy;
  }
  settingsDraft ??= { revision: state.revision, changes: new Map() };
  if (Object.keys(changes).length) settingsDraft.changes.set(model.id, changes);
  else settingsDraft.changes.delete(model.id);
  if (!settingsDraft.changes.size) settingsDraft = undefined;
  settingsError = catalogNotice = '';
  rememberSettings();
  render();
}

function setModelReasoning(model, declared, opened, selected, preferred) {
  const defaultEffort = chooseDefaultEffort(declared, selected, preferred);
  changeModelSettings(model, { reasoningPolicy: { allowedEfforts: selected, defaultEffort,
    ...(selected.length < opened.length && { openEfforts: opened }) } });
}

function changeOpenEffort(model, level) {
  const { reasoningPolicy } = draftModelSettings(model);
  const { declared, opened, selected, inheritedDefault } = reasoningLevels(model, reasoningPolicy);
  if (!declared.includes(level)) return;
  const nextOpen = declared.filter(value => opened.includes(value) !== (value === level));
  if (!nextOpen.length) return;
  const retained = reasoningPolicy?.openEfforts ? nextOpen.filter(value => selected.includes(value)) : nextOpen;
  const preferred = reasoningPolicy && reasoningPolicy.defaultEffort !== inheritedDefault ? reasoningPolicy.defaultEffort : model.defaultEffort;
  setModelReasoning(model, declared, nextOpen, retained.length ? retained : nextOpen, preferred);
}

function changeModelEffort(model, level, pin) {
  const { declared, opened, selected, defaultEffort } = reasoningLevels(model, draftModelSettings(model).reasoningPolicy);
  if (!opened.includes(level) || pin && !selected.includes(level)) return;
  const nextSelected = pin ? selected : opened.filter(value => selected.includes(value) !== (value === level));
  if (nextSelected.length) setModelReasoning(model, declared, opened, nextSelected, pin ? level : defaultEffort);
}

function resetModelEfforts(model) {
  const { declared, opened } = reasoningLevels(model, draftModelSettings(model).reasoningPolicy);
  if (!opened.length || opened.length === declared.length) changeModelSettings(model, { reasoningPolicy: null });
  else setModelReasoning(model, declared, opened, opened, model.defaultEffort);
}

function compactTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  if (value % 1_048_576 === 0) return `${value / 1_048_576}M`;
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return number(value);
}

function catalogModel(model, connection, serviceName) {
  const available = model.available !== false && connection.enabled;
  const category = catalogCategory(connection, model);
  const { enabled, reasoningPolicy } = draftModelSettings(model);
  const { declared, opened, selected, defaultEffort, customized, obsolete } = reasoningLevels(model, reasoningPolicy);
  const pending = Boolean(busy || catalogRefresh);
  const locked = pending || !enabled || !available;
  const modelId = escape(model.id), name = escape(model.name);
  const details = `<button type="button" class="catalog-icon" data-action="model-details" data-id="${modelId}"
    data-catalog-focus="details:${modelId}" aria-label="${t('console.detailsAria', name)}" aria-haspopup="dialog" title="${t('console.modelDetailsAndPrice')}">${icon('info')}</button>`;
  const tags = modelTags(model, category);
  const text = category === 'content_ai';
  const input = compactTokens(model.maxInputTokens), output = compactTokens(model.maxOutputTokens);
  const context = compactTokens(model.contextWindow);
  const limits = text ? t('console.inputOutputLimits', input ?? catalogDash, output ?? catalogDash) : t('console.mediaLimits');
  const levels = declared.map(level => {
    const label = Object.hasOwn(effortLabels, level) ? t(effortLabels[level]) : level;
    const open = opened.includes(level), chosen = selected.includes(level);
    const openTitle = open && opened.length === 1 ? t('console.keepOneEffort')
      : t('console.effortAction', open ? t('common.close') : t('console.allow'));
    const selectTitle = !open ? t('console.effortNotOpen') : chosen && selected.length === 1 ? t('console.keepOneSelectableEffort')
      : t(chosen ? 'console.removeSelectableEffort' : 'console.addSelectableEffort', label);
    return { level: escape(level), label: escape(label), open, chosen, pinned: level === defaultEffort, openTitle, selectTitle };
  });
  return `<div class="catalog-model" data-model-id="${modelId}" data-enabled="${enabled && available}">
    <div class="catalog-model-info">
      <h3>${name}</h3>
      ${serviceName && serviceName !== model.name ? `<p class="catalog-model-service">${escape(serviceName)}</p>` : ''}
      ${tags.length ? `<div class="catalog-badges" role="group" aria-label="${t('console.capabilitiesAria', name)}">${tags.map(tag => `<span class="catalog-badge">${escape(tag)}</span>`).join('')}</div>` : ''}
      <div class="catalog-limits">${escape(limits)} <span class="catalog-limits-end">${text ? 'tokens' : ''}${details}</span></div>
      ${text && context && !input && !output ? `<p class="catalog-limits">${t('console.contextTokens', context)}</p>` : ''}
      ${levels.length ? `<span class="catalog-caption">${t('common.allowedEfforts')}</span>
        <div class="catalog-levels" role="group" aria-label="${t('common.allowedEffortsAria', name)}">${levels.map(({ level, label, open, openTitle }) => `<button type="button" class="catalog-level" data-action="toggle-open-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="open:${modelId}:${level}" aria-pressed="${open}" title="${escape(openTitle)}" ${locked || open && opened.length === 1 ? 'disabled' : ''}>${label === level ? level : t('common.effortWithId', label, level)}</button>`).join('')}</div>` : ''}
      <div class="catalog-publication">
        <button type="button" class="catalog-switch" role="switch" aria-checked="${enabled}" aria-label="${t('console.publishModel', name)}"
          data-action="publish-model" data-id="${modelId}" data-catalog-focus="publish:${modelId}"
          ${pending || !available && !enabled ? 'disabled' : ''}><span class="catalog-track" aria-hidden="true"></span>${enabled ? t('common.enabled') : t('common.disabled')}</button>
        ${available ? '' : `<span class="catalog-warning">${t('console.unavailable')}</span>`}
      </div>
    </div>
    <div class="catalog-reasoning">
      ${levels.length ? `
      <div class="catalog-levels" role="group" aria-label="${t('console.effortsAria', name)}">${levels.map(({ level, label, open, chosen, pinned, selectTitle }) => `<span class="catalog-effort" data-allowed="${chosen}" data-locked="${locked || !open}">
        <button type="button" class="catalog-effort-toggle" data-action="toggle-model-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="effort:${modelId}:${level}" aria-label="${t('common.effortOptionAria', name, label)}" aria-pressed="${chosen}" title="${escape(selectTitle)}" ${locked || !open || chosen && selected.length === 1 ? 'disabled' : ''}>${label}</button>
        <button type="button" class="catalog-effort-pin" data-action="pin-model-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="pin:${modelId}:${level}" aria-label="${t('common.effortDefaultAria', name, label)}" aria-pressed="${pinned}"
          title="${pinned ? t('common.defaultEffort') : chosen ? t('console.setDefaultLabel', label) : t('console.allowEffortFirst')}" ${locked || !chosen ? 'disabled' : ''}>${icon('pin')}</button>
      </span>`).join('')}</div>` : `<span class="catalog-muted" title="${t('console.noEffortOptions')}">${catalogDash}</span>`}
      ${customized || obsolete ? `<button type="button" class="catalog-text" data-action="reset-model-efforts" data-id="${modelId}" title="${t('console.resetModelEffortsHelp')}"
        ${pending ? 'disabled' : ''}>${t('console.resetModelEfforts')}</button>` : ''}
      ${obsolete ? `<p class="catalog-effort-warning catalog-warning">${t('console.effortChanged', t(locked || !levels.length ? 'console.resetModelEfforts' : 'console.selectSupportedEfforts'))}</p>` : ''}
    </div>
  </div>`;
}

const connectionErrors = {
  upstream_auth_failed: 'console.checkKeyAndAccess',
  upstream_unreachable: 'console.checkServiceAddress',
  upstream_rate_limited: 'console.upstreamRateLimited',
  upstream_protocol_error: 'console.upstreamUnreadable',
  codex_auth_required: 'console.signInCodex',
  codex_unavailable: 'console.checkCodexInstall',
  codex_timeout: 'console.codexDidNotRespond',
  codex_connection_failed: 'console.codexConnectionFailed',
  codex_rate_limited: 'console.codexQuotaExhausted'
};

function recentModelCall(connectionId, nativeModel) {
  return state.requests.find(request => request.connectionId === connectionId
    && (nativeModel === undefined || request.nativeModel === nativeModel)
    && ['succeeded', 'failed'].includes(request.status));
}

function connectionHealth(connection, models) {
  if (!connection?.enabled) return { status: 'disabled', label: t('console.serviceDisabled') };
  if (catalogRefresh?.id === connection.id) return { status: 'checking', label: t('console.checking') };
  const apiSource = connection.type === 'openai' || connection.type === 'service';
  const lastCall = recentModelCall(connection.id);
  const newerCall = lastCall && connection.checkedAt && Date.parse(lastCall.startedAt) + lastCall.durationMs > Date.parse(connection.checkedAt);
  const callError = newerCall && lastCall.status === 'failed' && connectionErrors[lastCall.errorCode];
  if (callError) return { status: 'call_failed', label: apiSource ? t('console.lastApiCallFailed') : t('console.lastCallFailed'), detail: t(callError) };
  const callSucceeded = newerCall && lastCall.status === 'succeeded';
  if (connection.status === 'error' && !callSucceeded) {
    return {
      status: 'error',
      label: apiSource ? t('console.apiIssue') : t('common.connectionIssue'),
      detail: t(connectionErrors[connection.errorCode] || 'console.retryConnectionCheck')
    };
  }
  if (connection.status === 'connected' || callSucceeded) {
    if (apiSource) return { status: 'connected', label: t('console.apiConnected') };
    const available = models.filter(model => model.available !== false).length;
    if (!available) return { status: models.length ? 'unknown' : 'empty', label: t('console.noAvailableModels') };
    if (available < models.length) return { status: 'unknown', label: t('console.modelsNotReady') };
    return { status: 'connected', label: t('console.serviceRunning') };
  }
  return { status: 'unknown', label: apiSource ? t('console.apiUnverified') : t('console.unverified') };
}

function catalogRuntime({ status, label }, button = '', title = '') {
  return `<div class="catalog-runtime" data-status="${status}"${title ? ` title="${escape(title)}"` : ''}>
    <span class="catalog-status-dot" aria-hidden="true"></span><span role="status">${label}</span>${button}</div>`;
}

function catalogCheckButton(id, name, health, enabled) {
  const checking = health.status === 'checking';
  return `<button type="button" class="catalog-icon catalog-status-refresh" data-action="check-credential" data-id="${escape(id)}"
    data-catalog-focus="check-group:${escape(id)}" aria-label="${t('console.refreshConnectionAria', escape(name))}"
    title="${t(checking ? 'console.checkingConnection' : 'console.checkConnection')}"
    aria-busy="${checking}" ${busy || catalogRefresh || !enabled ? 'disabled' : ''}>${icon('cycle')}</button>`;
}

function catalogGroupHealth(health) {
  const [first] = health;
  if (health.every(item => item.status === first.status)) return first;
  const checking = health.find(item => item.status === 'checking');
  if (checking) return checking;
  if (health.some(item => ['error', 'call_failed'].includes(item.status))) {
    return { status: 'error', label: t('console.serviceGroupIssue') };
  }
  return { status: 'unknown', label: t('console.serviceGroupPending') };
}

function catalogGroup({ id, displayName, source, services, rows }) {
  const health = services.map(({ connection, total }) => connectionHealth(connection, total));
  const summary = catalogGroupHealth(health);
  const check = catalogCheckButton(id, displayName, summary, services.some(({ connection }) => connection.enabled));
  const name = escape(displayName);
  const heading = services.some(({ connection }) => usesApiCredential(connection))
    ? `<button type="button" class="catalog-credential-action" data-action="manage-api-services" data-id="${escape(id)}"
        aria-haspopup="dialog" title="${t('console.manageServices')}" ${busy || catalogRefresh ? 'disabled' : ''}>${name}</button>`
    : name;
  const models = rows.filter(({ model }) => model);
  const enabled = models.some(({ model, connection }) => connection.enabled && model.available !== false && draftModelSettings(model).enabled);
  return `<section class="catalog-group" data-enabled="${enabled}" aria-label="${t('common.connectionModelsAria', name)}">
    <div class="catalog-source">
      <h2>${heading}</h2>
      <p class="catalog-credential-source">${escape(source)}</p>
      <span class="catalog-badge">${t('console.configuredModelCount', models.filter(({ model }) => model.available !== false).length, models.length)}</span>
      ${catalogRuntime(summary, check, summary.detail)}
    </div>
    <div class="catalog-rows">${rows.map(({ connection, model, serviceName }) => model ? catalogModel(model, connection, serviceName)
      : `<p class="catalog-empty">${serviceName ? `<span class="catalog-model-service">${escape(serviceName)}</span>` : ''}${t('console.noDiscoveredModels')}</p>`).join('')}</div>
  </section>`;
}

function catalogCredentialId() {
  return new URLSearchParams(location.search).get('credential');
}

function catalogConnections() {
  const id = catalogCredentialId();
  const credential = state.apiCredentials?.find(item => item.id === id);
  return credential ? state.connections.filter(connection => credential.connectionIds.includes(connection.id)) : state.connections;
}

function catalogCategory(connection, model) {
  if (connection?.type === 'service') return catalogServiceCategories.get(connection.service);
  if (model) return model.capability || (model.capabilities?.text !== false ? 'content_ai' : undefined);
  return connection?.type === 'mflux' ? 'image_generation' : undefined;
}

const catalogRank = category => catalogOrder.get(category) ?? catalogOrder.size;

function matchesCatalogFilter(category) {
  return modelFilter === 'all' || category === modelFilter;
}

function catalogGroups(needle) {
  const credentials = new Map(namedApiCredentials().map(credential => [credential.id, credential]));
  const groups = new Map();
  const byRank = (a, b) => a.rank - b.rank;
  for (const connection of catalogConnections()) {
    const credential = credentials.get(connection.credentialId);
    const displayName = credential?.name ?? connection.name;
    const serviceName = credential?.connectionIds.length > 1
      ? displayName === connection.name ? t(`services.${connection.service || connection.type}`) : connection.name
      : '';
    const provider = providerType(connection.type).name;
    const source = credential?.baseUrl ?? (connection.type === 'codex' ? t('console.codexLocalSignIn') : provider);
    const sourceText = `${displayName} ${connection.name} ${serviceName} ${connection.type} ${provider} ${source}`.toLowerCase();
    const total = state.models.filter(model => model.connectionId === connection.id);
    const rows = total.flatMap(model => {
      const category = catalogCategory(connection, model);
      return matchesCatalogFilter(category) && `${sourceText} ${model.id} ${model.name} ${model.nativeId || ''}`.toLowerCase().includes(needle)
        ? [{ connection, model, serviceName, rank: catalogRank(category) }] : [];
    }).sort(byRank);
    const category = catalogCategory(connection);
    const emptySource = !total.length && matchesCatalogFilter(category)
      && sourceText.includes(needle);
    if (!rows.length && !emptySource) continue;
    const id = credential?.id ?? connection.id;
    if (!groups.has(id)) groups.set(id, { displayName, source, services: [] });
    groups.get(id).services.push({ connection, total, rows, serviceName, rank: rows[0]?.rank ?? catalogRank(category) });
  }
  return [...groups].map(([id, { displayName, source, services }]) => {
    const rows = services.flatMap(({ connection, rows, serviceName, rank }) => rows.length ? rows : [{ connection, serviceName, rank }]).sort(byRank);
    return { id, displayName, source, services: services.sort(byRank), rows };
  }).sort((a, b) => a.rows[0].rank - b.rows[0].rank);
}

function modelTable() {
  const needle = modelSearch.trim().toLowerCase();
  const groups = catalogGroups(needle).map(catalogGroup).join('');
  if (!groups) {
    const label = t(catalogFilters.find(([key]) => key === modelFilter)[1]);
    let message = t('console.addSourceFirst');
    if (needle) message = t('console.noMatchingModels');
    else if (modelFilter !== 'all') message = t('console.noModelsInCategory', label);
    return `<p class="catalog-empty">${message}</p>`;
  }
  return `<div class="catalog-grid"><div class="catalog-header">${catalogColumns.map(column => `<span>${t(column.label)}
    <button type="button" class="catalog-resizer" data-catalog-column="${column.key}" data-catalog-focus="column:${column.key}"
      role="separator" aria-orientation="vertical" aria-label="${t('common.resizeColumn', t(column.label))}" aria-valuemin="${column.min}" aria-valuemax="1200"
      aria-valuenow="${catalogWidth(column)}" title="${t('common.resizeColumnHelp')}"></button></span>`).join('')}</div>${groups}</div>`;
}

function catalogWidth(column, width = catalogWidths[column.key] ?? column.width) {
  return Math.max(column.min, Math.min(1200, Math.round(width)));
}

function applyCatalogWidths() {
  const grid = $('.catalog-grid');
  if (!grid) return;
  for (const column of catalogColumns) {
    const width = catalogWidth(column);
    grid.style.setProperty(`--catalog-${column.key}`, `${width}px`);
    grid.querySelector(`[data-catalog-column="${column.key}"]`).setAttribute('aria-valuenow', width);
  }
}

function resizeCatalogColumn(column, width) {
  catalogWidths[column.key] = catalogWidth(column, width);
  applyCatalogWidths();
}

function rememberCatalogWidths() {
  const widths = JSON.stringify(catalogWidths);
  try { localStorage.setItem(catalogWidthsKey, widths); }
  catch { try { sessionStorage.setItem(catalogWidthsKey, widths); } catch {} }
}

function poolDeployments(pool) {
  const groups = new Map();
  const connections = new Map(state.connections.map(connection => [connection.id, connection]));
  for (const model of usableModels()) {
    const connection = connections.get(model.connectionId);
    const capability = model.capability ?? null;
    if (pool && (model.nativeId !== pool.nativeId || connection.type !== pool.providerType || capability !== pool.capability)) continue;
    const key = JSON.stringify([model.nativeId, connection.type, capability]);
    if (!groups.has(key)) groups.set(key, { title: `${model.nativeId} · ${providerType(connection.type).name}`, members: [] });
    groups.get(key).members.push({ id: model.id, label: connection.name, baseUrl: connection.baseUrl });
  }
  if (pool) {
    const group = groups.values().next().value || { title: pool.nativeId, members: [] };
    group.members = [
      ...pool.members.map(member => group.members.find(item => item.id === member.id) ||
        { id: member.id, label: `${member.connectionName || member.id} · ${t('pools.unavailable')}` }),
      ...group.members.filter(member => !pool.modelIds.includes(member.id))
    ];
    return [group];
  }
  return [...groups.values()].filter(group => new Set(group.members.map(member => member.baseUrl)).size >= 2);
}

function poolsSection(pending) {
  const pools = state.pools || [];
  const canAdd = poolDeployments().length > 0;
  return `<section aria-labelledby="pools-heading">
    <div class="section-header between wrap"><div><h2 id="pools-heading">${t('pools.title')}</h2><p>${t('pools.description')}</p></div>
      <button type="button" data-action="add-pool" class="small-button" ${pending || !canAdd ? 'disabled' : ''}>${t('pools.create')}</button></div>
    ${!canAdd ? `<p class="catalog-muted">${t('pools.deploymentHelp')}</p>` : ''}
    ${pools.length ? `<div class="table-wrap"><table><thead><tr><th>${t('pools.source')}</th><th>${t('common.model')}</th>
      <th>${t('pools.members')}</th><th>${t('pools.status')}</th><th></th></tr></thead><tbody>
      ${pools.map(pool => `<tr><td><strong>${escape(pool.name)}</strong><code>${escape(pool.id)}</code></td>
        <td><code>${escape(pool.nativeId)}</code></td><td>${pool.members.map(member => {
          const status = !member.available ? t('pools.unavailable') : member.cooldownUntil
            ? t('pools.cooldown', dateTime(member.cooldownUntil)) : t('pools.ready');
          return `<div>${escape(member.connectionName || member.id)} <small>${escape(status)}</small></div>`;
        }).join('')}</td>
        <td>${t(pool.enabled ? 'common.enabled' : 'common.disabled')}</td><td><div class="row wrap">
          <button type="button" class="quiet small-button" data-action="edit-pool" data-id="${escape(pool.id)}" ${pending ? 'disabled' : ''}>${t('pools.edit')}</button>
          <button type="button" class="quiet danger small-button" data-action="delete-pool" data-id="${escape(pool.id)}" ${pending ? 'disabled' : ''}>${t('pools.remove')}</button>
        </div></td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
}

function poolDialog(pool) {
  const groups = poolDeployments(pool);
  const revision = state.revision;
  showDialog(t(pool ? 'pools.edit' : 'pools.create'), t('pools.deploymentHelp'), `
    <label>${t('pools.name')}<input name="name" maxlength="100" required value="${escape(pool?.name)}"></label>
    <div class="checklist pool-deployments">${groups.map(group => `<fieldset><legend>${escape(group.title)}</legend>
      ${group.members.map(member => `<label class="checkbox-label"><input type="checkbox" name="modelIds" value="${escape(member.id)}"
        ${pool?.modelIds.includes(member.id) ? 'checked' : ''}>${escape(member.label)}${member.baseUrl ? ` <code>${escape(member.baseUrl)}</code>` : ''}</label>`).join('')}
      </fieldset>`).join('')}</div>
    <label class="checkbox-label"><input type="checkbox" name="enabled" ${pool?.enabled !== false ? 'checked' : ''}>${t('pools.publish')}</label>`,
  t('common.saveChanges'), async form => {
    await mutate(pool ? `/admin/pools/${encodeURIComponent(pool.id)}` : '/admin/pools', pool ? 'PATCH' : 'POST',
      { name: form.get('name'), modelIds: form.getAll('modelIds'), enabled: form.has('enabled') }, revision);
    advanceSettingsDraft(revision);
    $('#dialog').close(); render(); toast(t('pools.saved'));
  });
}

function modelsPage() {
  const credentialId = catalogCredentialId();
  const credential = credentialId ? namedApiCredentials().find(item => item.id === credentialId) : undefined;
  const models = credential ? state.models.filter(model => credential.connectionIds.includes(model.connectionId)) : state.models;
  const hasCredentials = state.apiCredentials?.length > 0;
  const dirty = settingsDraft?.changes.size || 0;
  const conflict = settingsDraft && settingsDraft.revision !== state.revision;
  const pending = Boolean(busy || catalogRefresh);
  const refreshing = Boolean(catalogRefresh?.all);
  const refreshLabel = refreshing ? t('common.refreshing') : dirty ? t('console.refreshKeepChanges') : t('console.refreshCatalog');
  const feedback = refreshing && catalogRefresh.total
    ? t('console.catalogRefreshProgress', catalogRefresh.current, catalogRefresh.total)
    : dirty ? t('console.unsavedChangeCount', dirty) : catalogNotice && t(catalogNotice);
  const unavailable = state.models.some(model => settingsDraft?.changes.get(model.id)?.enabled === true
    && (model.available === false || !state.connections.find(connection => connection.id === model.connectionId)?.enabled));
  const invalidEfforts = state.models.some(model => {
    const policy = settingsDraft?.changes.get(model.id)?.reasoningPolicy;
    return policy && reasoningLevels(model, policy).obsolete;
  });
  const enabled = models.filter(model => draftModelSettings(model).enabled).length;
  return `<div class="cm-page-heading"><h1>${t('console.modelsHeading', icon('sliders'))}</h1></div>
    <section class="catalog-manager" aria-label="${t('console.models')}" aria-busy="${pending}">
      <div class="catalog-toolbar">
        <div class="catalog-filters" role="group" aria-label="${t('common.modelTypeFilters')}">
          ${catalogFilters.map(([key, label]) => `<button type="button" data-action="catalog-filter" data-value="${key}"
            data-catalog-focus="filter:${key}" aria-pressed="${modelFilter === key}">${t(label)}</button>`).join('')}
        </div>
        <div class="catalog-actions">
          <span class="catalog-muted">${t('common.enabledCount', enabled, models.length)}</span>
          <button class="catalog-save ${dirty ? 'primary' : ''}" data-action="save-publication" data-catalog-focus="save"
            ${!dirty || pending || conflict || unavailable || invalidEfforts ? 'disabled' : ''}>${busy ? t('common.working') : dirty ? t('common.saveChangesCount', dirty) : t('common.saved')}</button>
        </div>
      </div>
      <div class="catalog-secondary">
        <input id="catalog-search" type="search" data-catalog-focus="search" aria-label="${t('console.searchModels')}" placeholder="${t('console.searchModelsPlaceholder')}" value="${escape(modelSearch)}">
        <div class="catalog-actions">
          ${feedback ? `<span class="catalog-muted" role="status">${feedback}</span>` : ''}
          ${hasCredentials ? `<button type="button" class="catalog-text" data-action="add-api-service" ${pending ? 'disabled' : ''}>${t('console.addApiService')}</button>`
            : `<button type="button" class="catalog-text" data-view="connections">${t('console.addConnectionFirst')}</button>`}
          <button type="button" class="catalog-text" data-action="revert-publication" data-catalog-focus="revert"
            ${!dirty || pending ? 'disabled' : ''}>${t('common.discardChanges')}</button>
          <button class="catalog-text" data-action="refresh-catalog" data-catalog-focus="refresh" aria-busy="${refreshing}"
            title="${t('console.refreshCatalogHelp')}" ${pending ? 'disabled' : ''}>${refreshLabel}</button>
        </div>
      </div>
      ${credential ? `<div class="catalog-actions catalog-scope">
        <small>${t('console.modelsForCredential', escape(credential.name))}</small>
        <button class="catalog-text" data-view="models">${t('console.showAllModelsAndServices')}</button>
      </div>` : ''}
      ${conflict ? `<p class="catalog-feedback" role="status">${t('console.catalogConflict')}</p>` : ''}
      ${unavailable && !conflict ? `<p class="catalog-feedback" role="status">${t('console.unavailablePendingModel')}</p>` : ''}
      ${invalidEfforts && !conflict ? `<p class="catalog-feedback" role="status">${t('console.unavailablePendingEffort')}</p>` : ''}
      ${settingsError ? `<p class="catalog-feedback catalog-warning" role="alert">${escape(settingsError)}</p>` : ''}
      <div id="catalog-table" class="catalog-scroll" role="region" tabindex="0" aria-label="${t('console.catalogRegion')}">${modelTable()}</div>
    </section>${poolsSection(pending)}`;
}

function advanceSettingsDraft(previousRevision) {
  // Discovery only updates the catalog. A different revision jump can include
  // another tab's settings changes and must remain a save conflict.
  if (settingsDraft?.revision === previousRevision && state.revision === previousRevision + 1) {
    settingsDraft.revision = state.revision;
    rememberSettings();
  }
}

async function inspectConnection(id) {
  const revision = state.revision;
  const checkedAt = state.connections.find(connection => connection.id === id)?.checkedAt;
  try {
    const result = await api(`/admin/connections/${encodeURIComponent(id)}/discover`, {
      method: 'POST',
      body: { revision }
    });
    state = result.state;
    advanceSettingsDraft(revision);
    return true;
  } catch (error) {
    await load(false);
    const connection = state.connections.find(item => item.id === id);
    const recordedFailure = connection?.status === 'error' && connection.errorCode === error.code
      && connection.checkedAt && connection.checkedAt !== checkedAt;
    if (recordedFailure && error.code !== 'revision_conflict') {
      advanceSettingsDraft(revision);
      return false;
    }
    throw error;
  }
}

async function refreshModelServices(id) {
  const all = id === undefined;
  const focus = all ? 'refresh' : `check-group:${id}`;
  const returnFocus = document.activeElement?.dataset?.catalogFocus === focus;
  const group = all ? undefined : catalogGroups(modelSearch.trim().toLowerCase()).find(item => item.id === id);
  const connectionIds = group?.services.map(({ connection }) => connection.id) ?? [];
  catalogRefresh = { all };
  catalogNotice = '';
  settingsError = '';
  render();
  let failed = 0;
  try {
    if (all) await load(false);
    const sources = catalogConnections().filter(connection => connection.enabled && (all || connectionIds.includes(connection.id)));
    catalogRefresh.total = sources.length;
    for (const [index, connection] of sources.entries()) {
      catalogRefresh.id = connection.id;
      catalogRefresh.current = index + 1;
      if (view === 'models') render();
      if (!await inspectConnection(connection.id)) failed++;
    }
    if (failed) {
      settingsError = t('console.serviceChecksFailed', failed);
    } else {
      catalogNotice = all ? 'console.catalogUpdated' : 'console.connectionCheckComplete';
    }
  } catch (error) {
    settingsError = error.code === 'revision_conflict' ? t('console.retryChangedCatalog') : t('console.refreshFailed');
  } finally {
    catalogRefresh = undefined;
    if (view === 'models' || view === 'connections') {
      const focused = document.activeElement;
      const restoreFocus = returnFocus && (!focused || focused === document.body || !focused.isConnected);
      render();
      if (restoreFocus && view === 'models') focusCatalogControl(focus);
    }
  }
}

function playgroundPage() {
  const choices = availableChoices();
  const mode = lastPlayMode || (choices.some(choice => choice.mode === 'chat') ? 'chat' : choices.find(choice => choice.mode)?.mode) || 'chat';
  return `<div class="page-heading"><div class="eyebrow">${t('console.playgroundEyebrow')}</div><h1>${t('console.playgroundTitle')}</h1><p>${t('console.playgroundHelp')}</p></div>
    <div class="playground">
      <form id="play-form" class="card stack">
        <h2>${t('console.sendRequest')}</h2>
        <label>${t('console.testEndpoint')}<select name="endpoint">${Object.entries(playgroundModes).map(([id, label]) =>
          `<option value="${id}"${mode === id ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></label>
        <label>${t('common.model')}<select name="model" required></select></label>
        <label id="play-prompt"><span></span><textarea name="prompt" rows="6" required></textarea></label>
        <label id="play-stream" class="checkbox-label"><input type="checkbox" name="stream" checked>${t('common.streamOutput')}</label>
        <fieldset class="play-image-options" id="play-image-options" hidden disabled>
          <label><span id="play-size-label"></span><select name="aspect_ratio"></select></label>
          <label class="checkbox-label"><input type="checkbox" name="transparent_background">${t('console.transparentBackground')}</label>
          <div class="play-references" role="group" aria-labelledby="play-reference-label">
            <div class="between"><h3 id="play-reference-label">${t('console.referenceImages')} <small id="play-reference-count" aria-live="polite">0 / ${maxImageReferences}</small></h3>
              <button type="button" class="small-button" data-action="add-reference">${t('console.addImages', icon('plus'))}</button></div>
            <input type="file" name="image_files" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple hidden>
            <ol class="play-reference-list" id="play-reference-list" hidden></ol>
            <small id="play-reference-hint">${t('console.imageFormats')}</small>
          </div>
        </fieldset>
        ${mediaFields()}
        <div class="row"><button class="primary" id="send-button" disabled>${t('console.sendRequestButton', icon('play'))}</button><button type="button" id="stop-button" data-action="stop" disabled>${t('common.stop')}</button></div>
      </form>
      <section class="card"><div class="between"><h2>${t('console.modelResponse')}</h2><span class="tag" id="response-status" role="status">${t('console.awaitingRequest')}</span></div>
        <div id="play-video-job" hidden>
          <div class="between wrap"><div>${t('console.testVideoJob')} <code id="play-video-id"></code></div>
            <button type="button" class="small-button" data-action="resume-video" hidden>${t('console.testResumeVideo')}</button></div>
          <progress id="play-video-progress" max="100" aria-label="${t('console.testVideoProgress')}" hidden></progress>
        </div>
        <div class="response empty-output" id="response-output" role="log" aria-live="polite">${t('console.responsePlaceholder')}</div>
        <div class="between wrap play-result-footer"><div id="response-meta" class="output-meta"></div>
          <a id="play-media-download" class="small-button" hidden></a>
          <button type="button" class="small-button" data-action="continue-image" hidden>${t('console.continueEditing')}</button></div>
      </section>
    </div>${requestHistory()}${snippet()}`;
}
function playgroundPlaceholder(image, references = 0) {
  if (!image) return t('console.textPromptExample');
  if (references > 1) return t('console.multipleImagePromptExample');
  if (references === 1) return t('console.singleImagePromptExample');
  return t('console.imagePromptExample');
}
function renderImageReferences(form) {
  const { references } = playDrafts.get(form);
  const list = $('#play-reference-list');
  list.hidden = references.length === 0;
  list.innerHTML = references.map((reference, index) => {
    const name = reference.generated ? t('console.previousImage') : reference.name;
    const label = t('console.referenceLabel', index + 1);
    return `<li><img alt=""><div class="play-reference-name"><strong>${label}</strong><small title="${escape(name)}">${escape(name)}</small></div>
      <div class="row"><button type="button" data-action="move-reference-up" data-index="${index}" aria-label="${t('console.moveReferenceUp', label)}" title="${t('console.moveReferenceUp', label)}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button type="button" data-action="move-reference-down" data-index="${index}" aria-label="${t('console.moveReferenceDown', label)}" title="${t('console.moveReferenceDown', label)}" ${index === references.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button type="button" data-action="remove-reference" data-index="${index}" aria-label="${t('console.removeReference', label)}" title="${t('console.removeReference', label)}">${icon('close')}</button></div></li>`;
  }).join('');
  list.querySelectorAll('img').forEach((node, index) => { node.src = references[index].url; });
  const model = modelById(form.elements.model.value);
  const limit = model?.maxReferenceImages ?? maxImageReferences;
  form.querySelector('.play-references').hidden = limit === 0;
  $('#play-reference-count').textContent = `${references.length} / ${limit}`;
  form.querySelector('[data-action="add-reference"]').disabled = references.length >= limit;
  $('#play-reference-hint').textContent = references.length ? t('console.referencePromptHelp') : t('console.imageFormats');
  const image = imageModel(model);
  form.elements.prompt.placeholder = playgroundPlaceholder(image, image && limit ? references.length : 0);
}
function changeImageReferences(button) {
  const form = $('#play-form'), draft = playDrafts.get(form);
  const { references, result } = draft;
  const action = button.dataset.action;
  if (action === 'continue-image' && result) {
    // Start the next edit from the output. Other references can be added again.
    references.splice(0, references.length, result);
    renderImageReferences(form);
    form.elements.prompt.value = '';
    form.elements.prompt.placeholder = t('console.editPromptExample');
    draft.editing = true;
    form.elements.prompt.focus();
    return;
  }
  const index = Number(button.dataset.index);
  if (action === 'remove-reference') {
    references.splice(index, 1);
    renderImageReferences(form);
    form.querySelector('[data-action="add-reference"]').focus();
    return;
  }
  const next = index + (action === 'move-reference-up' ? -1 : 1);
  [references[index], references[next]] = [references[next], references[index]];
  renderImageReferences(form);
  const row = $('#play-reference-list').children[next];
  (row.querySelector(`[data-action="${action}"]:enabled`) || row.querySelector('button:enabled')).focus();
}
function readImageReference(file, format) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => {
      const encoded = reader.result.slice(reader.result.indexOf(',') + 1);
      resolve({ name: file.name, size: file.size, url: `data:image/${format};base64,${encoded}` });
    };
    reader.onerror = () => reject(new Error(t('console.readImageFailed')));
    reader.readAsDataURL(file);
  });
}
async function addImageReferences(input) {
  const form = input.form, draft = playDrafts.get(form), files = [...input.files];
  input.value = '';
  if (!files.length || draft.reading || generation) return;
  const options = $('#play-image-options');
  const send = $('#send-button'), selector = form.elements.model;
  const existing = draft.references;
  const limit = modelById(selector.value)?.maxReferenceImages ?? maxImageReferences;
  if (existing.length + files.length > limit) throw new Error(t('console.tooManyReferences', limit));
  const formats = files.map(file => {
    const name = file.type ? /^image\/(\w+)$/i.exec(file.type)?.[1] : file.name.split('.').at(-1);
    const subtype = name?.toLowerCase();
    return Object.hasOwn(referenceFormats, subtype) ? referenceFormats[subtype] : null;
  });
  if (formats.some(format => !format)) throw new Error(t('console.chooseImageFormat'));
  if (files.some(file => !file.size || file.size > maxImageReferenceBytes)) throw new Error(t('console.referenceSizeLimit'));
  const total = [...existing, ...files].reduce((size, file) => size + file.size, 0);
  if (total > maxImageReferenceTotalBytes) throw new Error(t('console.referenceTotalLimit'));
  draft.reading = true;
  options.disabled = send.disabled = selector.disabled = form.elements.endpoint.disabled = true;
  try {
    const added = [];
    for (const [index, file] of files.entries()) added.push(await readImageReference(file, formats[index]));
    if (form.isConnected) {
      existing.push(...added);
      renderImageReferences(form);
    }
  } finally {
    draft.reading = false;
    options.disabled = send.disabled = selector.disabled = form.elements.endpoint.disabled = false;
  }
}
function requestHistory() {
  const rows = [...state.active.map(row => ({ ...row, status: 'running', durationMs: Date.now() - new Date(row.startedAt).getTime() })), ...state.requests].slice(0, 8);
  const statuses = { succeeded: t('common.completed'), failed: t('common.failed'), cancelled: t('console.cancelled'), running: t('console.inProgress') };
  return `<div class="section-header"><h2>${t('console.recentRequests')}</h2><p>${t('console.requestHistoryHelp')}</p></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>${t('common.model')}</th><th>${t('console.result')}</th><th>${t('console.duration')}</th><th>${t('console.tokenUsage')}</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escape(row.model)}</strong><small>${escape(timestamp(row.startedAt))}</small></td><td><span class="request-status ${row.status}">${statuses[row.status]}</span>${row.errorCode ? `<br><small>${escape(row.errorCode)}</small>` : ''}</td><td>${duration(row.durationMs / 1000)}</td><td>${row.usage ? number(row.usage.total_tokens) : t('console.notReported')}</td><td>${row.status === 'running' ? `<button class="small-button" data-action="cancel-request" data-id="${row.id}">${t('common.cancel')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty(t('console.noRecentCalls'), t('console.recentCallsHelp'), 'play')}`;
}
function exampleCode(choice) {
  if (choice?.mode && !['chat', 'image'].includes(choice.mode)) return mediaExample(state.baseUrl, choice);
  const model = choice?.id || 'connection-id/model-id';
  const endpoint = choice?.mode === 'image' ? 'images/generations' : 'chat/completions';
  const body = choice?.mode === 'image'
    ? { model, prompt: t('docs.imagePrompt') }
    : { model, messages: [{ role: 'user', content: t('docs.greetingPrompt') }] };
  return `curl ${state.baseUrl}/${endpoint} \\\n  -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
}
function snippet(choice = availableChoices()[0]) {
  const code = exampleCode(choice);
  return `<div class="code-card"><div class="between"><h3>${t('console.curlExample')}</h3><button class="small-button" data-action="copy-example">${t('console.copyButton', icon('copy'))}</button></div><pre id="example-code">${escape(code)}</pre></div>`;
}
const keyLimitLabels = { requestsPerMinute: 'usage.requestsPerMinute', maxConcurrentRequests: 'usage.concurrentRequests' };

function keyLimitFields(limits) {
  return `<div class="form-grid">${Object.entries(keyLimitLabels).map(([name, label]) =>
    `<label>${t(label)}<input name="${name}" type="number" min="1" step="1" placeholder="${t('usage.unlimited')}" value="${limits?.[name] ?? ''}"></label>`).join('')}</div>`;
}

function readKeyLimits(form) {
  return Object.fromEntries(Object.keys(keyLimitLabels).map(key => [key, form.get(key) ? Number(form.get(key)) : null]));
}

function budgetFields(budget) {
  return `<div class="form-grid">
    <label>${t('usage.monthlyBudget')}<input name="budgetAmount" type="number" min="0.000001" step="0.000001"
      placeholder="${t('usage.unlimited')}" value="${budget?.amount ?? ''}"></label>
    <label>${t('usage.currency')}<input name="budgetCurrency" maxlength="3" pattern="[A-Za-z]{3}" placeholder="CNY"
      value="${escape(budget?.currency)}"></label></div>
    <small>${t('usage.budgetHelp')}</small>`;
}

function readBudget(form) {
  if (!form.get('budgetAmount')) return null;
  const currency = form.get('budgetCurrency').trim().toUpperCase();
  if (!currency) throw new LocalizedError('errors.invalidProjectBudget');
  return { currency, amount: Number(form.get('budgetAmount')) };
}

function budgetCell(budget) {
  if (!budget) return t('usage.unlimited');
  if (!budget.available) return `<span class="tag error">${t('errors.budgetLedgerUnavailable')}</span>`;
  const fmt = value => money(value, budget.currency);
  return `<strong>${t('usage.budgetRemaining', fmt(budget.remaining), fmt(budget.amount))}</strong>
    <small>${t('usage.budgetSettled', escape(budget.period), fmt(budget.settled))}</small>
    ${budget.reserved ? `<small>${t('usage.budgetReserved', fmt(budget.reserved))}</small>` : ''}
    ${budget.unconfirmed ? `<small>${t('usage.budgetUnconfirmed', fmt(budget.unconfirmed))}</small>` : ''}`;
}

function keyTable() {
  return `<div class="table-wrap"><table><thead><tr>${['console.project', 'console.key', 'console.keyScope', 'usage.limits', 'usage.monthlyBudget', 'console.createdAt'].map(label =>
    `<th>${t(label)}</th>`).join('')}<th></th></tr></thead><tbody>${state.keys.map(key => {
    const limits = [key.limits?.requestsPerMinute && t('usage.rpmValue', number(key.limits.requestsPerMinute)),
      key.limits?.maxConcurrentRequests && t('usage.concurrentValue', number(key.limits.maxConcurrentRequests))].filter(Boolean);
    const scope = key.models.includes('*') ? `<span class="tag blue">${t('console.allPublished')}</span>`
      : key.models.map(model => `<span class="tag">${escape(modelLabel(model))}</span>`).join(' ');
    return `<tr><td><strong>${escape(key.name)}</strong></td><td><code>${escape(key.prefix)}…</code></td><td>${scope}</td>
      <td>${limits.length ? limits.join(' · ') : t('usage.unlimited')}</td><td class="key-budget">${budgetCell(key.budgetUsage)}</td><td><small>${escape(timestamp(key.createdAt))}</small></td>
      <td><div class="row wrap"><button class="quiet small-button" data-action="edit-key-limits" data-id="${escape(key.id)}">${t('usage.editLimits')}</button>
        <button class="quiet small-button" data-action="edit-key-budget" data-id="${escape(key.id)}">${t('usage.editBudget')}</button>
        <button class="quiet danger small-button" data-action="delete-key" data-id="${escape(key.id)}">${t('console.revoke')}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function keysPage() {
  return `<div class="between page-heading"><div><div class="eyebrow">${t('console.projectAccessEyebrow')}</div><h1>${t('console.projectAccessTitle')}</h1><p>${t('console.projectAccessHelp')}</p></div><button class="primary" data-action="add-key">${t('console.createKeyButton', icon('plus'))}</button></div><div class="endpoint"><div><h3>${t('console.gatewayBaseUrl')}</h3><code>${escape(state.baseUrl)}</code><p>${t('console.gatewayBaseUrlHelp')}</p></div><button data-action="copy-endpoint">${t('console.copyAddressButton', icon('copy'))}</button></div><div class="section-header"><h2>${t('common.projectKey')} <span class="muted">${state.keys.length}</span></h2></div>${state.keys.length ? keyTable() : empty(t('console.firstProjectKey'), t('console.firstProjectKeyHelp'), 'key')}<div class="info-box">${icon('info')}<div><strong>${t('console.localAppConnection')}</strong>${t('console.projectKeyHandling')}</div></div>${snippet()}`;
}

function usagePriceDialog(model) {
  if (!model) return;
  const price = model.usagePrice;
  const rates = imageModel(model) ? [['perImage', 'usage.perImage']]
    : [['inputPerMillion', 'usage.inputPrice'], ['outputPerMillion', 'usage.outputPrice']];
  const bounds = imageModel(model) ? [] : [['maxInputTokens', 'usage.budgetInputBound'], ['maxOutputTokens', 'usage.budgetOutputBound']];
  showDialog(t('usage.editPrice'), model.name, `
    <label>${t('usage.currency')}<input name="currency" value="${price?.currency || ''}" maxlength="3" pattern="[A-Za-z]{3}" placeholder="CNY"></label>
    ${rates.map(([name, label]) => `<label>${t(label)}<input type="number" min="0" step="any" name="${name}" value="${price?.[name] ?? ''}"></label>`).join('')}
    ${bounds.length ? `<div class="form-grid">${bounds.map(([name, label]) =>
      `<label>${t(label)}<input type="number" min="1" step="1" name="${name}" value="${price?.[name] ?? ''}"
        placeholder="${escape(model[name] || (name === 'maxInputTokens' ? model.contextWindow : '') || '')}" ${model[name] ? 'disabled' : ''}></label>`).join('')}</div>
      <small>${t('usage.budgetBoundsHelp')}</small>` : ''}
    ${price ? `<label class="checkbox-label"><input type="checkbox" name="removePrice">${t('usage.removePrice')}</label>` : ''}`,
  t('common.saveChanges'), async form => {
    let nextPrice = null;
    if (!form.has('removePrice')) {
      const currency = form.get('currency').trim().toUpperCase();
      if (!currency || rates.some(([name]) => form.get(name) === '')) throw new LocalizedError('usage.enterPrice');
      nextPrice = { currency, ...Object.fromEntries(rates.map(([name]) => [name, Number(form.get(name))])) };
      for (const [name] of bounds) {
        const bound = model[name] ? price?.[name] : form.get(name);
        if (bound) nextPrice[name] = Number(bound);
      }
    }
    await mutate('/admin/usage/prices', 'PATCH', { modelId: model.id, price: nextPrice });
    $('#dialog').close(); render(); toast(t('usage.priceSaved'));
  });
}
function showDialog(title, description, fields, submitLabel, callback) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="modal-heading"><h2 id="dialog-title">${escape(title)}</h2><p>${escape(description)}</p></div><form id="modal-form" class="modal-form">${fields}<div class="form-error" id="modal-error" role="alert"></div><div class="modal-actions"><button type="button" data-action="close-dialog">${t('common.cancel')}</button><button class="primary" type="submit">${escape(submitLabel)}</button></div></form>`;
  $('#modal-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('#modal-error').textContent = '';
    try { await callback(new FormData(event.target)); }
    catch (error) { if ($('#modal-error')) $('#modal-error').textContent = errorText(error); }
    finally { button.disabled = false; }
  });
  if (!dialog.open) dialog.showModal();
}

function apiServiceActionsDialog(id) {
  const connections = state.connections.filter(connection => (connection.credentialId ?? connection.id) === id && usesApiCredential(connection));
  if (!connections.length) return;
  const name = namedApiCredentials().find(credential => credential.id === id)?.name ?? connections[0].name;
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="modal-heading"><h2 id="dialog-title">${t('console.manageServices')}</h2><p>${escape(name)}</p></div>
    <ul class="service-action-list">${connections.map(connection => `<li class="between wrap">
      <strong>${escape(connection.name)}</strong>
      <div class="row wrap">
        ${connection.type === 'openai' ? `<button type="button" class="quiet small-button" data-action="add-model" data-id="${escape(connection.id)}">${t('console.registerModel')}</button>` : ''}
        ${connectionSettingsButtons(connection)}
      </div>
    </li>`).join('')}</ul>
    <div class="modal-actions"><button type="button" data-action="close-dialog">${t('common.close')}</button></div>`;
  dialog.showModal();
}

function apiCredentialDialog(id, localEntry = false) {
  const credential = state.apiCredentials?.find(item => item.id === id);
  if (id && !credential) return;
  const savedAddress = credential?.baseUrl ?? credential?.origin;
  const local = credential ? isLocalEndpoint(savedAddress) : localEntry;
  const title = local ? credential ? 'console.editConnection' : 'console.addLocalServiceConnection'
    : credential ? 'console.editApiCredential' : 'console.addApiCredential';
  const keyHelp = local ? (credential?.hasKey ? 'console.keepLocalServiceToken' : 'console.optionalLocalServiceToken')
    : (credential?.hasKey ? 'console.keepExistingKey' : 'console.optionalApiKey');
  const revision = state.revision;
  const description = local ? t('console.localServiceConnectionHelp') : credential?.connectionIds.length
    ? t('console.editApiCredentialHelp', credential.connectionIds.length) : t('console.apiCredentialHelp');
  const canClearKey = credential?.hasKey && !state.connections.some(connection => connection.type === 'mflux' && connection.credentialId === id);
  showDialog(t(title), description, `
    <label>${t(local ? 'console.connectionName' : 'console.apiCredentialName')}<input name="name" value="${escape(credential?.name || '')}" placeholder="${local ? t('services.speech') : 'MiniMax'}" maxlength="100" required></label>
    <label>Base URL<input type="url" name="baseUrl" value="${escape(savedAddress)}" ${local ? 'placeholder="http://127.0.0.1:8000/v1"' : ''} required><small>${t(local ? 'console.localServiceAddressHelp' : 'console.apiCredentialBaseHelp')}</small></label>
    <label>${local ? t('console.localServiceToken') : 'API Key'}<input name="apiKey" type="password" autocomplete="new-password" maxlength="16000"
      placeholder="${t(keyHelp)}"></label>
    ${canClearKey ? `<label class="checkbox-label"><input type="checkbox" name="clearKey">${t(local ? 'console.removeLocalServiceToken' : 'console.removeSavedKey')}</label>` : ''}`,
    t(local ? 'console.saveConnection' : 'console.saveApiCredential'), async form => {
      const input = { name: form.get('name'), baseUrl: form.get('baseUrl') };
      if (local !== isLocalEndpoint(input.baseUrl)) {
        throw new LocalizedError(local ? 'console.localServiceAddressHelp' : 'console.useLocalServiceConnection');
      }
      if (form.get('apiKey') || form.has('clearKey')) input.apiKey = form.has('clearKey') ? '' : form.get('apiKey');
      await mutate(`/admin/api-credentials${id ? `/${encodeURIComponent(id)}` : ''}`, id ? 'PATCH' : 'POST', input, revision);
      advanceSettingsDraft(revision);
      $('#dialog').close(); render(); toast(t(local ? 'console.localServiceConnectionSaved' : 'console.apiCredentialSaved'));
    });
}

function connectionLimits(existing, limit = 16, concurrency = 2) {
  return `<div class="form-grid">
    <label>${t('console.maxConcurrency')}<input name="maxConcurrency" type="number" min="1" max="${limit}" value="${existing?.maxConcurrency || concurrency}" required></label>
    <label>${t('console.requestTimeout')}<input name="timeoutSeconds" type="number" min="5" max="1800" value="${existing?.timeoutSeconds || 600}" required></label>
  </div>
  <label class="checkbox-label"><input name="enabled" type="checkbox" ${existing?.enabled !== false ? 'checked' : ''}>${t('console.enableConnection')}</label>`;
}

function connectionFields(form) {
  return { name: form.get('name'), enabled: form.has('enabled'),
    maxConcurrency: Number(form.get('maxConcurrency')), timeoutSeconds: Number(form.get('timeoutSeconds')) };
}

function suggestedServiceAddress(credential, protocol) {
  const existing = state.connections.find(connection => connection.credentialId === credential.id
    && (connection.service || connection.type) === protocol);
  if (existing) return existing.baseUrl;
  const { origin, pathname } = new URL(credential.baseUrl);
  if (['mflux', 'minimax-chat'].includes(protocol) && pathname === '/') return `${origin}/v1`;
  if (['minimax-image', 'minimax-video', 'minimax-speech'].includes(protocol) && pathname === '/v1') return origin;
  return credential.baseUrl;
}

function apiServiceDialog(existing) {
  const credentials = namedApiCredentials();
  if (!credentials.length) return;
  const providerServices = state.providers.find(provider => provider.id === 'service');
  const profiles = ['openai', 'mflux', ...(providerServices?.profiles || [])];
  const modelProfiles = new Set(providerServices?.standardModelProfiles || []);
  const selectedCredential = existing?.credentialId ?? catalogCredentialId();
  const selectedProtocol = existing ? existing.service || existing.type : '';
  const revision = state.revision;
  const endpointOptions = [false, true].map(local => {
    const options = credentials.filter(item => item.local === local).map(({ id, name, origin }) =>
      `<option value="${escape(id)}" ${id === selectedCredential ? 'selected' : ''}>${escape(name)} · ${escape(origin)}</option>`).join('');
    return options ? `<optgroup label="${t(local ? 'console.localServices' : 'console.savedApiCredential')}">${options}</optgroup>` : '';
  }).join('');
  showDialog(t(existing ? 'console.editApiService' : 'console.addApiService'), t('console.apiServiceHelp'), `
    <label>${t('console.serviceConnection')}<select name="credentialId" required>
      <option value="">${t('console.chooseServiceConnection')}</option>
      ${endpointOptions}
    </select></label>
    <label>${t('console.serviceProfile')}<select name="service" required ${existing ? 'disabled' : ''}>
      <option value="">${t('console.chooseServiceProfile')}</option>
      ${profiles.map(profile => `<option value="${escape(profile)}" ${profile === selectedProtocol ? 'selected' : ''}>${escape(t(`services.${profile}`))}</option>`).join('')}
    </select></label>
    <label>${t('console.apiServiceName')}<input name="name" value="${escape(existing?.name || '')}" maxlength="100" required></label>
    <label>Base URL<input type="url" name="baseUrl" value="${escape(existing?.baseUrl || '')}" required>
      <small id="service-base-help">${t(selectedProtocol === 'mflux' ? 'console.mfluxBaseUrlHelp' : 'console.apiBaseUrlHelp')}</small></label>
    <div id="service-upstream-model" ${modelProfiles.has(selectedProtocol) ? '' : 'hidden'}><label>${t('console.upstreamModelId')}
      <input name="upstreamModel" maxlength="300" value="${escape(existing?.upstreamModel || '')}">
      <small>${t('console.upstreamModelHelp')}</small></label></div>
    ${connectionLimits(existing, providerTypes[existing?.type]?.concurrencyLimit)}`, t('console.saveConnection'), async form => {
    const protocol = existing ? selectedProtocol : form.get('service');
    const type = ['openai', 'mflux'].includes(protocol) ? protocol : 'service';
    const input = { ...connectionFields(form), credentialId: form.get('credentialId'), baseUrl: form.get('baseUrl'),
      type, ...(type === 'service' && { service: protocol }),
      ...(modelProfiles.has(protocol) && { upstreamModel: form.get('upstreamModel').trim() }) };
    await mutate(`/admin/connections${existing ? `/${encodeURIComponent(existing.id)}` : ''}`, existing ? 'PATCH' : 'POST', input, revision);
    advanceSettingsDraft(revision);
    if (!existing) {
      modelSearch = '';
      modelFilter = 'all';
      if (catalogCredentialId() && catalogCredentialId() !== input.credentialId) {
        const params = new URLSearchParams({ view: 'models', credential: input.credentialId });
        history.replaceState(null, '', `${location.pathname}?${params}`);
      }
    }
    $('#dialog').close(); render(); toast(t('console.connectionSaved'));
  });
  const { baseUrl, credentialId, service, maxConcurrency } = $('#modal-form').elements;
  let suggested = existing?.baseUrl || '';
  let suggestedConcurrency = 2;
  const updateAddress = () => {
    const credential = credentials.find(item => item.id === credentialId.value);
    const next = credential ? suggestedServiceAddress(credential, service.value) : '';
    if (!baseUrl.value || baseUrl.value === suggested) baseUrl.value = next;
    suggested = next;
  };
  credentialId.addEventListener('change', updateAddress);
  service.addEventListener('change', () => {
    const isMflux = service.value === 'mflux';
    const limit = isMflux ? providerTypes.mflux.concurrencyLimit : 16;
    const nextDefault = isMflux ? limit : 2;
    maxConcurrency.max = String(limit);
    if (maxConcurrency.valueAsNumber === suggestedConcurrency || maxConcurrency.valueAsNumber > limit) maxConcurrency.value = String(nextDefault);
    suggestedConcurrency = nextDefault;
    $('#service-base-help').textContent = t(isMflux ? 'console.mfluxBaseUrlHelp' : 'console.apiBaseUrlHelp');
    $('#service-upstream-model').hidden = !modelProfiles.has(service.value);
    updateAddress();
  });
  if (!existing) updateAddress();
}

function localConnectionDialog(typeId, existing) {
  const type = providerType(typeId);
  showDialog(existing ? t('console.editConnection') : t('console.addConnectionTitle', type.name), typeId === 'codex' ? t('console.codexConnectionHelp') : t('console.connectionDiscoveryHelp'), `
    <label>${t('console.connectionName')}<input name="name" value="${escape(existing?.name || type.defaultName)}" required maxlength="100"></label>
    ${typeId !== 'codex' ? `<label>Base URL<input type="url" name="baseUrl" value="${escape(existing?.baseUrl || type.baseUrl)}" required><small>${t(type.baseHelp)}</small></label><label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${t(existing?.hasKey ? 'console.keepExistingKey' : 'console.ollamaKeyHelp')}">${existing?.hasKey ? `<small>${t('console.removeKeyHelp')}</small>` : ''}</label>${existing?.hasKey ? `<label class="checkbox-label"><input type="checkbox" name="clearKey">${t('console.removeSavedKey')}</label>` : ''}` : `<div class="info-box">${t('console.codexIsolationHelp')}</div>`}
    ${connectionLimits(existing, type.concurrencyLimit, typeId === 'codex' ? 1 : type.concurrencyLimit)}`, t('console.saveConnection'), async form => {
    const input = { ...connectionFields(form), type: typeId };
    if (typeId !== 'codex') {
      input.baseUrl = form.get('baseUrl');
      if (form.get('apiKey') || form.has('clearKey') || !existing) input.apiKey = form.has('clearKey') ? '' : form.get('apiKey');
    }
    await mutate(`/admin/connections${existing ? `/${existing.id}` : ''}`, existing ? 'PATCH' : 'POST', input);
    $('#dialog').close(); render(); toast(t('console.connectionSaved'));
  });
}
function releasePlayMedia() {
  if (playMediaUrl) window.URL.revokeObjectURL(playMediaUrl);
  playMediaUrl = undefined;
}

function showPlayVideo(form, job = lastPlayVideo) {
  const section = $('#play-video-job');
  const visible = form.elements.endpoint.value === 'video' && job;
  section.hidden = !visible;
  if (!visible) return;
  if ($('#play-video-id').textContent !== job.id) $('#play-video-id').textContent = job.id;
  const progress = $('#play-video-progress');
  const pending = job.status === 'queued' || job.status === 'in_progress';
  progress.hidden = !pending || (!generation && !(job.progress > 0));
  if (Number.isFinite(job.progress) && job.progress > 0) progress.value = job.progress;
  else progress.removeAttribute('value');
  $('[data-action="resume-video"]').hidden = Boolean(generation || job.status === 'failed' || playDrafts.get(form).response?.file);
  if (!playDrafts.get(form).response) {
    const status = t(videoStatus(job));
    if ($('#response-status').textContent !== status) $('#response-status').textContent = status;
  }
}

async function generate(form, resume = false) {
  const draft = playDrafts.get(form);
  if (generation || !draft || draft.reading) return;
  const fields = new FormData(form);
  const model = modelById(fields.get('model'));
  const mode = form.elements.endpoint.value;
  const resumed = resume && mode === 'video' && lastPlayVideo?.status !== 'failed' ? lastPlayVideo : undefined;
  if (resume && !resumed || !resume && (!model || playgroundMode(model) !== mode)) return;
  const image = mode === 'image';
  const media = !['chat', 'image'].includes(mode);
  const streaming = mode === 'chat' && fields.has('stream');
  const prompt = fields.get('prompt');
  const ratio = fields.get('aspect_ratio');
  const limit = model?.maxReferenceImages ?? maxImageReferences;
  const references = limit > 0 ? draft.references : [];
  if (image && references.length > limit) { toast(t('console.tooManyReferences', limit), true); return; }
  const body = media ? undefined : image ? { model: model.id, prompt, ...(ratio ? { [model.imageSizes ? 'size' : 'aspect_ratio']: ratio } : {}),
    ...(fields.has('transparent_background') ? { background: 'transparent' } : {}),
    ...(references.length ? { reference_images: references.map(item => item.url) } : {}) } : {
    model: fields.get('model'), messages: [{ role: 'user', content: prompt }], stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {})
  };
  const controller = new AbortController(); generation = controller;
  form.elements.model.disabled = form.elements.endpoint.disabled = true;
  $('#send-button').disabled = true; $('#stop-button').disabled = false;
  $('#play-image-options').disabled = true;
  for (const fieldset of form.querySelectorAll('[data-play-mode]')) fieldset.disabled = true;
  const continueButton = $('[data-action="continue-image"]');
  continueButton.hidden = true;
  draft.result = draft.response = null;
  releasePlayMedia();
  $('#play-media-download').hidden = true;
  const output = $('#response-output'); output.className = 'response'; output.textContent = '';
  showPlayVideo(form, resumed || null);
  $('#response-status').textContent = t(image ? 'console.generatingImage' : mode === 'video' && !resumed ? 'console.testVideoSubmitting' : 'console.requestInProgress');
  $('#response-meta').textContent = t('console.waitingForModel');
  let measurement, imageMeta, file, failure, status = 'common.completed', content = '', ended = false;
  const started = performance.now();
  try {
    if (media) {
      const result = await generateMedia({ mode, model, fields, signal: controller.signal, api, job: resumed,
        onVideo: job => { lastPlayVideo = job; showPlayVideo(form); },
        onDownload: () => { $('#response-meta').textContent = t('console.testLoadingVideo'); } });
      controller.signal.throwIfAborted();
      content = result.content || '';
      if (result.file) {
        playMediaUrl = window.URL.createObjectURL(result.file.blob);
        file = { element: result.file.element, filename: result.file.filename, url: playMediaUrl };
      }
    } else if (image) {
      const result = await api('/v1/images/generations', { method: 'POST', body, signal: controller.signal });
      const { b64_json: b64, width, height } = result.data?.[0] || {};
      if (!['png', 'jpeg', 'webp'].includes(result.output_format) || typeof b64 !== 'string' || !b64) {
        throw new LocalizedError('console.invalidImageResult');
      }
      const preview = document.createElement('img');
      preview.alt = t('console.generatedImage');
      const url = `data:image/${result.output_format};base64,${b64}`;
      preview.src = url;
      await preview.decode();
      controller.signal.throwIfAborted();
      const size = b64.length / 4 * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      draft.result = { generated: true, size, url };
      imageMeta = { width: width || preview.naturalWidth, height: height || preview.naturalHeight, format: result.output_format.toUpperCase() };
      output.append(preview);
      continueButton.hidden = limit === 0;
    } else {
      const response = await api('/v1/chat/completions', { method: 'POST', body, signal: controller.signal }, streaming);
      if (streaming) {
        for await (const data of sse(response.body)) {
          if (data === '[DONE]') { ended = true; break; }
          const chunk = JSON.parse(data); if (chunk.error) throw chunk.error;
          const delta = chunk.choices?.[0]?.delta;
          content += delta?.refusal || delta?.content || ''; output.textContent = content; output.scrollTop = output.scrollHeight;
          if (chunk.usage) measurement = chunk.usage;
        }
        if (!ended) throw new LocalizedError('common.streamIncomplete');
      } else {
        const message = response.choices?.[0]?.message;
        content = message?.refusal || message?.content || ''; measurement = response.usage;
      }
    }
  } catch (error) {
    status = controller.signal.aborted ? mode === 'video' ? 'console.testVideoWaitingStopped' : 'common.stopped' : 'common.failed';
    if (!controller.signal.aborted) { failure = error; toast(errorText(error), true); }
  } finally {
    generation = null; form.elements.endpoint.disabled = false; $('#stop-button').disabled = true;
    draft.response = { status, seconds: (performance.now() - started) / 1000, usage: measurement, image: imageMeta, content, failure, mode, file };
    updatePlayModel(form);
    showPlayResponse(draft.response, output);
    showPlayVideo(form);
    try { await load(false); } catch {}
  }
}
function showPlayResponse(response, output = $('#response-output')) {
  const { status, mode, image, content, failure, seconds, file } = response;
  const download = $('#play-media-download');
  download.hidden = !file;
  if (!file) download.removeAttribute('href');
  $('#response-status').textContent = t(status);
  $('#response-meta').textContent = mode === 'chat' || image ? requestMetadata(response) : duration(seconds);
  output.classList.remove('empty-output');
  output.classList.toggle('image-output', mode === 'image');
  output.classList.toggle('media-output', Boolean(file));
  output.classList.toggle('json-output', mode === 'embeddings' && !failure);
  if (failure) {
    const message = errorText(failure);
    output.textContent = content ? t('console.partialResponseFailure', content, message) : message;
  } else if (file) {
    const player = document.createElement(file.element);
    const video = file.element === 'video';
    player.controls = true;
    player.preload = 'metadata';
    if (video) player.playsInline = true;
    player.setAttribute('aria-label', t(video ? 'console.testGeneratedVideo' : 'console.testGeneratedAudio'));
    player.addEventListener('error', () => {
      const detail = document.createElement('p');
      detail.textContent = t('console.testMediaPlaybackFailed');
      output.append(detail);
    }, { once: true });
    player.src = file.url;
    output.replaceChildren(player);
    download.href = file.url;
    download.download = file.filename;
    download.textContent = t(video ? 'console.testDownloadVideo' : 'console.testDownloadAudio');
  } else if (!image) {
    const stopped = status === 'common.stopped' || status === 'console.testVideoWaitingStopped';
    output.textContent = stopped && mode !== 'chat' ? t(mode === 'video' && lastPlayVideo ? 'console.testResumeVideoHelp' : 'console.requestStopped') : content;
  }
}

function updatePlayMode(form, selected = '') {
  const mode = form.elements.endpoint.value;
  lastPlayMode = mode;
  const options = availableChoices().filter(choice => choice.mode === mode).map(choice => {
    const label = choice.requiresBinding ? t('console.testModelNeedsBinding', choice.name) : choice.name;
    return Object.assign(new window.Option(label, choice.id), { disabled: choice.requiresBinding });
  });
  const first = options.find(option => !option.disabled);
  if (!first) options.unshift(new window.Option(t(options.length ? 'errors.upstreamModelRequired' : 'console.publishFirst'), ''));
  form.elements.model.replaceChildren(...options);
  form.elements.model.value = options.some(option => !option.disabled && option.value === selected) ? selected : first?.value || '';
  updatePlayModel(form);
}

function updatePlayModel(form) {
  const model = modelById(form.elements.model.value);
  const mode = form.elements.endpoint.value;
  const image = mode === 'image';
  const draft = playDrafts.get(form);
  $('#play-image-options').hidden = $('#play-image-options').disabled = !image;
  $('#play-stream').hidden = mode !== 'chat';
  $('#stop-button').textContent = t(mode === 'video' ? 'console.testStopWaiting' : 'common.stop');
  $('#send-button').disabled = form.elements.model.disabled = !model;
  const prompt = form.elements.prompt;
  $('#play-prompt').hidden = prompt.disabled = mode === 'transcription';
  $('#play-prompt > span').textContent = t(['speech', 'embeddings'].includes(mode) ? 'console.testInputText' : 'console.prompt');
  prompt.placeholder = t(mode === 'video' ? 'docs.videoPrompt' : ['speech', 'embeddings'].includes(mode) ? 'docs.greetingPrompt' : 'console.textPromptExample');
  const selector = form.elements.aspect_ratio;
  const previous = selector.value;
  const sizes = model?.imageSizes;
  $('#play-size-label').textContent = t(sizes ? 'console.imageSize' : 'console.aspectRatio');
  selector.innerHTML = `<option value="">${t('console.automatic')}</option>` + (sizes || imageAspectRatios).map(value =>
    `<option value="${escape(value)}">${sizes ? escape(value) : t(imageRatioLabels[value])}</option>`).join('');
  if (Array.from(selector.options).some(option => option.value === previous)) selector.value = previous;
  const background = form.elements.transparent_background;
  background.disabled = Boolean(sizes);
  background.closest('label').hidden = Boolean(sizes);
  const limit = model?.maxReferenceImages ?? maxImageReferences;
  $('[data-action="continue-image"]').hidden = !image || !limit || !draft.result;
  if (image) renderImageReferences(form);
  if (image || mode === 'video') prompt.maxLength = 4000;
  else if (mode === 'speech') prompt.maxLength = model?.service === 'edge-tts' ? 2000 : 4096;
  else prompt.removeAttribute('maxlength');
  const upstream = state.connections.find(connection => connection.id === model?.connectionId)?.upstreamModel;
  updateMediaFields(form, mode, model, upstream);
  $('#example-code').textContent = exampleCode({ id: form.elements.model.value, mode, service: model?.service, upstream });
}
document.addEventListener('change', event => {
  if (event.target.matches('#play-form [name="image_files"]')) {
    void addImageReferences(event.target).catch(error => toast(errorText(error), true));
    return;
  }
  if (event.target.matches('#play-form select[name="endpoint"]')) {
    const form = event.target.form;
    const draft = playDrafts.get(form);
    releasePlayMedia();
    draft.response = draft.result = null;
    draft.editing = false;
    $('#response-status').textContent = t('console.awaitingRequest');
    $('#response-meta').textContent = '';
    const output = $('#response-output');
    output.className = 'response empty-output';
    output.textContent = t('console.responsePlaceholder');
    $('#play-media-download').hidden = true;
    updatePlayMode(form, event.target.value === 'video' ? lastPlayVideo?.model : undefined);
    showPlayVideo(form);
  } else if (event.target.matches('#play-form select[name="model"]')) {
    playDrafts.get(event.target.form).editing = false;
    updatePlayModel(event.target.form);
  }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'catalog-search') return;
  modelSearch = event.target.value;
  $('#catalog-table').innerHTML = modelTable();
  applyCatalogWidths();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const more = event.target.closest?.('.provider-more[open]');
    if (more) {
      more.open = false;
      more.querySelector('summary').focus();
    }
  }
  const column = catalogColumns.find(item => item.key === event.target.dataset?.catalogColumn);
  if (!column || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8);
  resizeCatalogColumn(column, event.key === 'Home' ? column.width : catalogWidth(column) + delta);
  rememberCatalogWidths();
});
document.addEventListener('dblclick', event => {
  const column = catalogColumns.find(item => item.key === event.target.dataset?.catalogColumn);
  if (!column) return;
  resizeCatalogColumn(column, column.width);
  rememberCatalogWidths();
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const handle = event.target.closest('[data-catalog-column]');
  const column = catalogColumns.find(item => item.key === handle?.dataset.catalogColumn);
  if (!column) { startCatalogScroll(event); return; }
  event.preventDefault();
  handle.focus({ preventScroll: true });
  const { pointerId, clientX } = event;
  const width = catalogWidth(column);
  handle.setPointerCapture?.(pointerId);
  handle.dataset.resizing = '';
  function move(next) {
    if (next.pointerId !== pointerId) return;
    resizeCatalogColumn(column, width + next.clientX - clientX);
  }
  function stop(next) {
    if (next.pointerId !== undefined && next.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    delete handle.dataset.resizing;
    rememberCatalogWidths();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
});

function startCatalogScroll(event) {
  const manager = event.target.closest('.catalog-manager');
  if (!manager || event.pointerType === 'touch' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.target.closest('.catalog-grid, a, button, input, summary, label, [contenteditable]')) return;
  const scroller = $('#catalog-table');
  if (scroller.scrollWidth <= scroller.clientWidth) return;
  const { pointerId, clientX, clientY } = event;
  const initial = scroller.scrollLeft;
  let dragging = false;
  function move(next) {
    if (next.pointerId !== pointerId) return;
    if (!scroller.isConnected) { stop(); return; }
    const distance = next.clientX - clientX;
    if (!dragging && Math.abs(distance) < 6) return;
    if (!dragging && Math.abs(distance) <= Math.abs(next.clientY - clientY)) { stop(); return; }
    dragging = true;
    manager.classList.add('catalog-scrolling');
    next.preventDefault();
    scroller.scrollLeft = initial - distance;
  }
  function stop(next) {
    if (next?.pointerId !== undefined && next.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
    manager.classList.remove('catalog-scrolling');
  }
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
}

document.addEventListener('submit', async event => {
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const nextToken = new FormData(event.target).get('token').trim();
    if (nextToken !== token) {
      settingsDraft = undefined;
      settingsError = '';
      rememberSettings();
    }
    manualToken = token = nextToken;
    try { await load(); sessionStorage.setItem(manualTokenKey, manualToken); } catch (error) { login(error, true); }
  } else if (event.target.id === 'play-form') { event.preventDefault(); void generate(event.target); }
});
document.addEventListener('click', async event => {
  const more = $('.provider-more[open]');
  if (more && !more.contains(event.target)) more.open = false;
  if (event.target.closest('[data-mm]')) return;
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.language) { changeLanguage(button.dataset.language); return; }
  if (button.dataset.view) {
    if (generation) { toast(t('common.waitForRequest')); return; }
    view = button.dataset.view;
    const params = new URLSearchParams({ view });
    if (button.dataset.credential) {
      params.set('credential', button.dataset.credential);
      modelSearch = '';
      modelFilter = 'all';
    }
    history.pushState(null, '', `${location.pathname}?${params}`);
    renderView();
    return;
  }
  const action = button.dataset.action, id = button.dataset.id;
  if (!action) return;
  if ((busy || catalogRefresh) && !['close-dialog', 'stop', 'catalog-filter', 'model-details'].includes(action)) {
    return toast(t('common.busy'));
  }
  try {
    if (button.closest('.service-action-list')) $('#dialog').close();
    if (action === 'add-reference') { button.form.elements.image_files.click(); return; }
    if (['move-reference-up', 'move-reference-down', 'remove-reference', 'continue-image'].includes(action)) {
      if (!generation && !playDrafts.get($('#play-form')).reading) changeImageReferences(button);
      return;
    }
    if (action === 'resume-video') { void generate($('#play-form'), true); return; }
    if (action === 'close-dialog') $('#dialog').close();
    if (action === 'refresh') { await load(); toast(t('console.statusRefreshed')); }
    if (action === 'add-pool') poolDialog();
    if (action === 'edit-pool') {
      const pool = state.pools?.find(item => item.id === id);
      if (pool) poolDialog(pool);
    }
    if (action === 'delete-pool') {
      const pool = state.pools?.find(item => item.id === id);
      if (!pool) return;
      const revision = state.revision;
      showDialog(t('pools.remove'), t('pools.removeHelp', pool.name), '', t('pools.remove'), async () => {
        await mutate(`/admin/pools/${encodeURIComponent(id)}`, 'DELETE', {}, revision);
        advanceSettingsDraft(revision);
        $('#dialog').close(); render(); toast(t('console.actionComplete'));
      });
    }
    if (action === 'logout') {
      if (generation) { toast(t('common.waitForRequest')); return; }
      const sessions = new Set([readConsoleSession(), consoleSession].filter(Boolean));
      if (sessions.size) {
        busy = true;
        try {
          await Promise.all([...sessions].map(session => api('/console/session', {
            method: 'DELETE', headers: { authorization: `Bearer ${session}` }
          })));
        } finally { busy = false; }
        for (const session of sessions) clearConsoleSession(session);
      }
      token = '';
      manualToken = consoleSession = '';
      sessionStorage.removeItem(manualTokenKey);
      settingsDraft = undefined;
      settingsError = catalogNotice = '';
      rememberSettings();
      state = null;
      login();
    }
    if (action === 'copy-endpoint') { await navigator.clipboard.writeText(state.baseUrl); toast(t('common.addressCopied')); }
    if (action === 'copy-example') { await navigator.clipboard.writeText($('#example-code').textContent); toast(t('console.connectionExampleCopied')); }
    if (action === 'copy-api-example') { await navigator.clipboard.writeText(document.getElementById(button.dataset.codeId).textContent); toast(t('common.apiExampleCopied')); }
    if (action === 'add-connection') {
      if (more?.contains(button)) {
        more.open = false;
        more.querySelector('summary').focus();
      }
      localConnectionDialog(button.dataset.type);
    }
    if (action === 'add-api-credential') apiCredentialDialog();
    if (action === 'add-local-endpoint') apiCredentialDialog(undefined, true);
    if (action === 'add-api-service') apiServiceDialog();
    if (action === 'manage-api-services') apiServiceActionsDialog(id);
    if (action === 'edit-api-credential') apiCredentialDialog(id);
    if (action === 'delete-api-credential') {
      const credential = state.apiCredentials.find(item => item.id === id);
      if (!credential) return;
      const revision = state.revision;
      showDialog(t(isLocalEndpoint(credential.baseUrl) ? 'console.removeConnection' : 'console.removeApiCredential'), credential.name, '', t('console.remove'), async () => {
        await mutate(`/admin/api-credentials/${encodeURIComponent(id)}`, 'DELETE', {}, revision);
        advanceSettingsDraft(revision);
        $('#dialog').close(); render(); toast(t('console.actionComplete'));
      });
    }
    if (action === 'edit-connection') {
      const connection = state.connections.find(item => item.id === id);
      if (usesApiCredential(connection)) apiServiceDialog(connection);
      else localConnectionDialog(connection.type, connection);
    }
    if (action === 'catalog-filter') {
      modelFilter = button.dataset.value;
      render();
      $('.catalog-filters [aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    if (action === 'refresh-catalog') await refreshModelServices();
    if (action === 'check-credential') await refreshModelServices(id);
    if (action === 'revert-publication') {
      settingsDraft = undefined;
      settingsError = '';
      catalogNotice = 'console.draftDiscarded';
      rememberSettings();
      render();
    }
    if (action === 'model-details') {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      const connection = state.connections.find(item => item.id === model.connectionId);
      const { enabled, reasoningPolicy } = draftModelSettings(model);
      const { declared, opened, selected, defaultEffort, obsolete } = reasoningLevels(model, reasoningPolicy);
      const canEditEfforts = declared.length && enabled && connection?.enabled && model.available !== false;
      const canClearEfforts = obsolete && !canEditEfforts && !busy && !catalogRefresh;
      const models = state.models.filter(item => item.connectionId === model.connectionId);
      const health = connectionHealth(connection, models);
      const lastCall = recentModelCall(model.connectionId, model.nativeId);
      const category = catalogCategory(connection, model);
      const formatTokens = value => Number.isSafeInteger(value) && value > 0 ? `${number(value)} tokens` : null;
      const fields = [
        [t('common.credentialService'), connection?.name],
        [t('common.modelId'), model.nativeId],
        [t('console.gatewayModelId'), model.id],
        [t('console.modelCapabilities'), modelTags(model, category).join(languageSeparator())],
        [t('console.connectionStatus'), [health.label, health.detail].filter(Boolean).join(' · ')],
        [t('console.lastCheckLabel'), connection?.checkedAt ? timestamp(connection.checkedAt) : null],
        ...(lastCall ? [[t('console.lastRequest'), `${lastCall.status === 'succeeded' ? t('console.succeeded') : t('common.failed')} · ${timestamp(lastCall.startedAt)}`]] : []),
        ...(category === 'content_ai' ? [
          [t('console.maxInput'), formatTokens(model.maxInputTokens)],
          [t('console.maxOutput'), formatTokens(model.maxOutputTokens)],
          [t('console.contextWindow'), formatTokens(model.contextWindow)]
        ] : []),
        [t('common.allowedEfforts'), opened.join(languageSeparator())],
        ...(opened.length !== selected.length ? [[t('console.selectableEfforts'), selected.join(languageSeparator())]] : []),
        [t('common.defaultEffort'), defaultEffort || (selected.length ? t('console.providerDefault') : null)]
      ];
      const details = `<dl class="catalog-details">${fields.map(([label, value]) => `<dt>${label}</dt><dd>${escape(value || catalogDash)}</dd>`).join('')}</dl>`;
      const price = model.usagePrice;
      const rates = [['usage.inputPrice', price?.inputPerMillion], ['usage.outputPrice', price?.outputPerMillion], ['usage.perImage', price?.perImage]]
        .filter(([, value]) => Number.isFinite(value));
      const prices = `<h3 class="catalog-price-heading">${t('usage.prices')}</h3>${rates.length
        ? `<dl class="catalog-details">${rates.map(([label, value]) => `<dt>${t(label)}</dt><dd>${escape(money(value, price.currency))}</dd>`).join('')}</dl>`
        : `<p class="catalog-muted">${t('console.noConfiguredModelPrice')}</p>`}`;
      const recovery = canClearEfforts ? `<p class="catalog-warning">${t('console.invalidEffortHelp')}</p>` : '';
      showDialog(t('console.modelDetailsAndPrice'), model.name, details + prices + recovery, canClearEfforts ? t('console.clearInvalidEfforts') : t('common.close'), async () => {
        $('#dialog').close();
        if (canClearEfforts) changeModelSettings(model, { reasoningPolicy: null });
      });
    }
    if (action === 'discover') {
      const revision = state.revision;
      button.disabled = true; button.textContent = t('console.discovering');
      try {
        await mutate(`/admin/connections/${encodeURIComponent(id)}/discover`, 'POST');
      } catch (error) {
        if (state.connections.some(connection => connection.id === id && connection.status === 'error' && connection.errorCode === error.code)) {
          advanceSettingsDraft(revision);
        }
        throw error;
      }
      advanceSettingsDraft(revision);
      render(); toast(t('console.discoveryComplete'));
    }
    if (action === 'add-model') showDialog(t('console.registerModel'), t('console.manualModelHelp'), `<label>${t('common.modelId')}<input name="nativeId" placeholder="${t('console.providerModelId')}" required></label><label>${t('console.optionalDisplayName')}<input name="name" placeholder="${t('console.displayNamePlaceholder')}"></label>`, t('console.addModel'), async form => {
      await mutate('/admin/models', 'POST', { connectionId: id, ...Object.fromEntries(form) }); $('#dialog').close(); render(); toast(t('console.modelAdded'));
    });
    if (['publish-model', 'toggle-open-effort', 'toggle-model-effort', 'pin-model-effort', 'reset-model-efforts'].includes(action)) {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      if (action === 'publish-model') changeModelSettings(model, { enabled: !draftModelSettings(model).enabled });
      else if (action === 'reset-model-efforts') resetModelEfforts(model);
      else if (action === 'toggle-open-effort') changeOpenEffort(model, button.dataset.level);
      else changeModelEffort(model, button.dataset.level, action === 'pin-model-effort');
    }
    if (action === 'save-publication' && settingsDraft) {
      const { revision, changes } = settingsDraft;
      const models = state.models.map(model => ({ id: model.id, enabled: model.enabled, ...changes.get(model.id) }));
      const saving = mutate('/admin/model-settings', 'PATCH', { models }, revision);
      render();
      await saving;
      settingsDraft = undefined;
      settingsError = '';
      catalogNotice = 'console.allChangesSaved';
      rememberSettings();
      render();
    }
    if (action === 'add-key') {
      const choices = availableChoices();
      showDialog(t('console.createKeyTitle'), t('console.createKeyHelp'), `<label>${t('console.projectName')}<input name="name" placeholder="${t('console.projectNameExample')}" required></label><label>${t('console.authorizedModels')}</label><div class="checklist">${choices.map(item => `<label class="checkbox-label"><input type="checkbox" name="models" value="${escape(item.id)}">${escape(item.name)}</label>`).join('')}<label class="checkbox-label"><input type="checkbox" name="models" value="*">${t('console.allPublishedFuture')}</label></div>${keyLimitFields()}${budgetFields()}`, t('console.createKey'), async form => {
        const result = await mutate('/admin/keys', 'POST', { name: form.get('name'), models: form.getAll('models'), limits: readKeyLimits(form), budget: readBudget(form) });
        $('#dialog').close(); render();
        showDialog(t('console.saveNewKey'), t('console.saveNewKeyHelp'), `<div class="token-box"><code id="new-token">${escape(result.token)}</code></div><button type="button" data-action="copy-token">${t('console.copyKeyButton', icon('copy'))}</button>`, t('console.confirmKeySaved'), async () => { $('#dialog').close(); });
      });
    }
    if (action === 'edit-key-limits') {
      const key = state.keys.find(item => item.id === id);
      if (!key) return;
      showDialog(t('usage.editLimits'), t('usage.keyLimitsHelp', key.name), keyLimitFields(key.limits), t('common.saveChanges'), async form => {
        await mutate(`/admin/keys/${encodeURIComponent(id)}`, 'PATCH', { limits: readKeyLimits(form) });
        $('#dialog').close(); render(); toast(t('usage.limitsSaved'));
      });
    }
    if (action === 'edit-key-budget') {
      const key = state.keys.find(item => item.id === id);
      if (!key) return;
      showDialog(t('usage.editBudget'), key.name, budgetFields(key.budget), t('common.saveChanges'), async form => {
        await mutate(`/admin/keys/${encodeURIComponent(id)}`, 'PATCH', { budget: readBudget(form) });
        $('#dialog').close(); render(); toast(t('usage.budgetSaved'));
      });
    }
    if (action === 'copy-token') { await navigator.clipboard.writeText($('#new-token').textContent); toast(t('console.projectKeyCopied')); }
    if (['delete-connection', 'delete-key'].includes(action)) {
      const key = action === 'delete-key';
      const connection = key ? null : state.connections.find(item => item.id === id);
      const help = key ? 'console.revokeKeyHelp' : usesApiCredential(connection) ? 'console.removeApiServiceHelp' : 'console.removeConnectionHelp';
      showDialog(t(key ? 'console.revokeKey' : 'console.removeConnection'), t(help), '', t('console.confirmAction'), async () => {
        await mutate(`/admin/${key ? 'keys' : 'connections'}/${encodeURIComponent(id)}`, 'DELETE'); $('#dialog').close(); render(); toast(t('console.actionComplete'));
      });
    }
    if (action === 'stop') generation?.abort();
    if (action === 'cancel-request') { await api(`/admin/requests/${id}/cancel`, { method: 'POST', body: {} }); await load(); toast(t('console.cancellationSent')); }
  } catch (error) {
    if (action === 'save-publication') {
      settingsError = error.code === 'reasoning_policy_conflict'
        ? t('console.reasoningConflictWithDraft') : t('console.settingsErrorWithDraft', errorText(error));
    }
    toast(errorText(error), true);
    if (['discover', 'save-publication'].includes(action)) render();
  }
  finally { button.disabled = false; }
});
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
try {
  if (fragment.has('session')) await useConsoleLink(fragment.get('session'));
  if (token) await load();
  else login();
} catch (error) {
  if (token && fragment.has('session') && error.code === 'console_link_expired') {
    try { await load(); } catch (loadError) { login(loadError); }
  } else login(error);
}
const refreshTimer = setInterval(async () => {
  if (!token || !state || busy || catalogRefresh || generation || $('#dialog').open || document.visibilityState !== 'visible' || view === 'playground') return;
  const currentToken = token;
  try {
    const next = await api('/admin/state');
    if (currentToken !== token || busy || catalogRefresh || generation || $('#dialog').open || view === 'playground' || next.revision < state.revision) return;
    const runtimeChanged = next.requests[0]?.id !== state.requests[0]?.id
      || next.active.map(row => row.id).join() !== state.active.map(row => row.id).join();
    const poolStatus = snapshot => snapshot.pools?.flatMap(pool => pool.members.map(member => member.cooldownUntil)).join();
    const budgets = snapshot => JSON.stringify(snapshot.keys.map(key => key.budgetUsage));
    const changed = next.revision !== state.revision || view === 'models' && (runtimeChanged || poolStatus(next) !== poolStatus(state))
      || view === 'keys' && budgets(next) !== budgets(state);
    state = next;
    if (changed) render();
  } catch {}
}, 15_000);
const popstate = () => { const next = new URLSearchParams(location.search).get('view') || 'connections'; if (views[next] && !generation) { view = next; renderView(); } };
const consoleLinkChanged = () => {
  if (new URLSearchParams(location.hash.slice(1)).has('session')) location.reload();
};
window.addEventListener('popstate', popstate);
window.addEventListener('hashchange', consoleLinkChanged);
export function dispose() {
  clearInterval(refreshTimer);
  clearTimeout(toastTimer);
  generation?.abort();
  releasePlayMedia();
  usage.detach();
  window.removeEventListener('popstate', popstate);
  window.removeEventListener('hashchange', consoleLinkChanged);
}
