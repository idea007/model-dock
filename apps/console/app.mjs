import { sse } from './events.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  dock: '<path d="M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  models: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-5-5 3-3m-1 5 3-3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  terminal: '<path d="m5 6 5 6-5 6m8 0h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11z"/>',
  computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.dock}</svg>`;
const types = {
  openai: { name: '模型 API', icon: 'cloud', description: '接入自己的 API Key，统一使用支持 OpenAI 格式的模型服务。', hint: 'OpenAI-compatible', defaultName: '我的模型 API', baseUrl: 'https://api.openai.com/v1' },
  ollama: { name: 'Ollama', icon: 'computer', description: '发现本机已安装的模型，将本地推理接入你的应用。', hint: '本地推理', defaultName: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434' },
  codex: { name: 'Codex', icon: 'terminal', description: '连接已登录的 Codex CLI，通过统一接口使用文本能力。', hint: '实验性适配', defaultName: '本机 Codex', baseUrl: '' }
};
const views = { connections: ['连接与凭证', 'plug'], models: ['模型与服务', 'models'], playground: ['调用测试', 'play'], keys: ['项目访问', 'key'] };
const publicationKey = 'model-dock-publication-draft';
let publicationDraft, publicationError = '';
let catalogRefresh, catalogNotice = '';
const catalogColumns = [
  { key: 'provider', label: '凭证 / 服务', width: 176, min: 128 },
  { key: 'model', label: '模型', width: 280, min: 180 }
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
let token = sessionStorage.getItem('model-dock-token') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { if (fragment.get('token') !== token) sessionStorage.removeItem(publicationKey); token = fragment.get('token'); sessionStorage.setItem('model-dock-token', token); history.replaceState(null, '', location.pathname + location.search); }
try {
  const saved = JSON.parse(sessionStorage.getItem(publicationKey) || 'null');
  if (Number.isSafeInteger(saved?.revision) && Array.isArray(saved.changes)) {
    const changes = new Map(saved.changes.filter(row => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'boolean'));
    if (changes.size) publicationDraft = { revision: saved.revision, changes };
  }
} catch { sessionStorage.removeItem(publicationKey); }
const usable = model => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);
const usableModels = () => state.models.filter(usable);
const availableChoices = () => usableModels().map(model => ({ id: model.id, name: `${model.name} · ${state.connections.find(c => c.id === model.connectionId)?.name}` }));
const modelLabel = id => state.models.find(model => model.id === id)?.name || id;
const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url === '/admin/state') { token = ''; sessionStorage.removeItem('model-dock-token'); }
    const error = new Error(data.error?.message || `请求失败（${response.status}）`);
    error.code = data.error?.code;
    throw error;
  }
  return data;
}
async function load(renderPage = true) { state = await api('/admin/state'); if (renderPage) render(); }
async function mutate(url, method, body = {}, revision = state.revision) {
  if (busy || catalogRefresh) throw new Error('正在处理，请稍候。');
  busy = true;
  try {
    const result = await api(url, { method, body: { ...body, revision } });
    state = result.state; return result;
  } catch (error) { try { await load(false); } catch {} throw error; }
  finally { busy = false; }
}
function login(error = '') {
  $('#app').innerHTML = `<main class="login"><div class="login-card"><div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div><h1>管理你的模型服务</h1><p>在启动终端运行 <code>npm run token</code> 获取本机管理令牌，或通过 <code>npm start -- --open</code> 直接打开。</p><form id="login-form"><label>管理令牌<input name="token" type="password" placeholder="md_admin_…" autocomplete="off" required></label><div class="form-error" role="alert">${escape(error)}</div><button class="primary">进入工作台 ${icon('arrow')}</button></form><p>管理令牌仅用于本机管理。接入其他项目时，请创建独立的项目访问密钥。</p></div></main>`;
}
function empty(title, text, name = 'models') { return `<div class="empty">${icon(name)}<strong>${title}</strong><p>${text}</p></div>`; }
function stats() {
  return `<div class="stats">${[[state.connections.length, '已添加的连接', 'plug'], [usableModels().length, '已发布的模型', 'models'], [state.keys.length, '项目密钥', 'key']].map(([value, label, symbol]) => `<div class="stat"><div class="stat-icon">${icon(symbol)}</div><div><strong>${value}</strong><span>${label}</span></div></div>`).join('')}</div>`;
}
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
}

function focusCatalogControl(key) {
  if (key) {
    const control = [...document.querySelectorAll('.catalog-manager [data-catalog-focus]')].find(node => node.dataset.catalogFocus === key);
    control?.focus({ preventScroll: true });
  }
}
function connectionsPage() {
  return `${modelServiceHeading}<div class="between page-heading"><div><div class="eyebrow">CONNECTIONS</div><h1>让你的模型，各就各位。</h1><p>接入自己的 API 和本机能力，用一个接口连接所有项目。</p></div><button class="quiet small-button" data-action="refresh">${icon('refresh')} 刷新状态</button></div>${stats()}<div class="section-header between"><div><h2>添加模型来源</h2><p>选择适合你的连接方式，凭证保存在本机。</p></div><span class="tag">3 种接入方式</span></div><div class="cards">${Object.entries(types).map(([id, type]) => `<article class="card provider-card"><div class="between"><div class="row"><span class="provider-icon ${id}">${icon(type.icon)}</span><div><h3>${type.name}</h3><small>${type.hint}</small></div></div>${id === 'codex' ? '<span class="tag">Beta</span>' : ''}</div><p class="description">${type.description}</p><button data-action="add-connection" data-type="${id}">${icon('plus')} 添加${type.name === '模型 API' ? ' API 连接' : ` ${type.name}`}</button></article>`).join('')}</div><div class="section-header between"><div><h2>我的连接 <span class="muted">${state.connections.length}</span></h2><p>发现模型后，前往“模型与服务”发布。</p></div><button class="quiet small-button" data-view="models">管理模型 ${icon('arrow')}</button></div>${state.connections.length ? `<div class="cards">${state.connections.map(connectionCard).join('')}</div>` : empty('还没有添加连接', '先选择上方的一种模型来源。你可以同时接入多个 API，以及本机 Codex 和 Ollama。', 'plug')}<div class="endpoint"><div><h3>一个地址，接入你的项目 <span class="tag blue">OpenAI-compatible</span></h3><code>${escape(state.baseUrl)}</code><p>发布模型后，使用独立项目密钥接入你的应用。</p></div><button data-action="copy-endpoint">${icon('copy')} 复制地址</button></div>`;
}
function connectionCard(connection) {
  const type = types[connection.type], models = state.models.filter(model => model.connectionId === connection.id);
  const status = !connection.enabled ? ['已停用', ''] : connection.status === 'connected' ? ['检查成功', 'good'] : connection.status === 'error' ? ['检查失败', 'error'] : ['未检查', ''];
  return `<article class="card connection-card"><div class="between"><div class="row"><span class="provider-icon ${connection.type}">${icon(type.icon)}</span><div><h3>${escape(connection.name)}</h3><small>${type.name}</small></div></div><span class="tag ${status[1]}">${status[0]}</span></div><div class="connection-url mono" title="${escape(connection.baseUrl)}">${escape(connection.baseUrl || '使用本机已登录的 Codex CLI')}</div><div class="between"><small>${models.filter(model => model.available !== false).length} 个模型 · ${models.filter(usable).length} 个已启用</small><small>${connection.hasKey ? '已保存密钥' : connection.type === 'codex' ? '本机登录' : '未设置密钥'}</small></div><div class="status-line">${connection.checkedAt ? `上次检查 ${timestamp(connection.checkedAt)}` : '尚未发现模型'}${connection.errorCode ? ` · ${escape(connection.errorCode)}` : ''}</div><div class="card-footer between"><button class="small-button" data-action="discover" data-id="${connection.id}">${icon('refresh')} 发现模型</button><div class="row"><button class="quiet small-button" data-action="edit-connection" data-id="${connection.id}">编辑</button><button class="quiet small-button" data-action="delete-connection" data-id="${connection.id}">移除</button></div></div></article>`;
}
const modelServiceHeading = '<div class="cm-page-heading"><h1>模型服务</h1></div>';
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

function rememberPublication() {
  try {
    if (publicationDraft) {
      const { revision, changes } = publicationDraft;
      sessionStorage.setItem(publicationKey, JSON.stringify({ revision, changes: [...changes] }));
    } else sessionStorage.removeItem(publicationKey);
  } catch {
    if (publicationDraft) publicationError = '无法暂存草稿，请在关闭页面前保存。';
  }
}

function modelTags(model) {
  const capabilities = model.capabilities || {};
  const tags = [];
  if (capabilities.text === true) tags.push('文本生成');
  if (capabilities.tools === true) tags.push('工具调用');
  if (capabilities.structured === true) tags.push('结构化输出');
  if (capabilities.thinking === true || model.reasoningEfforts?.length) tags.push('深度思考');
  return tags;
}

function reasoningLevels(model) {
  const declared = model.reasoningEfforts || [];
  return {
    declared,
    allowed: model.reasoningPolicy?.allowedEfforts || declared,
    defaultEffort: model.reasoningPolicy?.defaultEffort || model.defaultEffort
  };
}

function compactTokens(value) {
  if (value % 1_048_576 === 0) return `${value / 1_048_576}M`;
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return value.toLocaleString();
}

function catalogModel(model, connection) {
  const available = model.available !== false && connection.enabled;
  const enabled = publicationDraft?.changes.get(model.id) ?? model.enabled;
  const { declared, allowed, defaultEffort } = reasoningLevels(model);
  const tags = modelTags(model);
  return `<div class="catalog-model" data-model-id="${escape(model.id)}">
    <div class="catalog-model-info">
      <h3>${escape(model.name)}</h3>
      ${tags.length ? `<div class="catalog-badges">${tags.map(tag => `<span class="catalog-badge">${escape(tag)}</span>`).join('')}</div>` : ''}
      <div class="catalog-limits">${model.contextWindow ? `上下文 ${compactTokens(model.contextWindow)} tokens` : '上下文上限未声明'}
        <button class="catalog-icon" data-action="model-details" data-id="${escape(model.id)}" data-catalog-focus="details:${escape(model.id)}"
          aria-label="查看${escape(model.name)}详情" aria-haspopup="dialog">${icon('info')}</button>
      </div>
      <div class="catalog-publication">
        <button class="catalog-switch" role="switch" aria-checked="${enabled}" aria-label="发布 ${escape(model.name)}"
          data-action="publish-model" data-id="${escape(model.id)}" data-catalog-focus="publish:${escape(model.id)}"
          ${busy || catalogRefresh || !available && !enabled ? 'disabled' : ''}><span class="catalog-track" aria-hidden="true"></span>${enabled ? '已发布' : '未发布'}</button>
        ${available ? '' : '<span class="catalog-warning">当前不可用</span>'}
      </div>
    </div>
    <div class="catalog-reasoning">
      ${declared.length ? `<div class="catalog-levels">${declared.map(level => {
        const open = allowed.includes(level), pinned = open && level === defaultEffort;
        return `<span class="catalog-level" data-allowed="${open}" data-default="${pinned}">${escape(effortLabels[level] ? `${effortLabels[level]}（${level}）` : level)}${pinned ? '<small>默认</small>' : open ? '' : '<small>未开放</small>'}</span>`;
      }).join('')}</div>` : '<span class="catalog-muted">未声明</span>'}
    </div>
  </div>`;
}

const connectionErrors = {
  upstream_auth_failed: '请检查 API 密钥和模型目录权限。',
  upstream_unreachable: '无法连接服务，请检查服务地址和运行状态。',
  upstream_rate_limited: '服务限流，请稍后重试。',
  upstream_protocol_error: '服务返回了无法读取的模型目录。',
  codex_auth_required: '请先登录本机 Codex CLI。',
  codex_unavailable: '无法启动本机 Codex CLI，请检查安装状态。',
  codex_timeout: 'Codex 未及时响应，请重试。'
};

function connectionHealth(connection, models) {
  if (!connection?.enabled) return { status: 'disabled', label: '服务已停用' };
  if (catalogRefresh?.id === connection.id) return { status: 'checking', label: '正在检测…' };
  const apiSource = connection.type === 'openai';
  if (connection.status === 'error') {
    return {
      status: 'error',
      label: apiSource ? 'API 异常' : '连接异常',
      detail: connectionErrors[connection.errorCode] || '连接检测失败，请重试。'
    };
  }
  if (connection.status === 'connected') {
    if (apiSource) return { status: 'connected', label: 'API 连接正常' };
    const available = models.filter(model => model.available !== false).length;
    if (!available) return { status: 'unknown', label: '暂无可用模型' };
    if (available < models.length) return { status: 'unknown', label: '部分模型未就绪' };
    return { status: 'connected', label: '运行中' };
  }
  return { status: 'unknown', label: apiSource ? 'API 待验证' : '待验证' };
}

function catalogConnection(connection, models, total) {
  const { status, label, detail } = connectionHealth(connection, total);
  const checking = status === 'checking';
  const checkTitle = checking ? '正在检测连接…' : '刷新连接状态并更新此服务的模型目录';
  const lastCheck = connection.checkedAt ? `上次检测 ${timestamp(connection.checkedAt)}` : '尚未检测';
  const statusTitle = `${lastCheck}\n连接状态来自模型目录检测。`;
  return `<section class="catalog-group" aria-label="${escape(connection.name)}模型">
    <div class="catalog-source">
      <h2>${escape(connection.name)}</h2>
      <p>${escape(types[connection.type]?.name)}${connection.hasKey ? ' · 已配置密钥' : ''}</p>
      <span class="catalog-badge">${total.filter(model => model.available !== false).length} / ${total.length} 已配置</span>
      <div class="catalog-runtime" data-status="${status}" title="${escape(statusTitle)}">
        <span class="catalog-status-dot" aria-hidden="true"></span>
        <span role="status">${label}</span>
        <button type="button" class="catalog-icon catalog-status-refresh" data-action="check-connection" data-id="${escape(connection.id)}"
          data-catalog-focus="check:${escape(connection.id)}" aria-label="刷新${escape(connection.name)}连接状态" title="${checkTitle}"
          aria-busy="${checking}" ${busy || catalogRefresh || !connection.enabled ? 'disabled' : ''}>${icon('refresh')}</button>
      </div>
      ${detail ? `<p class="catalog-runtime-error">${escape(detail)}</p>` : ''}
      ${connection.type === 'openai' ? `<button class="catalog-text" data-action="add-model" data-id="${escape(connection.id)}" ${busy || catalogRefresh ? 'disabled' : ''}>手动添加模型</button>` : ''}
    </div>
    <div>${models.length ? models.map(model => catalogModel(model, connection)).join('') : '<p class="catalog-empty">尚未发现模型</p>'}</div>
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
    <span>思考深度（可用 / 默认）</span></div>${groups}</div>`;
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
  const dirty = publicationDraft?.changes.size || 0;
  const conflict = publicationDraft && publicationDraft.revision !== state.revision;
  const pending = Boolean(busy || catalogRefresh);
  const refreshing = Boolean(catalogRefresh?.all);
  const refreshLabel = refreshing ? '正在刷新…' : dirty ? '更新目录（保留修改）' : '刷新目录';
  const feedback = dirty ? `${dirty} 项未保存` : catalogNotice;
  const unavailable = state.models.some(model => publicationDraft?.changes.get(model.id) === true
    && (model.available === false || !state.connections.find(connection => connection.id === model.connectionId)?.enabled));
  const enabled = state.models.filter(model => publicationDraft?.changes.get(model.id) ?? model.enabled).length;
  return `<div class="cm-page-heading"><h1>${icon('models')} 模型与服务</h1></div>
    <section class="catalog-manager" aria-label="模型与服务" aria-busy="${pending}">
      <div class="catalog-toolbar">
        <div class="catalog-filters" role="group" aria-label="模型类型筛选">
          ${catalogFilters.map(([key, label]) => `<button type="button" data-action="catalog-filter" data-value="${key}"
            data-catalog-focus="filter:${key}" aria-pressed="${modelFilter === key}">${label}</button>`).join('')}
        </div>
        <div class="catalog-actions">
          <span class="catalog-muted">已发布 ${enabled} / ${state.models.length}</span>
          <button class="catalog-save ${dirty ? 'primary' : ''}" data-action="save-publication" data-catalog-focus="save"
            ${!dirty || pending || conflict || unavailable ? 'disabled' : ''}>${dirty ? `保存更改 · ${dirty}` : '已保存'}</button>
        </div>
      </div>
      <div class="catalog-secondary">
        <input id="catalog-search" type="search" data-catalog-focus="search" aria-label="搜索模型或供应商" placeholder="搜索模型或供应商…" value="${escape(modelSearch)}">
        <div class="catalog-actions">
          ${feedback ? `<span class="catalog-muted" role="status">${feedback}</span>` : ''}
          <button class="catalog-text" data-view="connections">管理连接与凭证</button>
          <button class="catalog-text" data-action="revert-publication" ${!dirty || pending ? 'disabled' : ''}>撤销更改</button>
          <button class="catalog-text catalog-refresh" data-action="refresh-catalog" data-catalog-focus="refresh" aria-busy="${refreshing}"
            title="检查已启用的服务并更新模型目录" ${pending ? 'disabled' : ''}>${icon('refresh')}${refreshLabel}</button>
        </div>
      </div>
      ${conflict ? '<p class="catalog-feedback" role="status">目录已在其他页面更新。发布草稿已保留，请撤销更改后重新编辑。</p>' : ''}
      ${unavailable && !conflict ? '<p class="catalog-feedback" role="status">有待发布的模型已不可用。请调整对应的发布开关后保存。</p>' : ''}
      ${publicationError ? `<p class="catalog-feedback catalog-warning" role="alert">${escape(publicationError)}</p>` : ''}
      <div id="catalog-table" class="catalog-scroll" role="region" tabindex="0" aria-label="按凭证查看模型与服务">${modelTable()}</div>
    </section>`;
}

function advancePublicationDraft(previousRevision) {
  // Discovery only updates the catalog. A different revision jump can include
  // another tab's publication changes and must remain a save conflict.
  if (publicationDraft?.revision === previousRevision && state.revision === previousRevision + 1) {
    publicationDraft.revision = state.revision;
    rememberPublication();
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
    advancePublicationDraft(revision);
    return true;
  } catch (error) {
    await load(false);
    const connection = state.connections.find(item => item.id === id);
    const recordedFailure = connection?.status === 'error' && connection.errorCode === error.code
      && connection.checkedAt && connection.checkedAt !== checkedAt;
    if (recordedFailure && error.code !== 'revision_conflict') {
      advancePublicationDraft(revision);
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
  publicationError = '';
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
      publicationError = `${failed} 个服务检测失败。已保留原有目录，请查看各服务的状态。`;
    } else if (!failed) {
      catalogNotice = all ? '目录已更新' : '连接检测完成';
    }
  } catch (error) {
    publicationError = error.code === 'revision_conflict' ? '目录已更新，请重新检测连接。' : '刷新失败，请重试。';
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
  return `<div class="page-heading"><div class="eyebrow">PLAYGROUND</div><h1>在接入前，先试一次。</h1><p>通过网关发送真实请求，检查流式输出与用量；调用会使用所选来源的额度。</p></div><div class="playground"><form id="play-form" class="card stack"><h2>发送请求</h2><label>模型<select name="model" required>${choices.length ? choices.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('') : '<option value="">请先发布一个模型</option>'}</select></label><label>提示词<textarea name="prompt" rows="6" placeholder="你好，用一句话介绍你自己。" required></textarea></label><label class="checkbox-label"><input type="checkbox" name="stream" checked>流式输出</label><div class="row"><button class="primary" id="send-button" ${choices.length ? '' : 'disabled'}>${icon('play')} 发送请求</button><button type="button" id="stop-button" data-action="stop" disabled>停止</button></div></form><section class="card"><div class="between"><h2>模型响应</h2><span class="tag" id="response-status">等待请求</span></div><div class="response empty-output" id="response-output" role="log" aria-live="polite">选择一个模型，发送你的第一条消息。</div><div id="response-meta" class="output-meta">输出和提示词不会写入网关日志。</div></section></div>${requestHistory()}${snippet()}`;
}
function requestHistory() {
  const rows = [...state.active.map(row => ({ ...row, status: 'running', durationMs: Date.now() - new Date(row.startedAt).getTime() })), ...state.requests].slice(0, 8);
  const statuses = { succeeded: '已完成', failed: '失败', cancelled: '已取消', running: '进行中' };
  return `<div class="section-header"><h2>最近请求</h2><p>仅保留本次网关运行中的元数据，最多 100 条。</p></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>模型</th><th>结果</th><th>耗时</th><th>Token 用量</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escape(row.model)}</strong><small>${escape(timestamp(row.startedAt))}</small></td><td><span class="request-status ${row.status}">${statuses[row.status]}</span>${row.errorCode ? `<br><small>${escape(row.errorCode)}</small>` : ''}</td><td>${(row.durationMs / 1000).toFixed(1)}s</td><td>${row.usage ? row.usage.total_tokens.toLocaleString() : '未报告'}</td><td>${row.status === 'running' ? `<button class="small-button" data-action="cancel-request" data-id="${row.id}">取消</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无调用记录', '请求完成后，这里会显示来源、耗时和上游实际报告的 Token 用量。', 'play')}`;
}
function snippet() {
  const model = availableChoices()[0]?.id || 'connection-id/model-id';
  const code = `curl ${state.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello!' }] })}'`;
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
  if (generation) return;
  const fields = new FormData(form), streaming = fields.has('stream');
  const controller = new AbortController(); generation = controller;
  $('#send-button').disabled = true; $('#stop-button').disabled = false;
  const output = $('#response-output'); output.classList.remove('empty-output'); output.textContent = '';
  $('#response-status').textContent = '请求中'; $('#response-meta').textContent = '正在等待模型响应…';
  let measurement, content = '', ended = false; const started = performance.now();
  try {
    const response = await fetch('/v1/chat/completions', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model: fields.get('model'), messages: [{ role: 'user', content: fields.get('prompt') }], stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}) }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || '请求失败'); }
    if (streaming) {
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
    generation = null; $('#send-button').disabled = false; $('#stop-button').disabled = true;
    $('#response-meta').textContent = `${((performance.now() - started) / 1000).toFixed(1)} 秒 · ${measurement ? `输入 ${measurement.prompt_tokens} / 输出 ${measurement.completion_tokens} tokens` : '上游未报告用量'}`;
    try { await load(false); } catch {}
  }
}
document.addEventListener('input', event => {
  if (event.target.id !== 'catalog-search') return;
  modelSearch = event.target.value;
  $('#catalog-table').innerHTML = modelTable();
  applyCatalogWidths();
});
document.addEventListener('keydown', event => {
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
      publicationDraft = undefined;
      publicationError = '';
      rememberPublication();
    }
    token = nextToken;
    try { await load(); sessionStorage.setItem('model-dock-token', token); } catch (error) { login(error.message); }
  } else if (event.target.id === 'play-form') { event.preventDefault(); void generate(event.target); }
});
document.addEventListener('click', async event => {
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
    if (action === 'close-dialog') $('#dialog').close();
    if (action === 'refresh') { await load(); toast('状态已刷新。'); }
    if (action === 'logout') {
      if (generation) { toast('请先停止或等待当前请求。'); return; }
      token = '';
      sessionStorage.removeItem('model-dock-token');
      publicationDraft = undefined;
      publicationError = catalogNotice = '';
      rememberPublication();
      state = null;
      login();
    }
    if (action === 'copy-endpoint') { await navigator.clipboard.writeText(state.baseUrl); toast('地址已复制。'); }
    if (action === 'copy-example') { await navigator.clipboard.writeText($('#example-code').textContent); toast('接入示例已复制。'); }
    if (action === 'add-connection') connectionDialog(button.dataset.type);
    if (action === 'edit-connection') { const connection = state.connections.find(item => item.id === id); connectionDialog(connection.type, connection); }
    if (action === 'catalog-filter') {
      modelFilter = button.dataset.value;
      render();
      $('.catalog-filters [aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    if (action === 'refresh-catalog') await refreshModelServices();
    if (action === 'check-connection') await refreshModelServices(id);
    if (action === 'revert-publication') {
      publicationDraft = undefined;
      publicationError = '';
      catalogNotice = '已撤销未保存的更改';
      rememberPublication();
      render();
    }
    if (action === 'model-details') {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      const connection = state.connections.find(item => item.id === model.connectionId);
      const { declared, allowed, defaultEffort } = reasoningLevels(model);
      const models = state.models.filter(item => item.connectionId === model.connectionId);
      const health = connectionHealth(connection, models);
      const lastCall = state.requests.find(request => request.connectionId === model.connectionId
        && request.nativeModel === model.nativeId && ['succeeded', 'failed'].includes(request.status));
      const fields = [
        ['凭证 / 服务', connection?.name],
        ['模型 ID', model.id],
        ['模型能力', modelTags(model).join('、') || '上游未声明'],
        ['连接状态', [health.label, health.detail].filter(Boolean).join(' · ')],
        ['上次检测', timestamp(connection?.checkedAt)],
        ...(lastCall ? [['最近调用', `${lastCall.status === 'succeeded' ? '成功' : '失败'} · ${timestamp(lastCall.startedAt)}`]] : []),
        ['上下文上限', model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : '上游未声明'],
        ['可用思考深度', declared.filter(level => allowed.includes(level)).join('、') || '上游未声明'],
        ['默认思考深度', defaultEffort && declared.includes(defaultEffort) && allowed.includes(defaultEffort) ? defaultEffort : '由上游决定']
      ];
      showDialog(model.name, '模型规格与网关当前公布的能力。', `<dl class="catalog-details">${fields.map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`, '关闭', async () => $('#dialog').close());
    }
    if (action === 'discover') {
      const revision = state.revision;
      button.disabled = true; button.textContent = '正在发现…';
      try {
        await mutate(`/admin/connections/${encodeURIComponent(id)}/discover`, 'POST');
      } catch (error) {
        if (state.connections.some(connection => connection.id === id && connection.status === 'error' && connection.errorCode === error.code)) {
          advancePublicationDraft(revision);
        }
        throw error;
      }
      advancePublicationDraft(revision);
      render(); toast('目录已更新，新模型需要手动发布。');
    }
    if (action === 'add-model') showDialog('手动添加模型', '适用于未提供模型列表接口的 API。请填写供应商实际支持的模型 ID。', '<label>模型 ID<input name="nativeId" placeholder="供应商模型 ID" required></label><label>显示名称（可选）<input name="name" placeholder="便于识别的名称"></label>', '添加模型', async form => {
      await mutate('/admin/models', 'POST', { connectionId: id, ...Object.fromEntries(form) }); $('#dialog').close(); render(); toast('模型已添加，请手动发布。');
    });
    if (action === 'publish-model') {
      const model = state.models.find(item => item.id === id);
      if (!model) return;
      const enabled = publicationDraft?.changes.get(id) ?? model.enabled;
      if (!publicationDraft) publicationDraft = { revision: state.revision, changes: new Map() };
      const next = !enabled;
      if (next === model.enabled) publicationDraft.changes.delete(id);
      else publicationDraft.changes.set(id, next);
      if (!publicationDraft.changes.size) publicationDraft = undefined;
      publicationError = '';
      catalogNotice = '';
      rememberPublication();
      render();
    }
    if (action === 'save-publication' && publicationDraft) {
      const { revision, changes } = publicationDraft;
      const models = state.models.map(model => ({ id: model.id, enabled: changes.get(model.id) ?? model.enabled }));
      button.disabled = true;
      await mutate('/admin/model-settings', 'PATCH', { models }, revision);
      publicationDraft = undefined;
      publicationError = '';
      catalogNotice = '全部更改已保存';
      rememberPublication();
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
    if (action === 'save-publication') publicationError = `${error.message} 未保存的发布更改已保留。`;
    toast(error.message, true);
    if (['discover', 'save-publication'].includes(action)) render();
  }
  finally { button.disabled = false; }
});
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
if (token) { try { await load(); } catch (error) { login(error.message); } } else login();
const refreshTimer = setInterval(async () => {
  if (!token || !state || busy || catalogRefresh || generation || $('#dialog').open || document.visibilityState !== 'visible' || view === 'playground') return;
  const currentToken = token;
  try {
    const next = await api('/admin/state');
    if (currentToken !== token || busy || catalogRefresh || generation || $('#dialog').open || view === 'playground' || next.revision < state.revision) return;
    const changed = next.revision !== state.revision;
    state = next;
    if (changed) render();
  } catch {}
}, 15_000);
const popstate = () => { const next = new URLSearchParams(location.search).get('view') || 'connections'; if (views[next] && !generation) { view = next; render(); } };
window.addEventListener('popstate', popstate);
export function dispose() { clearInterval(refreshTimer); clearTimeout(toastTimer); generation?.abort(); window.removeEventListener('popstate', popstate); }
