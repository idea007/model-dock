import { ModelManager } from './models.mjs';
import { sse } from './events.mjs';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const kinds = { chat: '自由对话', extract: '结构化提取', summarize: '文档摘要', rewrite: '文本润色', translate: '多语言翻译', explain: '代码讲解', review: '代码审查' };
const examples = { chat: '用三句话解释什么是模型网关。', extract: '小林计划在周五上午十点与设计团队评审新首页，会议地点是二楼会议室。', summarize: '团队将模型接入集中到网关管理。各应用只需要项目密钥即可访问获授权的模型，并在自己的应用内维护功能、默认模型和思考偏好。', rewrite: '我们把模型接好啦，之后做新功能的时候就可以直接用了，不用每次都搞一遍密钥。', translate: '好的工具应该清楚地划分职责，同时让使用者感到简单。', explain: 'const unique = values => [...new Set(values)];', review: 'async function loadProfile(id) {\n  return fetch(`/users/${id}`).then(res => res.json());\n}' };
const navigation = [['experience', '应用体验', '▷'], ['models', '功能与模型', '◈'], ['settings', '接入设置', '⚙']];
const currentView = () => navigation.find(([id]) => id === new URLSearchParams(location.search).get('view'))?.[0] || 'experience';
let token = '', state, view = currentView();
let featureId = 'chat', chosenModel = '', prompt = '', promptFeature = '', generation, toastTimer, busy = false;
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
  if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}）`);
  return data;
}
async function session() { token = (await api('/api/session', { method: 'POST', headers: { 'x-model-dock-client': '1' } }, false)).session; }
const manager = new ModelManager({ api, onState: next => { state = next; updateConnectionStatus(); }, notify: toast, onDetails: model => dialog(model.name, '项目密钥可见的模型能力。', `<dl class="cm-details"><dt>模型 ID</dt><dd>${esc(model.id)}</dd><dt>模型来源</dt><dd>${esc(model.source?.name)}</dd><dt>上下文上限</dt><dd>${model.contextWindow ? model.contextWindow.toLocaleString() + ' tokens' : '未声明'}</dd><dt>思考深度</dt><dd>${esc(model.reasoningEfforts.join(' / ') || '未声明')}</dd></dl>`, '关闭', async () => $('#dialog').close()) });
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : null;
const usable = model => model?.enabled && model.available !== false && !state.connection.error;
const compatible = (feature, model) => model?.capabilities?.text !== false && (feature.kind !== 'extract' || model?.capabilities?.structured !== false);
const candidates = feature => state.models.filter(model => usable(model) && feature.allowedModelIds.includes(model.id) && compatible(feature, model));
const selectedFeature = () => state.routes.find(feature => feature.id === featureId) || state.routes[0];
async function load() {
  $('#app').innerHTML = '<div class="loading" role="status">正在打开接入端…</div>';
  try { await session(); state = await api('/api/state'); manager.accept(state); render(); if (state.connection.configured) await refreshModels(false); }
  catch (error) { $('#app').innerHTML = `<main class="startup-error"><h1>暂时无法打开接入端</h1><p class="form-error" role="alert">${esc(error.message)}</p><button class="primary" data-action="retry">重新连接</button></main>`; }
}
function connectionFields() {
  return `<label>服务端 API 地址<input name="baseUrl" type="url" value="${esc(state.connection.baseUrl)}" placeholder="http://127.0.0.1:4317/v1" autocomplete="url" required></label><label>服务端项目密钥<input name="apiKey" type="password" placeholder="粘贴 md_key_ 开头的项目密钥" autocomplete="off" spellcheck="false" required><small>在服务端「项目访问」创建密钥，并授权需要使用的模型。</small></label>`;
}
function connectionPanel() {
  return `<section class="connect-panel" aria-labelledby="connect-title"><div><span class="eyebrow">连接你的模型服务</span><h2 id="connect-title">服务端连接</h2><p>${state.connection.configured ? '项目密钥已保存。填写新的地址和密钥可更换连接，更换后需要重新启用应用模型。' : '填写服务端地址和项目密钥，读取可用模型并配置应用功能。'}</p></div><form id="connection-form"><div class="form-grid">${connectionFields()}</div><div class="connection-actions"><small>密钥仅保存在本机接入端后端。</small><button type="submit" class="primary">连接并读取模型</button></div><div class="form-error" role="alert"></div></form></section>`;
}
function catalogSummary() {
  const count = state.models.filter(model => model.available !== false).length;
  const time = state.connection.refreshedAt ? new Date(state.connection.refreshedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
  return `<div><dt>可用授权模型</dt><dd>${count} 个</dd></div><div><dt>最近成功同步</dt><dd>${esc(time)}</dd></div>`;
}
function settings() {
  return `<div class="connection-settings">${connectionPanel()}<section class="catalog-panel" aria-labelledby="catalog-title"><h2 id="catalog-title">授权模型目录</h2><p>服务端保存模型开关、能力或思考深度后，点击「刷新模型」同步最新状态。刷新会保留应用中未保存的修改。</p><dl id="catalog-summary" class="catalog-summary">${catalogSummary()}</dl><div class="row wrap"><button class="primary" data-action="refresh-models" ${!state.connection.configured ? 'disabled' : ''}>刷新模型</button><button data-view="models">查看功能与模型 →</button></div></section></div>`;
}
function connectionStatus() { return state.connection.error ? '连接异常' : state.connection.configured ? '已连接服务端' : '未连接服务端'; }
function updateConnectionStatus() {
  for (const node of document.querySelectorAll('[data-connection-status]')) {
    node.textContent = connectionStatus();
    node.classList.toggle('error', Boolean(state.connection.error)); node.classList.toggle('pending', !state.connection.configured);
  }
  const error = $('#connection-error');
  if (error) { error.textContent = state.connection.error; error.hidden = !state.connection.error; }
  if ($('#catalog-summary')) $('#catalog-summary').innerHTML = catalogSummary();
  for (const button of document.querySelectorAll('[data-action="refresh-models"]')) { button.disabled = busy || !state.connection.configured; button.textContent = busy ? '正在刷新…' : '刷新模型'; }
}
async function refreshModels(notify = true) {
  if (busy || manager.busy || generation) return;
  busy = true; updateConnectionStatus();
  try { await manager.handle({ dataset: { mm: 'refresh' } }); }
  finally { busy = false; if (view === 'settings') updateConnectionStatus(); else render(); }
  if (notify) toast(manager.error || manager.notice, Boolean(manager.error));
}
function render() {
  if (!state) return;
  const status = connectionStatus(), title = view === 'experience' ? '你的功能，选择你的模型。' : navigation.find(([id]) => id === view)[1];
  $('#app').innerHTML = `<div class="shell reference-layout demo-shell"><aside class="sidebar"><div class="brand"><span class="demo-mark">M</span>Model Dock</div><div class="sidebar-sub">接入端 / CLIENT APP</div><div class="nav-label">应用 / APPLICATION</div><nav class="nav" aria-label="应用导航">${navigation.map(([id, label, icon]) => `<button data-view="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}><span class="nav-symbol" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav><div class="sidebar-bottom"><p data-connection-status>${status}</p></div></aside><main class="page"><div class="between demo-heading ${view === 'models' ? 'models-heading' : ''}"><div><h1>${title}</h1>${view === 'experience' ? '<p>从一个功能开始，体验应用如何使用 Model Dock。</p>' : view === 'settings' ? '<p>管理服务端地址、项目密钥与模型同步。</p>' : ''}</div><div class="row connection-status"><span data-connection-status class="mode-badge ${state.connection.error ? 'error' : !state.connection.configured ? 'pending' : ''}">${status}</span>${view === 'experience' && state.connection.configured ? '<button data-action="refresh-models">刷新模型</button>' : ''}</div></div><div id="connection-error" class="cm-feedback error" role="alert" ${!state.connection.error ? 'hidden' : ''}>${esc(state.connection.error)}</div>${!state.connection.configured && view !== 'settings' ? '<div class="connect-banner"><p>尚未连接服务端。请先在接入设置中填写项目密钥。</p><button data-view="settings">前往接入设置 →</button></div>' : ''}${view === 'settings' ? settings() : view === 'models' ? '<div id="model-manager"></div>' : experience()}</main></div>`;
  if (view === 'models') manager.mount($('#model-manager'), state);
}
function featureCard(feature) {
  const model = state.models.find(model => model.id === feature.modelId), ready = candidates(feature).some(item => item.id === feature.modelId);
  return `<button class="feature-card ${selectedFeature()?.id === feature.id ? 'active' : ''}" data-action="feature" data-id="${esc(feature.id)}" aria-pressed="${selectedFeature()?.id === feature.id}"><div class="between"><strong>${esc(feature.name)}</strong><span>${feature.selection === 'single' ? '单模型' : '多模型'}</span></div><small>${ready ? esc(model.name) : feature.modelId ? '默认模型不可用' : '待选择默认模型'}</small></button>`;
}
function experience() {
  const feature = selectedFeature(); if (!feature) return '<div class="empty"><h2>还没有应用功能</h2><button data-view="models">添加功能</button></div>';
  featureId = feature.id;
  if (promptFeature !== feature.id) { prompt = examples[feature.kind] || ''; promptFeature = feature.id; chosenModel = ''; }
  const available = candidates(feature), defaultModel = state.models.find(model => model.id === feature.modelId);
  const selectedId = chosenModel || feature.modelId;
  const model = available.find(row => row.id === selectedId);
  const prefs = model?.reasoningPolicy, group = own(model?.groupPolicies, feature.group), override = own(feature.reasoningOverrides, selectedId);
  const policy = override || group || prefs;
  const levels = policy?.allowedEfforts || model?.reasoningEfforts || [];
  const defaultLevel = policy?.defaultEffort || model?.defaultEffort || '';
  const groups = [...new Set(state.routes.map(row => row.group).filter(Boolean))];
  return `<div class="experience-layout"><section class="feature-menu" aria-label="应用功能"><h2>独立功能</h2>${state.routes.filter(row => !row.group).map(featureCard).join('')}${groups.map(group => `<h2>${esc(group)} <small>功能分组</small></h2>${state.routes.filter(row => row.group === group).map(featureCard).join('')}`).join('')}</section><section class="run-panel"><div class="run-title"><div><span class="eyebrow">${esc(feature.group || '独立功能')}</span><h2>${esc(feature.name)}</h2></div><button class="quiet small-button" data-view="models">配置模型 →</button></div><form id="run-form" class="stack"><div class="form-grid"><label>使用模型<select name="modelId"><option value="">默认：${esc(defaultModel?.name || '尚未指定')}${!available.some(row => row.id === feature.modelId) ? '（不可用）' : ''}</option>${available.map(row => `<option value="${esc(row.id)}" ${chosenModel === row.id ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}</select></label><label>思考深度<select name="reasoningEffort" ${!levels.length ? 'disabled' : ''}><option value="">${levels.length ? `默认${defaultLevel ? `（${esc(defaultLevel)}）` : ''}` : '模型未开放此设置'}</option>${levels.map(level => `<option value="${esc(level)}">${esc(level)}</option>`).join('')}</select></label></div>${!model ? '<p class="selection-warning" role="status">当前默认模型不可用。请选择可用候选，或在功能与模型中指定默认值。</p>' : ''}<label>输入内容<textarea name="prompt" rows="6" required maxlength="20000">${esc(prompt)}</textarea></label><div class="between"><label class="checkbox-label"><input name="stream" type="checkbox" checked>流式输出</label><div class="row"><button type="button" data-action="stop" id="stop-button" disabled>停止</button><button class="primary" id="run-button" ${!model ? 'disabled' : ''}>运行功能 →</button></div></div></form><div class="result-heading between"><h3>运行结果</h3><span class="tag" id="response-status">等待输入</span></div><div class="response empty-output" id="response-output" role="log" aria-live="polite">发送内容后，模型响应会显示在这里。</div><p id="response-meta" class="output-meta">请求使用项目授权的模型，可能消耗上游额度。</p></section></div>`;
}
function dialog(title, description, fields, label, callback) {
  $('#dialog').innerHTML = `<div class="modal-heading"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><form id="modal-form" class="modal-form">${fields}<div class="form-error" id="modal-error" role="alert"></div><div class="modal-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">${esc(label)}</button></div></form>`;
  $('#modal-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; busy = true;
    try { await callback(new FormData(event.target)); } catch (error) { if ($('#modal-error')) $('#modal-error').textContent = error.message; }
    finally { button.disabled = false; busy = false; }
  });
  if (!$('#dialog').open) $('#dialog').showModal();
}
async function connect(form) {
  if (manager.dirtyCount) throw new Error('请先保存或撤销功能与模型的更改。');
  const result = await api('/api/connection', { method: 'POST', body: { revision: state.revision, baseUrl: form.get('baseUrl').trim(), apiKey: form.get('apiKey').trim() } });
  state = result.state; manager.accept(state, true);
  render(); toast('已连接，可在「功能与模型」中启用授权模型。');
}
function featureDialog(existing) {
  dialog(existing ? '编辑应用功能' : '添加应用功能', '功能与提示模板由此应用维护。选择模型后，保存更改即可生效。', `<label>功能名称<input name="name" required maxlength="100" value="${esc(existing?.name || '')}"></label><label>功能 ID<input name="id" required maxlength="80" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9._]|-)*" value="${esc(existing?.id || '')}" ${existing ? 'readonly' : ''} placeholder="例如：my-summary"></label><label>行为模板<select name="kind">${Object.entries(kinds).map(([id,label]) => `<option value="${id}" ${existing?.kind === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="form-grid"><label>功能分组<input name="group" value="${esc(existing?.group || '')}" placeholder="留空为独立功能" maxlength="80" list="feature-groups"><datalist id="feature-groups">${manager.groups().map(group => `<option value="${esc(group.name)}"></option>`).join('')}</datalist></label><label>模型选择方式<select name="selection"><option value="single" ${existing?.selection !== 'multiple' ? 'selected' : ''}>单一模型</option><option value="multiple" ${existing?.selection === 'multiple' ? 'selected' : ''}>多个候选 + 默认模型</option></select></label></div>`, '加入草稿', async form => {
    const next = Object.fromEntries(form);
    if (!existing && manager.draft.routes.some(row => row.id === next.id.trim())) throw new Error('此功能 ID 已存在。');
    manager.upsertRoute(next); $('#dialog').close(); toast('功能已加入草稿，请保存更改。');
  });
}
async function run(form) {
  if (generation) return;
  const fields = new FormData(form), controller = new AbortController(); generation = controller;
  const streaming = fields.has('stream'), output = $('#response-output'), started = performance.now();
  let content = '', measurement, ended = false;
  // Lock controls for the duration so a result always belongs to the displayed feature/model.
  form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; }); $('#stop-button').disabled = false;
  $('#response-status').textContent = '运行中'; output.textContent = ''; output.classList.remove('empty-output');
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ featureId, prompt: fields.get('prompt'), modelId: fields.get('modelId'), reasoningEffort: fields.get('reasoningEffort') || '', stream: streaming }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message || '运行失败'); }
    if (streaming) {
      for await (const raw of sse(response.body)) {
        if (raw === '[DONE]') { ended = true; break; }
        const chunk = JSON.parse(raw); if (chunk.error) throw new Error(chunk.error.message);
        content += chunk.choices?.[0]?.delta?.content || ''; output.textContent = content; if (chunk.usage) measurement = chunk.usage;
      }
      if (!ended) throw new Error('响应流未正常结束。');
    } else { const data = await response.json(); output.textContent = data.choices?.[0]?.message?.content || ''; measurement = data.usage; }
    $('#response-status').textContent = '已完成';
  } catch (error) { $('#response-status').textContent = controller.signal.aborted ? '已停止' : '失败'; if (!controller.signal.aborted) output.textContent = content + (content ? '\n\n' : '') + error.message; }
  finally {
    generation = null; form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = false; }); $('#stop-button').disabled = true;
    if (form.elements.reasoningEffort.options.length === 1) form.elements.reasoningEffort.disabled = true;
    $('#response-meta').textContent = `${((performance.now() - started) / 1000).toFixed(1)} 秒 · ${measurement ? `输入 ${measurement.prompt_tokens} / 输出 ${measurement.completion_tokens} tokens` : '上游未报告用量'}`;
  }
}
on(document, 'submit', async event => {
  if (event.target.id === 'connection-form') {
    event.preventDefault(); if (busy) return;
    const form = event.target, button = event.submitter, error = form.querySelector('.form-error');
    busy = true; button.disabled = true; button.textContent = '正在连接…'; error.textContent = '';
    try { await connect(new FormData(form)); } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; button.disabled = false; button.textContent = '连接并读取模型'; }
  } else if (event.target.id === 'run-form') { event.preventDefault(); void run(event.target); }
});
on(document, 'input', event => { if (event.target.name === 'prompt') prompt = event.target.value; });
on(document, 'change', event => { if (event.target.name === 'modelId' && event.target.closest('#run-form')) { chosenModel = event.target.value; render(); } });
on(document, 'click', async event => {
  if (event.target.closest('[data-mm]')) return;
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (generation && action !== 'stop') { toast('请先停止或等待当前请求。'); return; }
  if ((busy || manager.busy) && action !== 'stop') return;
  if (button.dataset.view) { view = button.dataset.view; history.pushState(null, '', `?view=${view}`); render(); return; }
  if (action === 'refresh-models') void refreshModels();
  if (action === 'feature') { featureId = id; render(); }
  if (action === 'close-dialog') $('#dialog').close();
  if (action === 'add-route') featureDialog();
  if (action === 'edit-route') featureDialog(manager.draft.routes.find(row => row.id === id));
  if (action === 'delete-route') dialog('删除应用功能', '删除先加入草稿，保存后从此应用移除。', '', '删除功能', async () => { manager.removeRoute(id); $('#dialog').close(); });
  if (action === 'stop') generation?.abort();
  if (action === 'retry') void load();
});
on($('#dialog'), 'close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
on(window, 'popstate', () => { if (generation) return; view = currentView(); render(); });
await load();
export function dispose() { generation?.abort(); listeners.abort(); manager.dispose(); clearTimeout(toastTimer); }
