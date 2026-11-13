import { ModelManager } from './models.mjs';
import { sse } from './events.mjs';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const kinds = { chat: '自由对话', extract: '结构化提取', summarize: '文档摘要', rewrite: '文本润色', translate: '多语言翻译', explain: '代码讲解', review: '代码审查' };
const examples = { chat: '用三句话解释什么是模型网关。', extract: '小林计划在周五上午十点与设计团队评审新首页，会议地点是二楼会议室。', summarize: '团队将模型接入集中到网关管理。各应用只需要项目密钥即可访问获授权的模型，并在自己的应用内维护功能、默认模型和思考偏好。', rewrite: '我们把模型接好啦，之后做新功能的时候就可以直接用了，不用每次都搞一遍密钥。', translate: '好的工具应该清楚地划分职责，同时让使用者感到简单。', explain: 'const unique = values => [...new Set(values)];', review: 'async function loadProfile(id) {\n  return fetch(`/users/${id}`).then(res => res.json());\n}' };
const tokenKey = 'model-dock-demo-token', draftKey = 'model-dock-demo-draft-v1';
let token = sessionStorage.getItem(tokenKey) || '', state, view = new URLSearchParams(location.search).get('view') === 'models' ? 'models' : 'experience';
let featureId = 'chat', chosenModel = '', prompt = '', promptFeature = '', generation, toastTimer, busy = false;
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { if (token !== fragment.get('token')) sessionStorage.removeItem(draftKey); token = fragment.get('token'); sessionStorage.setItem(tokenKey, token); history.replaceState(null, '', location.pathname + location.search); }
const listeners = new window.AbortController();
const on = (target, event, handler) => target.addEventListener(event, handler, { signal: listeners.signal });
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `show${error ? ' error' : ''}`; toastTimer = setTimeout(() => { $('#toast').className = ''; }, error ? 7000 : 3500); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `请求失败（${response.status}）`);
  return data;
}
const manager = new ModelManager({ api, onState: next => { state = next; }, notify: toast, onDetails: model => dialog(model.name, '项目密钥可见的模型能力。', `<dl class="cm-details"><dt>模型 ID</dt><dd>${esc(model.id)}</dd><dt>模型来源</dt><dd>${esc(model.source?.name)}</dd><dt>上下文上限</dt><dd>${model.contextWindow ? model.contextWindow.toLocaleString() + ' tokens' : '未声明'}</dd><dt>思考深度</dt><dd>${esc(model.reasoningEfforts.join(' / ') || '未声明')}</dd></dl>`, '关闭', async () => $('#dialog').close()) });
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : null;
const usable = model => model?.enabled && model.available !== false && !state.connection.error;
const compatible = (feature, model) => model?.capabilities?.text !== false && (feature.kind !== 'extract' || model?.capabilities?.structured !== false);
const candidates = feature => state.models.filter(model => usable(model) && feature.allowedModelIds.includes(model.id) && compatible(feature, model));
const selectedFeature = () => state.routes.find(feature => feature.id === featureId) || state.routes[0];
function login(error = '') {
  $('#app').innerHTML = `<main class="login"><div class="login-card"><div class="brand">Model Dock <span class="tag">Client Demo</span></div><h1>进入接入端 demo</h1><p>运行 <code>npm run demo:mock -- --open</code> 可直接打开模拟演示。已有会话可运行 <code>npm run demo -- token --mock</code> 获取本地访问令牌；真实模式省略 <code>--mock</code>。</p><form id="login-form"><label>Demo 本地会话令牌<input name="token" type="password" placeholder="demo_local_…" autocomplete="off" required></label><div class="form-error" role="alert">${esc(error)}</div><button class="primary">进入演示</button></form></div></main>`;
}
function render() {
  if (!state || !token) return login();
  const mock = state.mode === 'mock';
  $('#app').innerHTML = `<div class="shell reference-layout demo-shell"><aside class="sidebar"><div class="brand"><span class="demo-mark">M</span>Model Dock</div><div class="sidebar-sub">接入端 Demo / CLIENT APP</div><div class="nav-label">应用 / APPLICATION</div><nav class="nav" aria-label="应用导航"><button data-view="experience" class="${view === 'experience' ? 'active' : ''}" ${view === 'experience' ? 'aria-current="page"' : ''}><span class="nav-symbol">▷</span>应用体验</button><button data-view="models" class="${view === 'models' ? 'active' : ''}" ${view === 'models' ? 'aria-current="page"' : ''}><span class="nav-symbol">◈</span>功能与模型</button></nav><div class="sidebar-bottom"><p><span class="local-dot"></span>${mock ? '模拟模型服务' : state.connection.configured ? '已配置网关' : '尚未接入网关'}</p><button class="quiet" data-action="connection">网关接入设置</button><div><button class="quiet" data-action="logout">退出 demo 会话</button></div></div></aside><main class="page"><div class="between demo-heading ${view === 'models' ? 'models-heading' : ''}"><div><h1>${view === 'models' ? '功能与模型' : '你的功能，选择你的模型。'}</h1>${view === 'experience' ? '<p>从一个功能开始，体验应用如何使用 Model Dock。</p>' : ''}</div><span class="mode-badge ${mock ? 'mock' : ''}">${mock ? '模拟演示 · 无真实模型调用' : '真实网关'}</span></div>${state.connection.error ? `<div class="cm-feedback error" role="alert">${esc(state.connection.error)}</div>` : ''}${!state.connection.configured ? '<div class="connect-banner"><div><strong>先连接你的 Model Dock</strong><p>使用项目密钥读取授权模型，然后在此应用内选择功能和默认模型。</p></div><button class="primary" data-action="connection">连接网关</button></div>' : ''}${view === 'models' ? '<div id="model-manager"></div>' : experience()}</main></div>`;
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
  return `<div class="experience-layout"><section class="feature-menu" aria-label="应用功能"><h2>独立功能</h2>${state.routes.filter(row => !row.group).map(featureCard).join('')}${groups.map(group => `<h2>${esc(group)} <small>功能分组</small></h2>${state.routes.filter(row => row.group === group).map(featureCard).join('')}`).join('')}</section><section class="run-panel"><div class="run-title"><div><span class="eyebrow">${esc(feature.group || '独立功能')}</span><h2>${esc(feature.name)}</h2></div><button class="quiet small-button" data-view="models">配置模型 →</button></div><form id="run-form" class="stack"><div class="form-grid"><label>使用模型<select name="modelId"><option value="">默认：${esc(defaultModel?.name || '尚未指定')}${!available.some(row => row.id === feature.modelId) ? '（不可用）' : ''}</option>${available.map(row => `<option value="${esc(row.id)}" ${chosenModel === row.id ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}</select></label><label>思考深度<select name="reasoningEffort" ${!levels.length ? 'disabled' : ''}><option value="">${levels.length ? `默认${defaultLevel ? `（${esc(defaultLevel)}）` : ''}` : '模型未开放此设置'}</option>${levels.map(level => `<option value="${esc(level)}">${esc(level)}</option>`).join('')}</select></label></div>${!model ? '<p class="selection-warning" role="status">当前默认模型不可用。请选择可用候选，或在功能与模型中指定默认值。</p>' : ''}<label>输入内容<textarea name="prompt" rows="6" required maxlength="20000">${esc(prompt)}</textarea></label><div class="between"><label class="checkbox-label"><input name="stream" type="checkbox" checked>流式输出</label><div class="row"><button type="button" data-action="stop" id="stop-button" disabled>停止</button><button class="primary" id="run-button" ${!model ? 'disabled' : ''}>运行功能 →</button></div></div></form><div class="result-heading between"><h3>运行结果</h3><span class="tag" id="response-status">等待输入</span></div><div class="response empty-output" id="response-output" role="log" aria-live="polite">${state.mode === 'mock' ? '模拟模型已就绪。运行后可查看流式输出。' : '发送内容后，模型响应会显示在这里。'}</div><p id="response-meta" class="output-meta">${state.mode === 'mock' ? '模拟响应仅用于体验交互，不代表模型推理质量。' : '请求使用项目授权的模型，可能消耗上游额度。'}</p></section></div>`;
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
function connectionDialog() {
  if (manager.dirtyCount) return toast('请先保存或撤销功能与模型的更改。', true);
  dialog('接入 Model Dock', '项目密钥保存在此 demo 的本地后端。更换网关或密钥后，需要重新启用此应用的模型。', `<label>网关 API 地址<input name="baseUrl" type="url" value="${esc(state.mode === 'mock' ? 'http://127.0.0.1:4317/v1' : state.connection.baseUrl)}" required></label><label>项目密钥<input name="apiKey" type="password" placeholder="md_key_…" autocomplete="off" required><small>在服务端“项目访问”创建并授权模型。这里不接受管理员令牌。</small></label>`, '连接并读取目录', async form => {
    const result = await api('/api/connection', { method: 'POST', body: { revision: state.revision, ...Object.fromEntries(form) } });
    state = result.state; manager.accept(state, true); $('#dialog').close(); view = 'models'; history.replaceState(null, '', '?view=models'); render(); toast('已连接，请启用此应用需要的模型。');
  });
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
    $('#response-meta').textContent = `${((performance.now() - started) / 1000).toFixed(1)} 秒 · ${measurement ? `输入 ${measurement.prompt_tokens} / 输出 ${measurement.completion_tokens} tokens` : state.mode === 'mock' ? '模拟响应 · 不计量真实用量' : '上游未报告用量'}`;
  }
}
on(document, 'submit', async event => {
  if (event.target.id === 'login-form') {
    event.preventDefault(); token = new FormData(event.target).get('token').trim();
    try { state = await api('/api/state'); sessionStorage.setItem(tokenKey, token); render(); } catch (error) { login(error.message); }
  } else if (event.target.id === 'run-form') { event.preventDefault(); void run(event.target); }
});
on(document, 'input', event => { if (event.target.name === 'prompt') prompt = event.target.value; });
on(document, 'change', event => { if (event.target.name === 'modelId' && event.target.closest('#run-form')) { chosenModel = event.target.value; render(); } });
on(document, 'click', async event => {
  if (event.target.closest('[data-mm]')) return;
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (generation && action !== 'stop') { toast('请先停止或等待当前请求。'); return; }
  if (busy && action !== 'stop') return;
  if (button.dataset.view) { view = button.dataset.view; history.pushState(null, '', `?view=${view}`); render(); return; }
  if (action === 'connection') connectionDialog();
  if (action === 'feature') { featureId = id; render(); }
  if (action === 'close-dialog') $('#dialog').close();
  if (action === 'add-route') featureDialog();
  if (action === 'edit-route') featureDialog(manager.draft.routes.find(row => row.id === id));
  if (action === 'delete-route') dialog('删除应用功能', '删除先加入草稿，保存后从此应用移除。', '', '删除功能', async () => { manager.removeRoute(id); $('#dialog').close(); });
  if (action === 'stop') generation?.abort();
  if (action === 'logout') { token = ''; state = null; sessionStorage.removeItem(tokenKey); manager.reset(); login(); }
});
on($('#dialog'), 'close', () => { if (!$('#dialog').open) $('#dialog').innerHTML = ''; });
on(window, 'popstate', () => { if (generation) return; view = new URLSearchParams(location.search).get('view') === 'models' ? 'models' : 'experience'; render(); });
if (token) { try { state = await api('/api/state'); render(); } catch (error) { login(error.message); } } else login();
export function dispose() { generation?.abort(); listeners.abort(); manager.dispose(); clearTimeout(toastTimer); }
