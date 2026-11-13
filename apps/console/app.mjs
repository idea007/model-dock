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
const views = { connections: ['连接与凭证', 'plug'], models: ['功能与模型', 'models'], playground: ['调用测试', 'play'], keys: ['项目访问', 'key'] };
let state, view = 'connections', modelView = 'connections', search = '', busy = false, generation, toastTimer;
let token = sessionStorage.getItem('model-dock-token') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { token = fragment.get('token'); sessionStorage.setItem('model-dock-token', token); history.replaceState(null, '', location.pathname); }
const usable = model => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled);
const usableModels = () => state.models.filter(usable);
const availableChoices = () => [...state.routes.filter(route => state.models.some(model => model.id === route.modelId && usable(model))).map(route => ({ id: route.id, name: `${route.name} · ${route.id}` })), ...usableModels().map(model => ({ id: model.id, name: `${model.name} · ${state.connections.find(c => c.id === model.connectionId)?.name}` }))];
const modelLabel = id => state.models.find(model => model.id === id)?.name || id;
const timestamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url === '/admin/state') { token = ''; sessionStorage.removeItem('model-dock-token'); }
    throw new Error(data.error?.message || `请求失败（${response.status}）`);
  }
  return data;
}
async function load(renderPage = true) { state = await api('/admin/state'); if (renderPage) render(); }
async function mutate(url, method, body = {}) {
  if (busy) return;
  busy = true;
  try {
    const result = await api(url, { method, body: { ...body, revision: state.revision } });
    state = result.state; return result;
  } catch (error) { try { await load(false); } catch {} throw error; }
  finally { busy = false; }
}
function login(error = '') {
  $('#app').innerHTML = `<main class="login"><div class="login-card"><div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div><h1>连接你的模型工作台</h1><p>在启动终端运行 <code>npm run token</code> 获取本机管理令牌，或通过 <code>npm start -- --open</code> 直接打开。</p><form id="login-form"><label>管理令牌<input name="token" type="password" placeholder="md_admin_…" autocomplete="off" required></label><div class="form-error" role="alert">${escape(error)}</div><button class="primary">进入工作台 ${icon('arrow')}</button></form><p>管理令牌仅用于本机管理。接入其他项目时，请创建独立的项目访问密钥。</p></div></main>`;
}
function empty(title, text, name = 'models') { return `<div class="empty">${icon(name)}<strong>${title}</strong><p>${text}</p></div>`; }
function stats() {
  return `<div class="stats">${[[state.connections.length, '已添加的连接', 'plug'], [usableModels().length, '已启用的模型', 'models'], [state.routes.length, '功能别名', 'arrow']].map(([value, label, symbol]) => `<div class="stat"><div class="stat-icon">${icon(symbol)}</div><div><strong>${value}</strong><span>${label}</span></div></div>`).join('')}</div>`;
}
function render() {
  if (!token || !state) return login();
  const current = views[view];
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('dock')}</span>Model Dock</div><div class="sidebar-sub">Your models. Connected.</div><div class="nav-label">工作台 / WORKSPACE</div><nav class="nav" aria-label="主导航">${Object.entries(views).map(([id, [name, symbol]]) => `<button data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}>${icon(symbol)}${name}</button>`).join('')}</nav><div class="sidebar-bottom"><p><span class="local-dot"></span>本机网关</p><small>v${escape(state.version)} · 127.0.0.1</small><div><button class="quiet" data-action="logout">退出管理会话</button></div></div></aside><div class="main"><header class="topbar"><div class="crumb"><span>工作台</span><span>/</span><strong>${current[0]}</strong></div><span class="pill"><span class="local-dot"></span>本地运行</span></header><main class="page">${view === 'connections' ? connectionsPage() : view === 'models' ? modelsPage() : view === 'playground' ? playgroundPage() : keysPage()}<p class="footer-note">模型与凭证由你掌握 · Model Dock</p></main></div></div>`;
  if (view === 'models') renderModelList();
}
function connectionsPage() {
  return `<div class="between page-heading"><div><div class="eyebrow">CONNECTIONS</div><h1>让你的模型，各就各位。</h1><p>接入自己的 API 和本机能力，用一个接口连接所有项目。</p></div><button class="quiet small-button" data-action="refresh">${icon('refresh')} 刷新状态</button></div>${stats()}<div class="section-header between"><div><h2>添加模型来源</h2><p>选择适合你的连接方式，凭证保存在本机。</p></div><span class="tag">3 种接入方式</span></div><div class="cards">${Object.entries(types).map(([id, type]) => `<article class="card provider-card"><div class="between"><div class="row"><span class="provider-icon ${id}">${icon(type.icon)}</span><div><h3>${type.name}</h3><small>${type.hint}</small></div></div>${id === 'codex' ? '<span class="tag">Beta</span>' : ''}</div><p class="description">${type.description}</p><button data-action="add-connection" data-type="${id}">${icon('plus')} 添加${type.name === '模型 API' ? ' API 连接' : ` ${type.name}`}</button></article>`).join('')}</div><div class="section-header between"><div><h2>我的连接 <span class="muted">${state.connections.length}</span></h2><p>发现模型后，前往“功能与模型”启用。</p></div><button class="quiet small-button" data-view="models">管理模型 ${icon('arrow')}</button></div>${state.connections.length ? `<div class="cards">${state.connections.map(connectionCard).join('')}</div>` : empty('还没有添加连接', '先选择上方的一种模型来源。你可以同时接入多个 API，以及本机 Codex 和 Ollama。', 'plug')}<div class="endpoint"><div><h3>一个地址，接入你的项目 <span class="tag blue">OpenAI-compatible</span></h3><code>${escape(state.baseUrl)}</code><p>使用项目访问密钥和模型 ID，或为功能配置稳定的模型别名。</p></div><button data-action="copy-endpoint">${icon('copy')} 复制地址</button></div>`;
}
function connectionCard(connection) {
  const type = types[connection.type], models = state.models.filter(model => model.connectionId === connection.id);
  const status = !connection.enabled ? ['已停用', ''] : connection.status === 'connected' ? ['检查成功', 'good'] : connection.status === 'error' ? ['检查失败', 'error'] : ['未检查', ''];
  return `<article class="card connection-card"><div class="between"><div class="row"><span class="provider-icon ${connection.type}">${icon(type.icon)}</span><div><h3>${escape(connection.name)}</h3><small>${type.name}</small></div></div><span class="tag ${status[1]}">${status[0]}</span></div><div class="connection-url mono" title="${escape(connection.baseUrl)}">${escape(connection.baseUrl || '使用本机已登录的 Codex CLI')}</div><div class="between"><small>${models.filter(model => model.available !== false).length} 个模型 · ${models.filter(usable).length} 个已启用</small><small>${connection.hasKey ? '已保存密钥' : connection.type === 'codex' ? '本机登录' : '未设置密钥'}</small></div><div class="status-line">${connection.checkedAt ? `上次检查 ${timestamp(connection.checkedAt)}` : '尚未发现模型'}${connection.errorCode ? ` · ${escape(connection.errorCode)}` : ''}</div><div class="card-footer between"><button class="small-button" data-action="discover" data-id="${connection.id}">${icon('refresh')} 发现模型</button><div class="row"><button class="quiet small-button" data-action="edit-connection" data-id="${connection.id}">编辑</button><button class="quiet small-button" data-action="delete-connection" data-id="${connection.id}">移除</button></div></div></article>`;
}
function modelsPage() {
  return `<div class="between page-heading"><div><div class="eyebrow">MODELS & FUNCTIONS</div><h1>为每个功能，选好模型。</h1><p>按连接管理模型，或用稳定的功能别名连接不同项目。</p></div><button class="primary" data-action="add-route">${icon('plus')} 添加功能</button></div>${stats()}<div class="toolbar"><div class="segmented" aria-label="模型视图"><button data-model-view="connections" class="${modelView === 'connections' ? 'selected' : ''}">按连接</button><button data-model-view="functions" class="${modelView === 'functions' ? 'selected' : ''}">按功能</button></div><label class="visually-hidden" for="model-search">搜索模型或功能</label><input id="model-search" type="search" placeholder="搜索模型、连接或功能…" value="${escape(search)}"></div><div id="model-list"></div><div class="info-box">${icon('info')}<div><strong>明确选择，始终使用同一个来源</strong>新发现的模型默认关闭。模型离线或被停用时，请求会明确失败，不会自动改用另一套凭证。功能别名可以保持项目代码不变，由你主动调整目标模型。</div></div>`;
}
function renderModelList() {
  const needle = search.toLowerCase();
  if (modelView === 'functions') {
    const routes = state.routes.filter(route => `${route.id} ${route.name} ${modelLabel(route.modelId)}`.toLowerCase().includes(needle));
    $('#model-list').innerHTML = routes.length ? `<div class="stack">${routes.map(route => {
      const model = state.models.find(item => item.id === route.modelId), connection = state.connections.find(item => item.id === model?.connectionId);
      return `<div class="card route-card"><div class="row"><span class="provider-icon">${icon('arrow')}</span><div><h3>${escape(route.name)}</h3><code>${escape(route.id)}</code></div><span class="arrow">→</span><div><h3>${escape(model?.name || '目标模型已移除')}</h3><small>${escape(connection?.name || route.modelId)}</small></div></div><div class="row"><span class="tag ${model && usable(model) ? 'good' : 'error'}">${model && usable(model) ? '可调用' : '不可用'}</span><button class="quiet small-button" data-action="edit-route" data-id="${escape(route.id)}">编辑</button><button class="quiet small-button" data-action="delete-route" data-id="${escape(route.id)}">删除</button></div></div>`;
    }).join('')}</div>` : empty('还没有匹配的功能', '添加“聊天”“摘要”等功能，将别名绑定到具体模型。其他项目使用别名即可调用。');
    return;
  }
  const connections = state.connections.filter(connection => !needle || connection.name.toLowerCase().includes(needle) || state.models.some(model => model.connectionId === connection.id && `${model.name} ${model.nativeId}`.toLowerCase().includes(needle)));
  $('#model-list').innerHTML = connections.length ? connections.map(connection => {
    const models = state.models.filter(model => model.connectionId === connection.id && (!needle || `${model.name} ${model.nativeId} ${connection.name}`.toLowerCase().includes(needle)));
    return `<div class="table-wrap"><div class="table-head between"><div class="row">${icon(types[connection.type].icon)}<h3>${escape(connection.name)}</h3><span class="tag">${types[connection.type].name}</span></div>${connection.type === 'openai' ? `<button class="small-button" data-action="add-model" data-id="${connection.id}">${icon('plus')} 手动添加模型</button>` : `<button class="small-button" data-action="discover" data-id="${connection.id}">发现模型</button>`}</div>${models.length ? `<table><thead><tr><th>模型 / 调用 ID</th><th>能力</th><th>上下文 / 状态</th><th>启用</th></tr></thead><tbody>${models.map(model => `<tr><td><strong>${escape(model.name)}</strong><small class="mono">${escape(model.id)}</small></td><td><div class="row wrap">${model.capabilities?.text !== false ? '<span class="tag">文本</span>' : ''}${model.capabilities?.tools ? '<span class="tag">工具调用</span>' : ''}${model.capabilities?.structured ? '<span class="tag">JSON</span>' : ''}${model.capabilities?.text === null ? '<span class="tag">能力待验证</span>' : ''}</div>${model.reasoningEfforts?.length ? `<small>${escape(model.reasoningEfforts.join(' / '))}</small>` : ''}</td><td>${model.available === false ? '<span class="tag error">未发现</span>' : `<small>${model.contextWindow ? `${Math.round(model.contextWindow / 1024)}K tokens` : '上游未声明'}</small>`}</td><td><button class="switch" role="switch" aria-checked="${model.enabled}" aria-label="启用 ${escape(model.name)}" data-action="toggle-model" data-id="${escape(model.id)}"></button></td></tr>`).join('')}</tbody></table>` : `<div class="empty"><p>还没有模型。点击“发现模型”获取目录${connection.type === 'openai' ? '，或手动填写模型 ID' : ''}。</p></div>`}</div>`;
  }).join('') : empty('尚未接入个人模型', '前往“连接与凭证”添加自己的 API、本机 Codex 或 Ollama。');
}
function playgroundPage() {
  const choices = availableChoices();
  return `<div class="page-heading"><div class="eyebrow">PLAYGROUND</div><h1>在接入前，先试一次。</h1><p>通过网关发送真实请求，检查流式输出与用量；调用会使用所选来源的额度。</p></div><div class="playground"><form id="play-form" class="card stack"><h2>发送请求</h2><label>模型或功能<select name="model" required>${choices.length ? choices.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('') : '<option value="">请先启用一个模型</option>'}</select></label><label>提示词<textarea name="prompt" rows="6" placeholder="你好，用一句话介绍你自己。" required></textarea></label><label class="checkbox-label"><input type="checkbox" name="stream" checked>流式输出</label><div class="row"><button class="primary" id="send-button" ${choices.length ? '' : 'disabled'}>${icon('play')} 发送请求</button><button type="button" id="stop-button" data-action="stop" disabled>停止</button></div></form><section class="card"><div class="between"><h2>模型响应</h2><span class="tag" id="response-status">等待请求</span></div><div class="response empty-output" id="response-output" role="log" aria-live="polite">选择一个模型，发送你的第一条消息。</div><div id="response-meta" class="output-meta">输出和提示词不会写入网关日志。</div></section></div>${requestHistory()}${snippet()}`;
}
function requestHistory() {
  const rows = [...state.active.map(row => ({ ...row, status: 'running', durationMs: Date.now() - new Date(row.startedAt).getTime() })), ...state.requests].slice(0, 8);
  const statuses = { succeeded: '已完成', failed: '失败', cancelled: '已取消', running: '进行中' };
  return `<div class="section-header"><h2>最近请求</h2><p>仅保留本次网关运行中的元数据，最多 100 条。</p></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>模型 / 功能</th><th>结果</th><th>耗时</th><th>Token 用量</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escape(row.model)}</strong><small>${escape(timestamp(row.startedAt))}</small></td><td><span class="request-status ${row.status}">${statuses[row.status]}</span>${row.errorCode ? `<br><small>${escape(row.errorCode)}</small>` : ''}</td><td>${(row.durationMs / 1000).toFixed(1)}s</td><td>${row.usage ? row.usage.total_tokens.toLocaleString() : '未报告'}</td><td>${row.status === 'running' ? `<button class="small-button" data-action="cancel-request" data-id="${row.id}">取消</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('暂无调用记录', '请求完成后，这里会显示来源、耗时和上游实际报告的 Token 用量。', 'play')}`;
}
function snippet() {
  const model = availableChoices()[0]?.id || 'chat-default';
  const code = `curl ${state.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello!' }] })}'`;
  return `<div class="code-card"><div class="between"><h3>接入示例 · cURL</h3><button class="small-button" data-action="copy-example">${icon('copy')} 复制</button></div><pre id="example-code">${escape(code)}</pre></div>`;
}
function keysPage() {
  return `<div class="between page-heading"><div><div class="eyebrow">PROJECT ACCESS</div><h1>把能力，交给你的项目。</h1><p>为每个项目创建独立密钥，并限定它可以调用的模型或功能。</p></div><button class="primary" data-action="add-key">${icon('plus')} 创建密钥</button></div><div class="endpoint"><div><h3>网关 Base URL</h3><code>${escape(state.baseUrl)}</code><p>在兼容客户端中配置此地址，API Key 使用下方创建的项目密钥。</p></div><button data-action="copy-endpoint">${icon('copy')} 复制地址</button></div><div class="section-header"><h2>项目密钥 <span class="muted">${state.keys.length}</span></h2></div>${state.keys.length ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>密钥</th><th>允许范围</th><th>创建时间</th><th></th></tr></thead><tbody>${state.keys.map(key => `<tr><td><strong>${escape(key.name)}</strong></td><td><code>${escape(key.prefix)}…</code></td><td>${key.models.includes('*') ? '<span class="tag blue">所有已启用模型与功能</span>' : key.models.map(model => `<span class="tag">${escape(modelLabel(model))}</span>`).join(' ')}</td><td><small>${escape(timestamp(key.createdAt))}</small></td><td><button class="quiet danger small-button" data-action="delete-key" data-id="${key.id}">撤销</button></td></tr>`).join('')}</tbody></table></div>` : empty('为第一个项目创建密钥', '上游 API Key 留在网关。项目只持有自己的访问密钥，可以随时撤销。', 'key')}<div class="info-box">${icon('info')}<div><strong>后端或本机应用接入</strong>把密钥放在项目的服务端环境变量中。不要写进公开网页脚本。本机网关默认只接受本机调用；远程设备配对将在后续连接器版本提供。</div></div>${snippet()}`;
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
function routeDialog(existing) {
  const models = state.models;
  if (!models.length) return toast('请先添加连接并发现模型。', true);
  showDialog(existing ? '编辑功能' : '添加功能', '项目使用稳定的功能别名调用，由你指定实际模型。', `<label>功能名称<input name="name" value="${escape(existing?.name || '')}" placeholder="例如：文档摘要" required></label><label>调用别名<input name="id" value="${escape(existing?.id || '')}" placeholder="例如：summarize" ${existing ? 'readonly' : ''} required><small>使用英文字母、数字、点、短横线或下划线。</small></label><label>目标模型<select name="modelId" required>${models.map(model => `<option value="${escape(model.id)}" ${existing?.modelId === model.id ? 'selected' : ''}>${escape(model.name)} · ${escape(state.connections.find(c => c.id === model.connectionId)?.name)}${usable(model) ? '' : '（未启用或不可用）'}</option>`).join('')}</select></label>`, '保存功能', async form => {
    await mutate('/admin/routes', 'POST', Object.fromEntries(form)); $('#dialog').close(); render(); toast('功能映射已保存。');
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
document.addEventListener('submit', async event => {
  if (event.target.id === 'login-form') {
    event.preventDefault(); token = new FormData(event.target).get('token').trim();
    try { await load(); sessionStorage.setItem('model-dock-token', token); } catch (error) { login(error.message); }
  } else if (event.target.id === 'play-form') { event.preventDefault(); void generate(event.target); }
});
document.addEventListener('input', event => { if (event.target.id === 'model-search') { search = event.target.value; renderModelList(); } });
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.view) {
    if (generation) { toast('请先停止或等待当前请求。'); return; }
    view = button.dataset.view; render(); return;
  }
  if (button.dataset.modelView) { modelView = button.dataset.modelView; render(); return; }
  const action = button.dataset.action, id = button.dataset.id;
  if (!action) return;
  if (busy && !['close-dialog', 'stop'].includes(action)) return toast('正在处理，请稍候。');
  try {
    if (action === 'close-dialog') $('#dialog').close();
    if (action === 'refresh') { await load(); toast('状态已刷新。'); }
    if (action === 'logout') { if (generation) { toast('请先停止或等待当前请求。'); return; } token = ''; sessionStorage.removeItem('model-dock-token'); state = null; login(); }
    if (action === 'copy-endpoint') { await navigator.clipboard.writeText(state.baseUrl); toast('地址已复制。'); }
    if (action === 'copy-example') { await navigator.clipboard.writeText($('#example-code').textContent); toast('接入示例已复制。'); }
    if (action === 'add-connection') connectionDialog(button.dataset.type);
    if (action === 'edit-connection') { const connection = state.connections.find(item => item.id === id); connectionDialog(connection.type, connection); }
    if (action === 'discover') {
      button.disabled = true; button.textContent = '正在发现…';
      await mutate(`/admin/connections/${id}/discover`, 'POST'); render(); toast('目录已更新，新模型需要手动启用。');
    }
    if (action === 'toggle-model') {
      const model = state.models.find(item => item.id === id);
      await mutate(`/admin/models/${encodeURIComponent(id)}`, 'PATCH', { enabled: !model.enabled }); render(); toast(model.enabled ? '模型已停用。' : '模型已启用。');
    }
    if (action === 'add-model') showDialog('手动添加模型', '适用于未提供模型列表接口的 API。请填写供应商实际支持的模型 ID。', '<label>模型 ID<input name="nativeId" placeholder="供应商模型 ID" required></label><label>显示名称（可选）<input name="name" placeholder="便于识别的名称"></label>', '添加模型', async form => {
      await mutate('/admin/models', 'POST', { connectionId: id, ...Object.fromEntries(form) }); $('#dialog').close(); render(); toast('模型已添加，请手动启用。');
    });
    if (action === 'add-route') routeDialog();
    if (action === 'edit-route') routeDialog(state.routes.find(item => item.id === id));
    if (action === 'add-key') {
      const choices = availableChoices();
      showDialog('创建项目访问密钥', '密钥只显示一次。默认仅授予你选择的模型或功能。', `<label>项目名称<input name="name" placeholder="例如：我的聊天 demo" required></label><label>允许调用</label><div class="checklist">${choices.map(item => `<label class="checkbox-label"><input type="checkbox" name="models" value="${escape(item.id)}">${escape(item.name)}</label>`).join('')}<label class="checkbox-label"><input type="checkbox" name="models" value="*">所有已启用的模型与功能（含以后新增）</label></div>`, '创建密钥', async form => {
        const result = await mutate('/admin/keys', 'POST', { name: form.get('name'), models: form.getAll('models') });
        $('#dialog').close(); render();
        showDialog('保存你的项目密钥', '复制到项目的服务端环境变量。关闭后将无法再次查看。', `<div class="token-box"><code id="new-token">${escape(result.token)}</code></div><button type="button" data-action="copy-token">${icon('copy')} 复制密钥</button>`, '我已保存', async () => { $('#dialog').close(); });
      });
    }
    if (action === 'copy-token') { await navigator.clipboard.writeText($('#new-token').textContent); toast('项目密钥已复制。'); }
    if (action.startsWith('delete-')) {
      const kind = action.slice(7), endpoint = { connection: 'connections', route: 'routes', key: 'keys' }[kind];
      showDialog(kind === 'key' ? '撤销项目密钥' : kind === 'connection' ? '移除此连接' : '删除此功能', kind === 'connection' ? '会移除此连接的模型和保存的凭证。依赖它的功能将显示不可用，本机工具和模型文件会保留。' : kind === 'key' ? '使用此密钥的项目将失去访问权限，正在进行的请求也会被取消。' : '使用此别名的项目需要重新选择模型或功能。', '', '确认操作', async () => {
        await mutate(`/admin/${endpoint}/${encodeURIComponent(id)}`, 'DELETE'); $('#dialog').close(); render(); toast('操作已完成。');
      });
    }
    if (action === 'stop') generation?.abort();
    if (action === 'cancel-request') { await api(`/admin/requests/${id}/cancel`, { method: 'POST', body: {} }); await load(); toast('已发送取消请求。'); }
  } catch (error) { toast(error.message, true); if (action === 'discover') render(); }
  finally { button.disabled = false; }
});
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
if (token) { try { await load(); } catch (error) { login(error.message); } } else login();
const refreshTimer = setInterval(async () => {
  if (!token || busy || generation || $('#dialog').open || document.visibilityState !== 'visible' || view === 'playground') return;
  try { const revision = state.revision; await load(false); if (state.revision !== revision && (view !== 'models' || !search)) render(); } catch {}
}, 15_000);
export function dispose() { clearInterval(refreshTimer); clearTimeout(toastTimer); generation?.abort(); }
