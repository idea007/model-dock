import { sse } from './events.mjs';
import { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes } from './image-options.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const imageModel = model => model?.capability === 'image_generation';
const playImages = new WeakMap();
const imageRatioLabels = { '16:9': '横版 16:9', '9:16': '竖版 9:16', '1:1': '方图 1:1', '4:5': '竖版 4:5' };
const referenceFormats = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
const icons = {
  dock: '<path d="M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  models: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-5-5 3-3m-1 5 3-3"/>',
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
const types = {
  openai: { name: '模型 API', icon: 'cloud', description: '接入支持 OpenAI 格式的模型服务。', addLabel: '添加 API 连接', defaultName: '我的模型 API', baseUrl: 'https://api.openai.com/v1' },
  ollama: { name: 'Ollama', icon: 'computer', description: '发现并使用 Ollama 上已安装的模型。', addLabel: '添加 Ollama', defaultName: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434' },
  codex: { name: 'Codex', icon: 'terminal', description: '连接本机已登录的 Codex CLI。', addLabel: '添加 Codex', defaultName: '本机 Codex', baseUrl: '' }
};
const views = { connections: ['连接与凭证', 'plug'], models: ['模型与服务', 'models'], playground: ['调用测试', 'play'], keys: ['项目访问', 'key'] };
const settingsKey = 'model-dock-publication-draft';
const storedSessionKey = 'model-dock-console-session';
const manualTokenKey = 'model-dock-token';
let settingsDraft, settingsError = '';
let catalogRefresh, catalogNotice = '';
const catalogColumns = [
  { key: 'provider', label: '凭证 / 服务', width: 152, min: 120 },
  { key: 'model', label: '模型', width: 256, min: 180 }
];
const catalogWidths = new Map();
try {
  const stored = JSON.parse(sessionStorage.getItem('model-dock-catalog-columns') || '{}');
  for (const column of catalogColumns) {
    if (Number.isFinite(stored?.[column.key])) catalogWidths.set(column.key, catalogWidth(column, stored[column.key]));
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
      if (policy === null || Array.isArray(policy?.allowedEfforts) && policy.allowedEfforts.every(level => typeof level === 'string') && typeof policy.defaultEffort === 'string') {
        patch.reasoningPolicy = policy;
      }
      if (Object.keys(patch).length) changes.set(id, patch);
    }
    if (changes.size) settingsDraft = { revision: saved.revision, changes };
  }
} catch { sessionStorage.removeItem(settingsKey); }
const usable = model => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);
const usableModels = () => state.models.filter(usable);
const availableChoices = () => usableModels().map(model => ({
  id: model.id,
  name: `${model.name} · ${state.connections.find(c => c.id === model.connectionId)?.name}`,
  image: imageModel(model)
}));
const modelLabel = id => state.models.find(model => model.id === id)?.name || id;
const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}) {
  const requestToken = token;
  const response = await fetch(url, { ...options, headers: { ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
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
        login('管理会话已失效，请重新打开管理台。');
      }
    }
    const error = new Error(data.error?.message || `请求失败（${response.status}）`);
    error.code = data.error?.code;
    throw error;
  }
  return data;
}
async function load(renderPage = true) {
  const currentToken = token;
  const next = await api('/admin/state');
  if (token !== currentToken) return;
  state = next;
  if (renderPage) render();
}
async function mutate(url, method, body = {}, revision = state.revision) {
  if (busy || catalogRefresh) throw new Error('正在处理，请稍候。');
  busy = true;
  try {
    const result = await api(url, { method, body: { ...body, revision } });
    state = result.state; return result;
  } catch (error) { try { await load(false); } catch {} throw error; }
  finally { busy = false; }
}
function login(error = '', showManual = false) {
  $('#app').innerHTML = `<main class="login"><div class="login-card">
    <div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div>
    <h1>打开管理台</h1>
    <p>在项目目录运行 <code>npm run console</code>，即可打开已登录的工作台。</p>
    <p>要在当前标签页打开，运行 <code>npm run --silent console -- --print</code>，把生成的一次性链接粘贴到地址栏。</p>
    ${showManual ? '' : `<div class="form-error" role="alert">${escape(error)}</div>`}
    <details${showManual ? ' open' : ''}>
      <summary>使用管理令牌</summary>
      <p>运行 <code>npm run --silent token</code> 获取本机管理令牌。</p>
      <form id="login-form">
        <label>管理令牌<input name="token" type="password" placeholder="md_admin_…" autocomplete="off" required></label>
        ${showManual ? `<div class="form-error" role="alert">${escape(error)}</div>` : ''}
        <button class="primary">进入工作台 ${icon('arrow')}</button>
      </form>
    </details>
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
  const current = views[view];
  const scroll = $('#catalog-table')?.scrollLeft || 0;
  const active = document.activeElement;
  const focus = active?.dataset?.catalogFocus;
  const searchSelection = focus === 'search' ? [active.selectionStart, active.selectionEnd] : null;
  $('#app').innerHTML = `<div class="shell reference-layout"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div><div class="sidebar-sub">Model supply & access.</div><div class="nav-label">服务端 / SERVER</div><nav class="nav" aria-label="主导航">${Object.entries(views).map(([id, [name, symbol]]) => `<button data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}>${icon(symbol)}${name}</button>`).join('')}</nav><div class="sidebar-bottom"><p><span class="local-dot"></span>本机网关</p><small>v${escape(state.version)} · 127.0.0.1</small><div><button class="quiet" data-action="logout">退出管理会话</button></div></div></aside><div class="main"><header class="topbar"><div class="crumb"><span>工作台</span><span>/</span><strong>${current[0]}</strong></div><span class="pill"><span class="local-dot"></span>本地运行</span></header><main class="page">${view === 'connections' ? connectionsPage() : view === 'models' ? modelsPage() : view === 'playground' ? playgroundPage() : keysPage()}<p class="footer-note">模型与凭证由你掌握 · Model Dock</p></main></div></div>`;
  if (view === 'models') {
    const catalog = $('#catalog-table');
    applyCatalogWidths();
    catalog.scrollLeft = scroll;
    focusCatalogControl(focus);
    if (searchSelection) $('#catalog-search').setSelectionRange(...searchSelection);
  }
  if (view === 'playground') playImages.set($('#play-form'), { references: [], reading: false, result: null });
}

function focusCatalogControl(key) {
  if (key) {
    const control = [...document.querySelectorAll('.catalog-manager [data-catalog-focus]')].find(node => node.dataset.catalogFocus === key);
    control?.focus({ preventScroll: true });
  }
}
function connectionsPage() {
  return `<header class="between page-heading connections-heading">
    <h1>连接与凭证</h1>
    <button class="quiet small-button" data-action="refresh">${icon('refresh')} 刷新状态</button>
  </header>
  <section class="endpoint connections-endpoint" aria-labelledby="connections-endpoint-title">
    <div>
      <div class="row wrap">
        <h2 id="connections-endpoint-title">一个地址，接入你的项目</h2>
        <span class="tag blue">OpenAI-compatible</span>
      </div>
      <code>${escape(state.baseUrl)}</code>
      <p>发布模型后，使用独立项目密钥接入你的应用。</p>
    </div>
    <button data-action="copy-endpoint">${icon('copy')} 复制地址</button>
  </section>
  <section aria-labelledby="connections-title">
    <div class="section-header between wrap">
      <div>
        <h2 id="connections-title">我的连接</h2>
        <p>发现模型后，前往「模型与服务」发布。</p>
      </div>
      <button class="quiet small-button" data-view="models">管理模型 ${icon('arrow')}</button>
    </div>
    <div class="provider-groups">${Object.entries(types).map(([id, type]) => providerGroup(id, type)).join('')}</div>
  </section>`;
}

function providerGroup(id, type) {
  const connections = state.connections.filter(connection => connection.type === id);
  return `<section class="card provider-group" aria-labelledby="provider-${id}-heading">
    <header class="provider-header between wrap">
      <div class="row">
        <span class="provider-icon ${id}">${icon(type.icon)}</span>
        <div>
          <div class="row wrap">
            <h3 id="provider-${id}-heading">${type.name}</h3>
            ${id === 'codex' ? '<span class="tag">实验性</span>' : ''}
          </div>
          <p class="provider-description">${type.description}</p>
        </div>
      </div>
      ${providerActions(id, type.addLabel, connections.length > 0)}
    </header>
    ${connections.length
      ? `<ul class="provider-connections" role="list">${connections.map(connectionCard).join('')}</ul>`
      : ''}
  </section>`;
}

function providerActions(id, addLabel, hasConnections) {
  if (id === 'codex' && hasConnections) return '';
  const addAnotherInstance = id === 'ollama' && hasConnections;
  const addButton = `<button class="provider-add" data-action="add-connection" data-type="${id}">${icon('plus')} ${addAnotherInstance ? '添加其他实例' : addLabel}</button>`;
  return `<div class="provider-actions row wrap">
    ${hasConnections ? '' : '<span class="provider-empty">暂无连接</span>'}
    ${addAnotherInstance ? `<details class="provider-more">
      <summary aria-label="更多 Ollama 操作">更多</summary>
      ${addButton}
    </details>` : addButton}
  </div>`;
}

function connectionCard(connection) {
  const models = state.models.filter(model => model.connectionId === connection.id);
  const status = !connection.enabled ? ['已停用', ''] : connection.status === 'connected' ? ['检查成功', 'good'] : connection.status === 'error' ? ['检查失败', 'error'] : ['未检查', ''];
  const credential = connection.hasKey ? '已保存密钥' : connection.type === 'codex' ? '本机登录' : '未设置密钥';
  return `<li class="connection-card">
    <div class="connection-heading between">
      <h4>${escape(connection.name)}</h4>
      <span class="tag ${status[1]}">${status[0]}</span>
    </div>
    ${connection.baseUrl ? `<p class="connection-url mono" title="${escape(connection.baseUrl)}">${escape(connection.baseUrl)}</p>` : ''}
    <div class="connection-meta between wrap">
      <small>${models.filter(model => model.available !== false).length} 个模型 · ${models.filter(usable).length} 个已启用</small>
      <small>${credential}</small>
    </div>
    <p class="status-line">${connection.checkedAt ? `上次检查 ${timestamp(connection.checkedAt)}` : '尚未发现模型'}${connection.errorCode ? ` · ${escape(connection.errorCode)}` : ''}</p>
    <div class="connection-actions between wrap">
      <button class="small-button" data-action="discover" data-id="${connection.id}">${icon('refresh')} 发现模型</button>
      <div class="row">
        <button class="quiet small-button" data-action="edit-connection" data-id="${connection.id}">编辑</button>
        <button class="quiet small-button" data-action="delete-connection" data-id="${connection.id}">移除</button>
      </div>
    </div>
  </li>`;
}
let modelSearch = '', modelFilter = 'all';
const catalogFilters = [
  ['all', '全部'],
  ['content_ai', '文本与理解'],
  ['image_generation', '图片生成'],
  ['video_generation', '视频生成'],
  ['media_transcription', '语音识别'],
  ['video_tts', '语音合成']
];
const effortLabels = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '极限', ultra: '超高' };
const catalogDash = '—';

function rememberSettings() {
  try {
    if (settingsDraft) {
      const { revision, changes } = settingsDraft;
      sessionStorage.setItem(settingsKey, JSON.stringify({ revision, changes: [...changes] }));
    } else sessionStorage.removeItem(settingsKey);
  } catch {
    if (settingsDraft) settingsError = '无法暂存草稿，请在关闭页面前保存。';
  }
}

function modelTags(model) {
  const capabilities = model.capabilities || {};
  const tags = [];
  if (imageModel(model)) tags.push('图片生成');
  if (capabilities.text === true) tags.push('文本生成');
  if (capabilities.tools === true) tags.push('工具调用');
  if (capabilities.structured === true) tags.push('结构化输出');
  if (capabilities.thinking === true || model.reasoningEfforts?.length) tags.push('深度思考');
  return tags;
}

function draftModelSettings(model) {
  const changes = settingsDraft?.changes.get(model.id);
  return { enabled: model.enabled, reasoningPolicy: model.reasoningPolicy ?? null, ...changes };
}

function reasoningLevels(model, policy) {
  const declared = [...new Set(model.reasoningEfforts || [])];
  const configured = Array.isArray(policy?.allowedEfforts) ? policy.allowedEfforts : [];
  const allowed = policy ? declared.filter(level => configured.includes(level)) : declared;
  const preferred = policy?.defaultEffort ?? model.defaultEffort;
  const defaultEffort = allowed.includes(preferred) ? preferred : null;
  return { declared, allowed, defaultEffort, obsolete: Boolean(policy && (!defaultEffort || allowed.length !== configured.length)) };
}

function changeModelSettings(model, patch) {
  const changes = { ...settingsDraft?.changes.get(model.id), ...patch };
  if (changes.enabled === model.enabled) delete changes.enabled;
  if (Object.hasOwn(changes, 'reasoningPolicy')) {
    const saved = model.reasoningPolicy ?? null;
    const next = changes.reasoningPolicy;
    const baseline = saved || { allowedEfforts: model.reasoningEfforts || [], defaultEffort: model.defaultEffort };
    if (next === saved || next && next.defaultEffort === baseline.defaultEffort && next.allowedEfforts.length === baseline.allowedEfforts?.length
      && next.allowedEfforts.every(level => baseline.allowedEfforts.includes(level))) delete changes.reasoningPolicy;
  }
  settingsDraft ??= { revision: state.revision, changes: new Map() };
  if (Object.keys(changes).length) settingsDraft.changes.set(model.id, changes);
  else settingsDraft.changes.delete(model.id);
  if (!settingsDraft.changes.size) settingsDraft = undefined;
  settingsError = catalogNotice = '';
  rememberSettings();
  render();
}

function changeModelEffort(model, level, pin) {
  const { reasoningPolicy } = draftModelSettings(model);
  const { declared, allowed, defaultEffort } = reasoningLevels(model, reasoningPolicy);
  if (!declared.includes(level) || pin && !allowed.includes(level)) return;
  const allowedEfforts = pin ? allowed : declared.filter(value => value === level ? !allowed.includes(value) : allowed.includes(value));
  if (!allowedEfforts.length) return;
  let nextDefault = pin ? level : defaultEffort;
  if (!allowedEfforts.includes(nextDefault)) {
    const lower = declared.slice(0, declared.indexOf(defaultEffort)).findLast(value => allowedEfforts.includes(value));
    nextDefault = defaultEffort ? lower || allowedEfforts[0] : allowedEfforts.at(-1);
  }
  changeModelSettings(model, { reasoningPolicy: { allowedEfforts, defaultEffort: nextDefault } });
}

function compactTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  if (value % 1_048_576 === 0) return `${value / 1_048_576}M`;
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return value.toLocaleString('en-US');
}

function catalogModel(model, connection) {
  const available = model.available !== false && connection.enabled;
  const image = imageModel(model);
  const { enabled, reasoningPolicy } = draftModelSettings(model);
  const { declared, allowed, defaultEffort, obsolete } = reasoningLevels(model, reasoningPolicy);
  const pending = Boolean(busy || catalogRefresh);
  const locked = pending || !enabled || !available;
  const modelId = escape(model.id), name = escape(model.name);
  const details = `<button type="button" class="catalog-icon" data-action="model-details" data-id="${modelId}"
    data-catalog-focus="details:${modelId}" aria-label="查看${name}详情" aria-haspopup="dialog" title="模型详情">${icon('info')}</button>`;
  const tags = modelTags(model);
  const inputLimit = compactTokens(model.maxInputTokens), outputLimit = compactTokens(model.maxOutputTokens);
  const inputLabel = inputLimit && !outputLimit ? `${inputLimit} tokens` : inputLimit ?? catalogDash;
  const context = compactTokens(model.contextWindow);
  const levels = declared.map(level => {
    const label = Object.hasOwn(effortLabels, level) ? effortLabels[level] : level;
    const open = allowed.includes(level);
    const title = open && allowed.length === 1 ? '至少保留一个开放等级' : `${open ? '关闭' : '开放'}此思考等级`;
    return { level: escape(level), label: escape(label), open, pinned: level === defaultEffort, title, disabled: locked || open && allowed.length === 1 };
  });
  return `<div class="catalog-model" data-model-id="${modelId}" data-enabled="${enabled}">
    <div class="catalog-model-info">
      <h3>${name}${image ? ` ${details}` : ''}</h3>
      ${tags.length ? `<div class="catalog-badges" role="group" aria-label="${name}模型能力">${tags.map(tag => `<span class="catalog-badge">${escape(tag)}</span>`).join('')}</div>` : ''}
      ${image ? '' : `<div class="catalog-limits">最大输入 ${inputLabel} · 最大输出 ${outputLimit ?? catalogDash}
        <span class="catalog-limits-end">${outputLimit ? 'tokens' : ''}${details}</span>
      </div>`}
      ${!inputLimit && !outputLimit && context ? `<p class="catalog-limits">上下文窗口 ${context} tokens</p>` : ''}
      ${levels.length ? `<span class="catalog-caption">开放的思考深度</span>
        <div class="catalog-levels" role="group" aria-label="${name}开放的思考深度">${levels.map(({ level, label, open, title, disabled }) => `<button type="button" class="catalog-level" data-action="toggle-model-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="open:${modelId}:${level}" aria-pressed="${open}" title="${title}" ${disabled ? 'disabled' : ''}>${label === level ? level : `${label}（${level}）`}</button>`).join('')}</div>` : ''}
      <div class="catalog-publication">
        <button type="button" class="catalog-switch" role="switch" aria-checked="${enabled}" aria-label="发布 ${name}"
          data-action="publish-model" data-id="${modelId}" data-catalog-focus="publish:${modelId}"
          ${pending || !available && !enabled ? 'disabled' : ''}><span class="catalog-track" aria-hidden="true"></span>${enabled ? '已启用' : '未启用'}</button>
        ${available ? '' : '<span class="catalog-warning">当前不可用</span>'}
      </div>
    </div>
    <div class="catalog-reasoning">
      ${levels.length ? `<div class="catalog-levels" role="group" aria-label="${name}思考深度（可选 / 默认）">${levels.map(({ level, label, open, pinned, title, disabled }) => `<span class="catalog-effort" data-allowed="${open}" data-locked="${locked}">
        <button type="button" class="catalog-effort-toggle" data-action="toggle-model-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="effort:${modelId}:${level}" aria-label="${name}：${label}可选" aria-pressed="${open}" title="${title}" ${disabled ? 'disabled' : ''}>${label}</button>
        <button type="button" class="catalog-effort-pin" data-action="pin-model-effort" data-id="${modelId}" data-level="${level}"
          data-catalog-focus="pin:${modelId}:${level}" aria-label="${name}：${label}设为默认" aria-pressed="${pinned}"
          title="${pinned ? '默认思考深度' : open ? `将${label}设为默认` : '请先开放此深度'}" ${locked || !open ? 'disabled' : ''}>${icon('pin')}</button>
      </span>`).join('')}</div>` : `<span class="catalog-muted" title="暂无可选思考深度">${catalogDash}</span>`}
      ${obsolete ? `<p class="catalog-caption catalog-warning">思考深度已变更。${levels.length && enabled && available ? '请选择可用的等级。' : '请在模型详情中清除失效设置。'}</p>` : ''}
    </div>
  </div>`;
}

const connectionErrors = {
  upstream_auth_failed: '请检查 API 密钥和模型权限。',
  upstream_unreachable: '无法连接服务，请检查服务地址和运行状态。',
  upstream_rate_limited: '服务限流，请稍后重试。',
  upstream_protocol_error: '上游返回了无法读取的响应。',
  codex_auth_required: '请先登录本机 Codex CLI。',
  codex_unavailable: '无法启动本机 Codex CLI，请检查安装状态。',
  codex_timeout: 'Codex 未及时响应，请重试。',
  codex_connection_failed: 'Codex 无法连接上游服务。',
  codex_rate_limited: 'Codex 额度已用尽。'
};

function recentModelCall(connectionId, nativeModel) {
  return state.requests.find(request => request.connectionId === connectionId
    && (nativeModel === undefined || request.nativeModel === nativeModel)
    && ['succeeded', 'failed'].includes(request.status));
}

function connectionHealth(connection, models) {
  if (!connection?.enabled) return { status: 'disabled', label: '服务已停用' };
  if (catalogRefresh?.id === connection.id) return { status: 'checking', label: '正在检测…' };
  const apiSource = connection.type === 'openai';
  const lastCall = recentModelCall(connection.id);
  const newerCall = lastCall && connection.checkedAt && Date.parse(lastCall.startedAt) + lastCall.durationMs > Date.parse(connection.checkedAt);
  const callError = newerCall && lastCall.status === 'failed' && connectionErrors[lastCall.errorCode];
  if (callError) return { status: 'call_failed', label: apiSource ? 'API 最近调用失败' : '最近调用失败', detail: callError };
  const callSucceeded = newerCall && lastCall.status === 'succeeded';
  if (connection.status === 'error' && !callSucceeded) {
    return {
      status: 'error',
      label: apiSource ? 'API 异常' : '连接异常',
      detail: connectionErrors[connection.errorCode] || '连接检测失败，请重试。'
    };
  }
  if (connection.status === 'connected' || callSucceeded) {
    if (apiSource) return { status: 'connected', label: 'API 连接正常' };
    const available = models.filter(model => model.available !== false).length;
    if (!available) return { status: models.length ? 'unknown' : 'empty', label: '暂无可用模型' };
    if (available < models.length) return { status: 'unknown', label: '部分模型未就绪' };
    return { status: 'connected', label: '运行中' };
  }
  return { status: 'unknown', label: apiSource ? 'API 待验证' : '待验证' };
}

function catalogConnection(connection, models, total) {
  const { status, label, detail } = connectionHealth(connection, total);
  const checking = status === 'checking';
  const isEmpty = status === 'empty';
  const checkTitle = checking ? '正在检测连接…' : '刷新连接状态';
  const lastCheck = connection.checkedAt ? `上次检测 ${timestamp(connection.checkedAt)}` : '尚未检测';
  const statusTitle = `${lastCheck}\n根据连接检测和最近实际调用判断。`;
  const source = connection.type === 'openai' ? connection.hasKey ? 'API Key · 已配置' : 'OpenAI-compatible'
    : connection.type === 'codex' ? 'Codex CLI · 本机登录' : 'Ollama';
  return `<section class="catalog-group" aria-label="${escape(connection.name)}模型" data-enabled="${connection.enabled}">
    <div class="catalog-source">
      <h2>${escape(connection.name)}</h2>
      <p>${source}</p>
      <span class="catalog-badge">${models.filter(model => model.available !== false).length} / ${models.length} 已配置</span>
      <div class="catalog-runtime" data-status="${status}" title="${escape(statusTitle)}">
        ${isEmpty ? `<span role="status" aria-label="${label}" title="${label}">${catalogDash}</span>` : `<span class="catalog-status-dot" aria-hidden="true"></span><span role="status">${label}</span>`}
        <button type="button" class="catalog-icon catalog-status-refresh" data-action="check-connection" data-id="${escape(connection.id)}"
          data-catalog-focus="check:${escape(connection.id)}" aria-label="刷新${escape(connection.name)}连接状态" title="${checkTitle}"
          aria-busy="${checking}" ${busy || catalogRefresh || !connection.enabled ? 'disabled' : ''}>${icon('cycle')}</button>
      </div>
      ${detail ? `<p class="catalog-runtime-error">${escape(detail)}</p>` : ''}
      ${connection.type === 'openai' ? `<button class="catalog-text" data-action="add-model" data-id="${escape(connection.id)}" ${busy || catalogRefresh ? 'disabled' : ''}>手动添加模型</button>` : ''}
    </div>
    <div>${models.length ? models.map(model => catalogModel(model, connection)).join('') : `<p class="catalog-empty" title="尚未发现模型">${catalogDash}</p>`}</div>
  </section>`;
}

function modelTable() {
  const needle = modelSearch.trim().toLowerCase();
  const groups = state.connections.map(connection => {
    const sourceText = `${connection.name} ${connection.type} ${types[connection.type]?.name || ''}`;
    const total = state.models.filter(model => model.connectionId === connection.id);
    const models = total.filter(model => {
      const category = model.capability || (model.capabilities?.text !== false ? 'content_ai' : '');
      return (modelFilter === 'all' || category === modelFilter)
        && `${sourceText} ${model.id} ${model.name} ${model.nativeId || ''}`.toLowerCase().includes(needle);
    });
    const emptySource = modelFilter === 'all' && !total.length
      && sourceText.toLowerCase().includes(needle);
    return models.length || emptySource ? catalogConnection(connection, models, total) : '';
  }).join('');
  if (!groups) {
    const label = catalogFilters.find(([key]) => key === modelFilter)[1];
    let message = '请在“连接与凭证”添加模型来源。';
    if (needle) message = '没有匹配的模型。';
    else if (modelFilter !== 'all') message = `暂无${label}模型。`;
    return `<p class="catalog-empty">${message}</p>`;
  }
  return `<div class="catalog-grid"><div class="catalog-header">${catalogColumns.map(column => `<span>${column.label}
    <button type="button" class="catalog-resizer" data-catalog-column="${column.key}" data-catalog-focus="column:${column.key}"
      role="separator" aria-orientation="vertical" aria-label="调整${column.label}列宽" aria-valuemin="${column.min}" aria-valuemax="1200"
      aria-valuenow="${catalogWidth(column)}" title="拖动调整列宽，双击恢复默认宽度"></button></span>`).join('')}
    <span>思考深度（可选 / 默认）</span></div>${groups}</div>`;
}

function catalogWidth(column, width = catalogWidths.get(column.key) ?? column.width) {
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
  catalogWidths.set(column.key, catalogWidth(column, width));
  applyCatalogWidths();
}

function rememberCatalogWidths() {
  try { sessionStorage.setItem('model-dock-catalog-columns', JSON.stringify(Object.fromEntries(catalogWidths))); } catch {}
}

function modelsPage() {
  const dirty = settingsDraft?.changes.size || 0;
  const conflict = settingsDraft && settingsDraft.revision !== state.revision;
  const pending = Boolean(busy || catalogRefresh);
  const refreshing = Boolean(catalogRefresh?.all);
  const refreshLabel = refreshing ? '正在刷新…' : dirty ? '更新目录（保留修改）' : '刷新目录';
  const feedback = dirty ? `${dirty} 项未保存` : catalogNotice;
  const unavailable = state.models.some(model => settingsDraft?.changes.get(model.id)?.enabled === true
    && (model.available === false || !state.connections.find(connection => connection.id === model.connectionId)?.enabled));
  const invalidEfforts = state.models.some(model => {
    const policy = settingsDraft?.changes.get(model.id)?.reasoningPolicy;
    return policy && reasoningLevels(model, policy).obsolete;
  });
  const enabled = state.models.filter(model => draftModelSettings(model).enabled).length;
  return `<div class="cm-page-heading"><h1>${icon('sliders')} 模型与服务</h1></div>
    <section class="catalog-manager" aria-label="模型与服务" aria-busy="${pending}">
      <div class="catalog-toolbar">
        <div class="catalog-filters" role="group" aria-label="模型类型筛选">
          ${catalogFilters.map(([key, label]) => `<button type="button" data-action="catalog-filter" data-value="${key}"
            data-catalog-focus="filter:${key}" aria-pressed="${modelFilter === key}">${label}</button>`).join('')}
        </div>
        <div class="catalog-actions">
          <span class="catalog-muted">已启用 ${enabled} / ${state.models.length}</span>
          <button class="catalog-save ${dirty ? 'primary' : ''}" data-action="save-publication" data-catalog-focus="save"
            ${!dirty || pending || conflict || unavailable || invalidEfforts ? 'disabled' : ''}>${busy ? '处理中…' : dirty ? `保存更改 · ${dirty}` : '已保存'}</button>
        </div>
      </div>
      <div class="catalog-secondary">
        <input id="catalog-search" type="search" data-catalog-focus="search" aria-label="搜索模型或供应商" placeholder="搜索模型或供应商…" value="${escape(modelSearch)}">
        <div class="catalog-actions">
          ${feedback ? `<span class="catalog-muted" role="status">${feedback}</span>` : ''}
          <button class="catalog-text" data-view="connections">管理连接与凭证</button>
          <button class="catalog-text" data-action="revert-publication" data-catalog-focus="revert" ${!dirty || pending ? 'disabled' : ''}>撤销更改</button>
          <button class="catalog-text" data-action="refresh-catalog" data-catalog-focus="refresh" aria-busy="${refreshing}"
            title="检查已启用的服务并更新模型目录" ${pending ? 'disabled' : ''}>${refreshLabel}</button>
        </div>
      </div>
      ${conflict ? '<p class="catalog-feedback" role="status">目录已在其他页面更新。设置草稿已保留，请撤销更改后重新编辑。</p>' : ''}
      ${unavailable && !conflict ? '<p class="catalog-feedback" role="status">有待发布的模型已不可用。请调整对应的发布开关后保存。</p>' : ''}
      ${invalidEfforts && !conflict ? '<p class="catalog-feedback" role="status">部分修改使用了已失效的思考深度。请调整对应模型的设置后保存。</p>' : ''}
      ${settingsError ? `<p class="catalog-feedback catalog-warning" role="alert">${escape(settingsError)}</p>` : ''}
      <div id="catalog-table" class="catalog-scroll" role="region" tabindex="0" aria-label="按凭证查看模型与服务">${modelTable()}</div>
    </section>`;
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
  const focus = all ? 'refresh' : `check:${id}`;
  const returnFocus = document.activeElement?.dataset?.catalogFocus === focus;
  catalogRefresh = { all, id };
  catalogNotice = '';
  settingsError = '';
  render();
  let failed = 0;
  try {
    if (all) await load(false);
    const sources = state.connections.filter(connection => connection.enabled && (all || connection.id === id));
    for (const connection of sources) {
      catalogRefresh.id = connection.id;
      if (view === 'models') render();
      if (!await inspectConnection(connection.id)) failed++;
    }
    if (failed && all) {
      settingsError = `${failed} 个服务检测失败。已保留原有目录，请查看各服务的状态。`;
    } else if (!failed) {
      catalogNotice = all ? '目录已更新' : '连接检测完成';
    }
  } catch (error) {
    settingsError = error.code === 'revision_conflict' ? '目录已更新，请重新检测连接。' : '刷新失败，请重试。';
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
  const image = choices[0]?.image;
  return `<div class="page-heading"><div class="eyebrow">PLAYGROUND</div><h1>在接入前，先试一次。</h1><p>通过网关发送真实请求。调用会使用所选来源的额度。</p></div>
    <div class="playground">
      <form id="play-form" class="card stack">
        <h2>发送请求</h2>
        <label>模型<select name="model" aria-label="模型" required>${choices.length ? choices.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('') : '<option value="">请先发布一个模型</option>'}</select></label>
        <label>提示词<textarea name="prompt" rows="6" placeholder="${playgroundPlaceholder(image)}" ${image ? 'maxlength="4000"' : ''} required></textarea></label>
        <label id="play-stream" class="checkbox-label" ${image ? 'hidden' : ''}><input type="checkbox" name="stream" checked>流式输出</label>
        <fieldset class="play-image-options" id="play-image-options" ${image ? '' : 'hidden disabled'}>
          <label>期望画幅<select name="aspect_ratio"><option value="">自动</option>${imageAspectRatios.map(ratio => `<option value="${ratio}">${imageRatioLabels[ratio]}</option>`).join('')}</select></label>
          <label class="checkbox-label"><input type="checkbox" name="transparent_background">请求透明背景</label>
          <div class="play-references" role="group" aria-labelledby="play-reference-label">
            <div class="between"><h3 id="play-reference-label">参考图 <small id="play-reference-count" aria-live="polite">0 / ${maxImageReferences}</small></h3>
              <button type="button" class="small-button" data-action="add-reference">${icon('plus')} 添加图片</button></div>
            <input type="file" name="image_files" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple hidden>
            <ol class="play-reference-list" id="play-reference-list" hidden></ol>
            <small id="play-reference-hint">PNG、JPEG 或 WebP</small>
          </div>
        </fieldset>
        <div class="row"><button class="primary" id="send-button" ${choices.length ? '' : 'disabled'}>${icon('play')} 发送请求</button><button type="button" id="stop-button" data-action="stop" disabled>停止</button></div>
      </form>
      <section class="card"><div class="between"><h2>模型响应</h2><span class="tag" id="response-status">等待请求</span></div>
        <div class="response empty-output" id="response-output" role="log" aria-live="polite">选择模型并发送请求。</div>
        <div class="between wrap play-result-footer"><div id="response-meta" class="output-meta"></div>
          <button type="button" class="small-button" data-action="continue-image" hidden>继续编辑</button></div>
      </section>
    </div>${requestHistory()}${snippet(choices[0])}`;
}
function playgroundPlaceholder(image, references = 0) {
  if (!image) return '你好，用一句话介绍你自己。';
  if (references > 1) return '例如：保留图 1 的主体，参考图 2 的构图，只替换背景。';
  if (references === 1) return '例如：保留图 1 的主体，只替换背景。';
  return '一只蓝色陶瓷杯，浅色背景，居中构图。';
}
function renderImageReferences(form) {
  const { references } = playImages.get(form);
  const list = $('#play-reference-list');
  list.hidden = references.length === 0;
  list.innerHTML = references.map(({ name }, index) => {
    const label = `图 ${index + 1}`;
    return `<li><img alt=""><div class="play-reference-name"><strong>${label}</strong><small title="${escape(name)}">${escape(name)}</small></div>
      <div class="row"><button type="button" data-action="move-reference-up" data-index="${index}" aria-label="上移${label}" title="上移${label}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button type="button" data-action="move-reference-down" data-index="${index}" aria-label="下移${label}" title="下移${label}" ${index === references.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button type="button" data-action="remove-reference" data-index="${index}" aria-label="移除${label}" title="移除${label}">${icon('close')}</button></div></li>`;
  }).join('');
  list.querySelectorAll('img').forEach((node, index) => { node.src = references[index].url; });
  $('#play-reference-count').textContent = `${references.length} / ${maxImageReferences}`;
  form.querySelector('[data-action="add-reference"]').disabled = references.length === maxImageReferences;
  $('#play-reference-hint').textContent = references.length ? '提示词中可用「图 1」「图 2」指定参考图。' : 'PNG、JPEG 或 WebP';
  form.elements.prompt.placeholder = playgroundPlaceholder(true, references.length);
}
function changeImageReferences(button) {
  const form = $('#play-form'), { references, result } = playImages.get(form);
  const action = button.dataset.action;
  if (action === 'continue-image' && result) {
    // Start the next edit from the output. Other references can be added again.
    references.splice(0, references.length, result);
    renderImageReferences(form);
    form.elements.prompt.value = '';
    form.elements.prompt.placeholder = '描述你想如何编辑图 1。';
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
    reader.onerror = () => reject(new Error('无法读取所选图片。'));
    reader.readAsDataURL(file);
  });
}
async function addImageReferences(input) {
  const form = input.form, draft = playImages.get(form), files = [...input.files];
  input.value = '';
  if (!files.length || draft.reading || generation) return;
  const options = $('#play-image-options');
  const send = $('#send-button'), selector = form.elements.model;
  const existing = draft.references;
  if (existing.length + files.length > maxImageReferences) throw new Error(`最多添加 ${maxImageReferences} 张参考图。`);
  const formats = files.map(file => {
    const name = file.type ? /^image\/(\w+)$/i.exec(file.type)?.[1] : file.name.split('.').at(-1);
    const subtype = name?.toLowerCase();
    return Object.hasOwn(referenceFormats, subtype) ? referenceFormats[subtype] : null;
  });
  if (formats.some(format => !format)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  if (files.some(file => !file.size || file.size > maxImageReferenceBytes)) throw new Error('参考图大小须介于 1 字节和 30 MiB 之间。');
  const total = [...existing, ...files].reduce((size, file) => size + file.size, 0);
  if (total > maxImageReferenceTotalBytes) throw new Error('参考图合计不能超过 50 MiB。');
  draft.reading = true;
  options.disabled = send.disabled = selector.disabled = true;
  try {
    const added = [];
    for (const [index, file] of files.entries()) added.push(await readImageReference(file, formats[index]));
    if (form.isConnected) {
      existing.push(...added);
      renderImageReferences(form);
    }
  } finally {
    draft.reading = false;
    options.disabled = send.disabled = selector.disabled = false;
  }
}
function requestHistory() {
  const rows = [...state.active.map(row => ({ ...row, status: 'running', durationMs: Date.now() - new Date(row.startedAt).getTime() })), ...state.requests].slice(0, 8);
  const statuses = { succeeded: '已完成', failed: '失败', cancelled: '已取消', running: '进行中' };
  return `<div class="section-header"><h2>最近请求</h2><p>仅保留本次网关运行中的元数据，最多 100 条。</p></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>模型</th><th>结果</th><th>耗时</th><th>Token 用量</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escape(row.model)}</strong><small>${escape(timestamp(row.startedAt))}</small></td><td><span class="request-status ${row.status}">${statuses[row.status]}</span>${row.errorCode ? `<br><small>${escape(row.errorCode)}</small>` : ''}</td><td>${(row.durationMs / 1000).toFixed(1)}s</td><td>${row.usage ? row.usage.total_tokens.toLocaleString() : '未报告'}</td><td>${row.status === 'running' ? `<button class="small-button" data-action="cancel-request" data-id="${row.id}">取消</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无调用记录', '请求完成后，这里会显示来源、耗时和上游实际报告的 Token 用量。', 'play')}`;
}
function exampleCode(choice) {
  const model = choice?.id || 'connection-id/model-id';
  const endpoint = choice?.image ? 'images/generations' : 'chat/completions';
  const body = choice?.image ? { model, prompt: 'A blue ceramic cup on a light background' } : { model, messages: [{ role: 'user', content: 'Hello!' }] };
  return `curl ${state.baseUrl}/${endpoint} \\\n  -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
}
function snippet(choice = availableChoices()[0]) {
  const code = exampleCode(choice);
  return `<div class="code-card"><div class="between"><h3>接入示例 · cURL</h3><button class="small-button" data-action="copy-example">${icon('copy')} 复制</button></div><pre id="example-code">${escape(code)}</pre></div>`;
}
function keysPage() {
  return `<div class="between page-heading"><div><div class="eyebrow">PROJECT ACCESS</div><h1>把能力，交给你的项目。</h1><p>为每个项目创建独立密钥，并限定它可以调用的模型。</p></div><button class="primary" data-action="add-key">${icon('plus')} 创建密钥</button></div><div class="endpoint"><div><h3>网关 Base URL</h3><code>${escape(state.baseUrl)}</code><p>在兼容客户端中配置此地址，API Key 使用下方创建的项目密钥。</p></div><button data-action="copy-endpoint">${icon('copy')} 复制地址</button></div><div class="section-header"><h2>项目密钥 <span class="muted">${state.keys.length}</span></h2></div>${state.keys.length ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>密钥</th><th>允许范围</th><th>创建时间</th><th></th></tr></thead><tbody>${state.keys.map(key => `<tr><td><strong>${escape(key.name)}</strong></td><td><code>${escape(key.prefix)}…</code></td><td>${key.models.includes('*') ? '<span class="tag blue">所有已发布模型</span>' : key.models.map(model => `<span class="tag">${escape(modelLabel(model))}</span>`).join(' ')}</td><td><small>${escape(timestamp(key.createdAt))}</small></td><td><button class="quiet danger small-button" data-action="delete-key" data-id="${key.id}">撤销</button></td></tr>`).join('')}</tbody></table></div>` : empty('为第一个项目创建密钥', '上游 API Key 留在网关。项目只持有自己的访问密钥，可以随时撤销。', 'key')}<div class="info-box">${icon('info')}<div><strong>后端或本机应用接入</strong>把密钥放在项目的服务端环境变量中。不要写进公开网页脚本。本机网关默认只接受本机调用；远程设备配对将在后续连接器版本提供。</div></div>${snippet()}`;
}
function showDialog(title, description, fields, submitLabel, callback) {
  const dialog = $('#dialog');
  dialog.innerHTML = `<div class="modal-heading"><h2 id="dialog-title">${escape(title)}</h2><p>${escape(description)}</p></div><form id="modal-form" class="modal-form">${fields}<div class="form-error" id="modal-error" role="alert"></div><div class="modal-actions"><button type="button" data-action="close-dialog">取消</button><button class="primary" type="submit">${escape(submitLabel)}</button></div></form>`;
  $('#modal-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; $('#modal-error').textContent = '';
    try { await callback(new FormData(event.target)); }
    catch (error) { if ($('#modal-error')) $('#modal-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  if (!dialog.open) dialog.showModal();
}
function connectionDialog(typeId, existing) {
  const type = types[typeId];
  showDialog(existing ? '编辑连接' : `添加 ${type.name}`, typeId === 'codex' ? '使用本机已安装并登录的 Codex CLI。此适配器用于个人本机接入。' : '连接保存后，点击“发现模型”获取目录。', `
    <label>连接名称<input name="name" value="${escape(existing?.name || type.defaultName)}" required maxlength="100"></label>
    ${typeId !== 'codex' ? `<label>Base URL<input type="url" name="baseUrl" value="${escape(existing?.baseUrl || type.baseUrl)}" required><small>${typeId === 'openai' ? '填写 API 基础地址，例如包含 /v1 的地址。' : '填写 Ollama 服务地址，不需要 /api 或 /v1。'}</small></label><label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${existing?.hasKey ? '已保存；留空保留原密钥' : typeId === 'ollama' ? '本机 Ollama 通常无需密钥' : '输入自己的 API Key'}">${existing?.hasKey ? '<small>如需移除原密钥，勾选下方选项。</small>' : ''}</label>${existing?.hasKey ? '<label class="checkbox-label"><input type="checkbox" name="clearKey">移除已保存的 API Key</label>' : ''}` : '<div class="info-box">仅启动受限的本机 App Server。宿主 Shell、浏览器、插件与 MCP 工具不会提供给 API 调用方。</div>'}
    <div class="form-grid"><label>最大并发<input name="maxConcurrency" type="number" min="1" max="${typeId === 'codex' ? '1' : '16'}" value="${existing?.maxConcurrency || (typeId === 'codex' ? 1 : 2)}" required></label><label>请求超时（秒）<input name="timeoutSeconds" type="number" min="5" max="1800" value="${existing?.timeoutSeconds || 600}" required></label></div>
    <label class="checkbox-label"><input name="enabled" type="checkbox" ${existing?.enabled !== false ? 'checked' : ''}>启用此连接</label>`, '保存连接', async form => {
    const input = { type: typeId, name: form.get('name'), enabled: form.has('enabled'), maxConcurrency: Number(form.get('maxConcurrency')), timeoutSeconds: Number(form.get('timeoutSeconds')) };
    if (typeId !== 'codex') { input.baseUrl = form.get('baseUrl'); if (form.get('apiKey') || form.has('clearKey') || !existing) input.apiKey = form.has('clearKey') ? '' : form.get('apiKey'); }
    await mutate(`/admin/connections${existing ? `/${existing.id}` : ''}`, existing ? 'PATCH' : 'POST', input);
    $('#dialog').close(); render(); toast('连接已保存。可点击“发现模型”获取目录。');
  });
}
async function generate(form) {
  const draft = playImages.get(form);
  if (generation || draft.reading) return;
  const fields = new FormData(form);
  const model = state.models.find(item => item.id === fields.get('model'));
  const image = imageModel(model);
  const streaming = !image && fields.has('stream');
  const prompt = fields.get('prompt');
  const ratio = fields.get('aspect_ratio');
  const body = image ? { model: model.id, prompt, ...(ratio ? { aspect_ratio: ratio } : {}),
    ...(fields.has('transparent_background') ? { background: 'transparent' } : {}),
    ...(draft.references.length ? { reference_images: draft.references.map(item => item.url) } : {}) } : {
    model: fields.get('model'), messages: [{ role: 'user', content: prompt }], stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {})
  };
  const controller = new AbortController(); generation = controller;
  form.elements.model.disabled = true;
  $('#send-button').disabled = true; $('#stop-button').disabled = false;
  $('#play-image-options').disabled = true;
  const continueButton = $('[data-action="continue-image"]');
  continueButton.hidden = true;
  draft.result = null;
  const output = $('#response-output'); output.classList.remove('empty-output'); output.textContent = '';
  output.classList.toggle('image-output', image);
  $('#response-status').textContent = image ? '生成图片中' : '请求中';
  $('#response-meta').textContent = '正在等待模型响应…';
  let measurement, imageMeta, content = '', ended = false; const started = performance.now();
  try {
    const endpoint = image ? '/v1/images/generations' : '/v1/chat/completions';
    const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || '请求失败'); }
    if (image) {
      const result = await response.json();
      const { b64_json: b64, width, height } = result.data?.[0] || {};
      if (!['png', 'jpeg', 'webp'].includes(result.output_format) || typeof b64 !== 'string' || !b64) {
        throw new Error('网关没有返回有效图片。');
      }
      const preview = document.createElement('img');
      preview.alt = '生成的图片';
      const url = `data:image/${result.output_format};base64,${b64}`;
      preview.src = url;
      await preview.decode();
      controller.signal.throwIfAborted();
      const size = b64.length / 4 * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      draft.result = { name: '上一次生成结果', size, url };
      imageMeta = `${width || preview.naturalWidth} × ${height || preview.naturalHeight} · ${result.output_format.toUpperCase()}`;
      output.append(preview);
      continueButton.hidden = false;
    } else if (streaming) {
      for await (const data of sse(response.body)) {
        if (data === '[DONE]') { ended = true; break; }
        const chunk = JSON.parse(data); if (chunk.error) throw new Error(chunk.error.message);
        content += chunk.choices?.[0]?.delta?.content || ''; output.textContent = content; output.scrollTop = output.scrollHeight;
        if (chunk.usage) measurement = chunk.usage;
      }
      if (!ended) throw new Error('响应流未正常结束。');
    } else {
      const data = await response.json(); content = data.choices?.[0]?.message?.content || ''; output.textContent = content; measurement = data.usage;
    }
    $('#response-status').textContent = '已完成';
  } catch (error) {
    $('#response-status').textContent = controller.signal.aborted ? '已停止' : '失败';
    if (!controller.signal.aborted) { output.textContent = content ? `${content}\n\n请求失败：${error.message}` : error.message; toast(error.message, true); }
  } finally {
    generation = null; form.elements.model.disabled = false; $('#send-button').disabled = false; $('#stop-button').disabled = true;
    $('#play-image-options').disabled = !image;
    const duration = `${((performance.now() - started) / 1000).toFixed(1)} 秒`;
    $('#response-meta').textContent = image ? [imageMeta, duration].filter(Boolean).join(' · ')
      : `${duration} · ${measurement ? `输入 ${measurement.prompt_tokens} / 输出 ${measurement.completion_tokens} tokens` : '上游未报告用量'}`;
    if (image && controller.signal.aborted) output.textContent = '请求已停止。';
    try { await load(false); } catch {}
  }
}
document.addEventListener('change', event => {
  if (event.target.matches('#play-form [name="image_files"]')) {
    void addImageReferences(event.target).catch(error => toast(error.message, true));
    return;
  }
  if (!event.target.matches('#play-form select[name="model"]')) return;
  const model = state.models.find(item => item.id === event.target.value);
  const image = imageModel(model);
  const prompt = event.target.form.elements.prompt;
  $('#play-image-options').hidden = $('#play-image-options').disabled = !image;
  $('#play-stream').hidden = image;
  $('[data-action="continue-image"]').hidden = !image || !playImages.get(event.target.form).result;
  prompt.placeholder = playgroundPlaceholder(image, image ? playImages.get(event.target.form).references.length : 0);
  if (image) prompt.maxLength = 4000;
  else prompt.removeAttribute('maxlength');
  $('#example-code').textContent = exampleCode({ id: event.target.value, image });
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
  const handle = event.target.closest('[data-catalog-column]');
  const column = catalogColumns.find(item => item.key === handle?.dataset.catalogColumn);
  if (!column || event.button !== 0) return;
  event.preventDefault();
  handle.focus({ preventScroll: true });
  handle.setPointerCapture?.(event.pointerId);
  const start = event.clientX, width = catalogWidth(column);
  const move = next => resizeCatalogColumn(column, width + next.clientX - start);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('lostpointercapture', () => {
    handle.removeEventListener('pointermove', move);
    rememberCatalogWidths();
  }, { once: true });
});
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
    try { await load(); sessionStorage.setItem(manualTokenKey, manualToken); } catch (error) { login(error.message, true); }
  } else if (event.target.id === 'play-form') { event.preventDefault(); void generate(event.target); }
});
document.addEventListener('click', async event => {
  const more = $('.provider-more[open]');
  if (more && !more.contains(event.target)) more.open = false;
  if (event.target.closest('[data-mm]')) return;
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.view) {
    if (generation) { toast('请先停止或等待当前请求。'); return; }
    view = button.dataset.view; history.pushState(null, '', `${location.pathname}?view=${view}`); render(); return;
  }
  const action = button.dataset.action, id = button.dataset.id;
  if (!action) return;
  if ((busy || catalogRefresh) && !['close-dialog', 'stop', 'catalog-filter', 'model-details'].includes(action)) {
    return toast('正在处理，请稍候。');
  }
  try {
    if (action === 'add-reference') { button.form.elements.image_files.click(); return; }
    if (['move-reference-up', 'move-reference-down', 'remove-reference', 'continue-image'].includes(action)) {
      if (!generation && !playImages.get($('#play-form')).reading) changeImageReferences(button);
      return;
    }
    if (action === 'close-dialog') $('#dialog').close();
    if (action === 'refresh') { await load(); toast('状态已刷新。'); }
    if (action === 'logout') {
      if (generation) { toast('请先停止或等待当前请求。'); return; }
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
    if (action === 'copy-endpoint') { await navigator.clipboard.writeText(state.baseUrl); toast('地址已复制。'); }
    if (action === 'copy-example') { await navigator.clipboard.writeText($('#example-code').textContent); toast('接入示例已复制。'); }
    if (action === 'add-connection') {
      if (more?.contains(button)) {
        more.open = false;
        more.querySelector('summary').focus();
      }
      connectionDialog(button.dataset.type);
    }
    if (action === 'edit-connection') { const connection = state.connections.find(item => item.id === id); connectionDialog(connection.type, connection); }
    if (action === 'catalog-filter') {
      modelFilter = button.dataset.value;
      render();
      $('.catalog-filters [aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    if (action === 'refresh-catalog') await refreshModelServices();
    if (action === 'check-connection') await refreshModelServices(id);
    if (action === 'revert-publication') {
      settingsDraft = undefined;
      settingsError = '';
      catalogNotice = '已撤销未保存的更改';
      rememberSettings();
      render();
    }
    if (action === 'model-details') {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      const connection = state.connections.find(item => item.id === model.connectionId);
      const { enabled, reasoningPolicy } = draftModelSettings(model);
      const { declared, allowed, defaultEffort, obsolete } = reasoningLevels(model, reasoningPolicy);
      const canEditEfforts = declared.length && enabled && connection?.enabled && model.available !== false;
      const canClearEfforts = obsolete && !canEditEfforts && !busy && !catalogRefresh;
      const models = state.models.filter(item => item.connectionId === model.connectionId);
      const health = connectionHealth(connection, models);
      const lastCall = recentModelCall(model.connectionId, model.nativeId);
      const formatTokens = value => Number.isSafeInteger(value) && value > 0 ? `${value.toLocaleString('en-US')} tokens` : null;
      const fields = [
        ['凭证 / 服务', connection?.name],
        ['模型 ID', model.nativeId],
        ['网关模型 ID', model.id],
        ['模型能力', modelTags(model).join('、')],
        ['连接状态', [health.label, health.detail].filter(Boolean).join(' · ')],
        ['上次检测', connection?.checkedAt ? timestamp(connection.checkedAt) : null],
        ...(lastCall ? [['最近调用', `${lastCall.status === 'succeeded' ? '成功' : '失败'} · ${timestamp(lastCall.startedAt)}`]] : []),
        ['最大输入', formatTokens(model.maxInputTokens)],
        ['最大输出', formatTokens(model.maxOutputTokens)],
        ['上下文窗口', formatTokens(model.contextWindow)],
        ['开放的思考深度', allowed.join('、')],
        ['默认思考深度', defaultEffort || (allowed.length ? '由上游决定' : null)]
      ];
      const details = `<dl class="catalog-details">${fields.map(([label, value]) => `<dt>${label}</dt><dd>${escape(value || catalogDash)}</dd>`).join('')}</dl>`;
      const recovery = canClearEfforts ? '<p class="catalog-warning">思考深度设置已失效。清除后，点击「保存更改」生效。</p>' : '';
      showDialog('模型详情', model.name, details + recovery, canClearEfforts ? '清除失效设置' : '关闭', async () => {
        $('#dialog').close();
        if (canClearEfforts) changeModelSettings(model, { reasoningPolicy: null });
      });
    }
    if (action === 'discover') {
      const revision = state.revision;
      button.disabled = true; button.textContent = '正在发现…';
      try {
        await mutate(`/admin/connections/${encodeURIComponent(id)}/discover`, 'POST');
      } catch (error) {
        if (state.connections.some(connection => connection.id === id && connection.status === 'error' && connection.errorCode === error.code)) {
          advanceSettingsDraft(revision);
        }
        throw error;
      }
      advanceSettingsDraft(revision);
      render(); toast('目录已更新，新模型需要手动发布。');
    }
    if (action === 'add-model') showDialog('手动添加模型', '适用于未提供模型列表接口的 API。请填写供应商实际支持的模型 ID。', '<label>模型 ID<input name="nativeId" placeholder="供应商模型 ID" required></label><label>显示名称（可选）<input name="name" placeholder="便于识别的名称"></label>', '添加模型', async form => {
      await mutate('/admin/models', 'POST', { connectionId: id, ...Object.fromEntries(form) }); $('#dialog').close(); render(); toast('模型已添加，请手动发布。');
    });
    if (['publish-model', 'toggle-model-effort', 'pin-model-effort'].includes(action)) {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      if (action === 'publish-model') changeModelSettings(model, { enabled: !draftModelSettings(model).enabled });
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
      catalogNotice = '全部更改已保存';
      rememberSettings();
      render();
    }
    if (action === 'add-key') {
      const choices = availableChoices();
      showDialog('创建项目访问密钥', '密钥只显示一次。默认仅授予你选择的模型。', `<label>项目名称<input name="name" placeholder="例如：我的聊天 demo" required></label><label>允许调用</label><div class="checklist">${choices.map(item => `<label class="checkbox-label"><input type="checkbox" name="models" value="${escape(item.id)}">${escape(item.name)}</label>`).join('')}<label class="checkbox-label"><input type="checkbox" name="models" value="*">所有已发布的模型（含以后新增）</label></div>`, '创建密钥', async form => {
        const result = await mutate('/admin/keys', 'POST', { name: form.get('name'), models: form.getAll('models') });
        $('#dialog').close(); render();
        showDialog('保存你的项目密钥', '复制到项目的服务端环境变量。关闭后将无法再次查看。', `<div class="token-box"><code id="new-token">${escape(result.token)}</code></div><button type="button" data-action="copy-token">${icon('copy')} 复制密钥</button>`, '我已保存', async () => { $('#dialog').close(); });
      });
    }
    if (action === 'copy-token') { await navigator.clipboard.writeText($('#new-token').textContent); toast('项目密钥已复制。'); }
    if (['delete-connection', 'delete-key'].includes(action)) {
      const key = action === 'delete-key';
      showDialog(key ? '撤销项目密钥' : '移除此连接', key ? '使用此密钥的项目将失去访问权限，正在进行的请求也会被取消。' : '会移除此连接的模型与凭证。应用的已有模型选择将不可用，本机模型文件会保留。', '', '确认操作', async () => {
        await mutate(`/admin/${key ? 'keys' : 'connections'}/${encodeURIComponent(id)}`, 'DELETE'); $('#dialog').close(); render(); toast('操作已完成。');
      });
    }
    if (action === 'stop') generation?.abort();
    if (action === 'cancel-request') { await api(`/admin/requests/${id}/cancel`, { method: 'POST', body: {} }); await load(); toast('已发送取消请求。'); }
  } catch (error) {
    if (action === 'save-publication') {
      const message = error.code === 'reasoning_policy_conflict' ? '有旧别名或分组仍在使用被关闭的思考深度。请保留该深度后再保存。' : error.message;
      settingsError = `${message} 未保存的更改已保留。`;
    }
    toast(error.message, true);
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
    try { await load(); } catch (loadError) { login(loadError.message); }
  } else login(error.message);
}
const refreshTimer = setInterval(async () => {
  if (!token || !state || busy || catalogRefresh || generation || $('#dialog').open || document.visibilityState !== 'visible' || view === 'playground') return;
  const currentToken = token;
  try {
    const next = await api('/admin/state');
    if (currentToken !== token || busy || catalogRefresh || generation || $('#dialog').open || view === 'playground' || next.revision < state.revision) return;
    const changed = next.revision !== state.revision || view === 'models' && next.requests[0]?.id !== state.requests[0]?.id;
    state = next;
    if (changed) render();
  } catch {}
}, 15_000);
const popstate = () => { const next = new URLSearchParams(location.search).get('view') || 'connections'; if (views[next] && !generation) { view = next; render(); } };
const consoleLinkChanged = () => {
  if (new URLSearchParams(location.hash.slice(1)).has('session')) location.reload();
};
window.addEventListener('popstate', popstate);
window.addEventListener('hashchange', consoleLinkChanged);
export function dispose() {
  clearInterval(refreshTimer);
  clearTimeout(toastTimer);
  generation?.abort();
  window.removeEventListener('popstate', popstate);
  window.removeEventListener('hashchange', consoleLinkChanged);
}
