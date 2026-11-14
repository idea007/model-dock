const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = value => JSON.stringify(value, null, 2);
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const code = value => `<code>${escape(value)}</code>`;
const mib = bytes => `${bytes / (1024 * 1024)} MiB`;
const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg>';

function curl(url, body, { auth = true, stream = false } = {}) {
  return [
    `curl${stream ? ' -N' : ''} ${quote(url)}`,
    ...(auth ? ['  -H "Authorization: Bearer $MODEL_DOCK_API_KEY"'] : []),
    ...(body ? ['  -H "Content-Type: application/json"', `  -d ${quote(json(body))}`] : [])
  ].join(' \\\n');
}

function table(headers, rows) {
  return `<div class="api-table-scroll" tabindex="0"><table><thead><tr>${headers.map(header => `<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function block(id, title, value, copyLabel = '复制') {
  return `<section class="code-card api-code"><div class="between"><h3>${escape(title)}</h3><button class="small-button" data-action="copy-api-example" data-code-id="api-code-${id}" aria-label="复制${escape(title)}">${copyIcon}${escape(copyLabel)}</button></div><pre id="api-code-${id}">${escape(value)}</pre></section>`;
}

function endpoint(id, method, path, title, description, content, expanded, auth = true) {
  return `<details class="api-endpoint" data-api-id="${id}"${expanded.has(id) ? ' open' : ''}>
    <summary><span class="api-method ${method.toLowerCase()}">${method}</span><span class="api-endpoint-name"><code>${path}</code><span>${title}</span><small>${description}</small></span><span class="api-auth">${auth ? '项目密钥' : '无需密钥'}</span><svg class="api-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></summary>
    <div class="api-endpoint-body">${content}</div>
  </details>`;
}

function modelHint(model, kind) {
  return model
    ? `<p class="api-note">示例已使用当前发布的${kind}模型 ${code(model.id)}；调用前请确认项目密钥有权访问该模型。</p>`
    : `<p class="api-note">当前没有可用的${kind}模型。请先在「模型与服务」发布模型，并将示例中的 model 替换为 ${code('GET /v1/models')} 返回的完整 ID。</p>`;
}

export function apiDocsPage(state, imageOptions, expanded = new Set()) {
  const baseUrl = state.baseUrl.replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  const models = state.models.filter(model => model.enabled && model.available !== false && state.connections.some(connection => connection.id === model.connectionId && connection.enabled));
  const textModel = models.find(model => model.capability !== 'image_generation' && model.capabilities?.text !== false);
  const imageModel = models.find(model => model.capability === 'image_generation');
  const textId = textModel?.id || 'connection-id/model-id';
  const imageId = imageModel?.id || 'connection-id/codex-imagegen';
  const { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes, maxImageRequestBytes } = imageOptions;
  const chatBody = { model: textId, messages: [{ role: 'user', content: '你好，请介绍一下你自己。' }] };

  const catalog = endpoint('models', 'GET', '/v1/models', '获取可用模型', '查询当前项目有权使用的模型、能力与思考深度。', `
    <p>无请求参数。只返回已发布、可用且被当前项目密钥授权的模型。服务端修改模型开关或思考深度后，重新请求此接口即可获取最新目录。</p>
    ${block('models-request', '获取模型 · cURL', curl(`${baseUrl}/models`), '复制 cURL')}
    <h3>响应字段</h3>
    ${table(['字段', '说明'], [
      [code('data[].id'), '后续请求的 model 值。请保留完整 ID，包括连接前缀。'],
      [code('data[].name / source'), '显示名称，以及来源的 id、name、type。'],
      [code('data[].capabilities'), 'text、tools、structured、thinking 为 true / false / null；null 表示尚未声明。图片模型另含 image_generation: true。'],
      [code('data[].context_window'), '上下文窗口；null 表示未知。'],
      [code('data[].reasoning_efforts'), '当前开放的思考深度；仅提交此列表中的值。'],
      [code('data[].default_reasoning_effort'), '默认思考深度；null 表示未声明。'],
      [code('data[].legacy_alias'), '仅旧别名带 true；新接入建议使用原生模型 ID。']
    ])}
    ${block('models-response', '200 · 响应结构示例', json({ object: 'list', data: [{ id: textId, object: 'model', created: 0, owned_by: 'connection-id', name: '模型名称', source: { id: 'connection-id', name: '连接名称', type: 'openai' }, capabilities: { text: true, tools: null, structured: null, thinking: null }, context_window: null, reasoning_efforts: [], default_reasoning_effort: null }] }))}
    <p class="api-note">返回空数组时，请检查模型是否发布、连接是否启用及项目密钥的允许范围。目录可见不代表上游账户一定有推理权限。</p>
  `, expanded);

  const chat = endpoint('chat', 'POST', '/v1/chat/completions', '文本对话', '支持多轮文本、流式输出、函数调用与结构化输出。', `
    <p>使用 JSON 请求体，最大 2 MiB。一次请求指定一个模型，返回一个 choice；messages.content 只接受文本，不接受图片或音频数组。</p>
    <h3>请求参数</h3>
    ${table(['参数', '类型 / 必填', '说明'], [
      [code('model'), 'string · 必填', '从 /v1/models 获取的完整文本模型 ID。'],
      [code('messages'), 'array · 必填', '1–2048 条消息。每条包含 role 和 content；role 支持 system、developer、user、assistant、tool。多轮对话需传入历史消息。'],
      [code('stream'), 'boolean · 可选', '默认 false。true 使用 SSE，逐步读取 choices[0].delta。'],
      [code('stream_options'), 'object · 可选', '仅在 stream: true 时设置 {"include_usage": true}，请求用量统计。'],
      [code('reasoning_effort'), 'string · 可选', '从模型的 reasoning_efforts 选取；省略时使用服务端配置的默认值或上游默认行为。'],
      [code('response_format'), 'object · 可选', 'type 为 text、json_object 或 json_schema。使用 json_schema 时，需在同名对象中提供 name 和 schema，可选 description、strict。'],
      [code('tools'), 'array · 可选', '最多 128 个函数定义：type: "function"，function 内须含 name 和 parameters，可选 description、strict。parameters 须为 object 类型的 JSON Schema。'],
      [code('tool_choice'), 'string / object · 可选', 'auto、none、required，或 {"type":"function","function":{"name":"函数名"}}；支持情况见下表。'],
      [code('parallel_tool_calls'), 'boolean · 可选', '是否允许并行函数调用；支持情况见下表。'],
      [code('max_tokens / max_completion_tokens'), 'integer · 可选', '1–1,000,000，二选一。Codex 不支持这两个参数。'],
      [code('temperature / top_p'), 'number · 可选', 'temperature 为 0–2；top_p 为 0–1。Codex 不支持。'],
      [code('stop / seed / user'), '可选', 'stop 为字符串或最多 4 个字符串；seed 为安全整数；user 为最长 200 字符的字符串。支持情况见下表。']
    ])}
    ${modelHint(textModel, '文本')}
    ${block('chat-request', '文本对话 · cURL', curl(`${baseUrl}/chat/completions`, chatBody), '复制 cURL')}
    ${block('chat-response', '200 · 响应结构示例', json({ id: 'chatcmpl-example', object: 'chat.completion', created: 0, model: textId, choices: [{ index: 0, message: { role: 'assistant', content: '你好！有什么可以帮你？' }, finish_reason: 'stop' }] }))}
    <p class="api-note">读取 choices[0].message.content；函数调用见 message.tool_calls，finish_reason 为 tool_calls。usage 只在上游提供完整统计时返回，不能将缺失统计当作 0。</p>
    <h3>流式调用</h3>
    ${block('chat-stream', '流式对话 · cURL', curl(`${baseUrl}/chat/completions`, { ...chatBody, stream: true, stream_options: { include_usage: true } }, { stream: true }), '复制 cURL')}
    <p>Content-Type 为 ${code('text/event-stream')}。逐条解析 data 事件，拼接 delta.content / delta.tool_calls。正常结束会收到 finish_reason、可选的 usage 事件以及 ${code('data: [DONE]')}。心跳注释可忽略；收到 error 事件或连接中断且未收到 [DONE] 时，应按失败或中断处理。</p>
    <h3>不同来源的参数支持</h3>
    ${table(['能力 / 参数', '模型 API', 'Ollama', 'Codex'], [
      ['采样参数、stop、seed、输出 token 上限', '转发给上游', '映射原生参数', '不支持'],
      ['tool_choice', '转发给上游', 'auto / none', 'auto / none / required / 指定函数'],
      ['parallel_tool_calls', '转发给上游', '不支持', '仅 false'],
      ['工具 Schema strict: true', '转发给上游', '不支持', '不支持'],
      ['输出 Schema strict: true', '转发给上游', '不支持', '传入原生输出 Schema'],
      ['user', '转发给上游', '不支持', '不支持']
    ])}
    <p class="api-note">函数由接入端执行；将 assistant.tool_calls 与对应的 tool 消息一并放入下一轮历史，每个结果携带匹配的 tool_call_id。除含 tool_calls 的 assistant 消息可用 content: null 外，content 必须为字符串。是否支持工具及结构化输出仍取决于具体模型；未知或不支持的参数会明确报错。</p>
  `, expanded);

  const images = endpoint('images', 'POST', '/v1/images/generations', '图片生成与编辑', '生成一张图片，或传入参考图进行编辑，返回 Base64 结果。', `
    <p>使用已发布的 Codex 图片模型。生成和编辑使用同一接口，同步等待一张完整图片；目前不提供图片流式输出。</p>
    <h3>请求参数</h3>
    ${table(['参数', '类型 / 必填', '说明'], [
      [code('model'), 'string · 必填', '具有 capabilities.image_generation: true 的完整模型 ID。'],
      [code('prompt'), 'string · 必填', '非空提示词，最多 4,000 字符；支持多行。'],
      [code('reference_images'), 'string[] · 可选', `最多 ${maxImageReferences} 张有序参考图，使用 PNG、JPEG 或 WebP 的 Base64 data URL。单张解码后不超过 ${mib(maxImageReferenceBytes)}，合计不超过 ${mib(maxImageReferenceTotalBytes)}。`],
      [code('aspect_ratio'), 'string · 可选', `${imageAspectRatios.map(code).join('、')}；省略时由模型选择画布。`],
      [code('background'), 'string · 可选', `${code('auto')} 或 ${code('transparent')}；后者请求透明背景。`],
      [code('n / response_format'), '可选', `仅接受 n: 1 和 response_format: "b64_json"；完整 JSON 请求体上限 ${mib(maxImageRequestBytes)}。`]
    ])}
    ${modelHint(imageModel, '图片')}
    ${block('images-request', '图片生成 · cURL', curl(`${baseUrl}/images/generations`, { model: imageId, prompt: '浅色背景上的蓝色陶瓷杯', aspect_ratio: '1:1', n: 1, response_format: 'b64_json' }), '复制 cURL')}
    ${block('images-response', '200 · 响应结构示例', json({ created: 0, output_format: 'png', data: [{ b64_json: '图片的 Base64 内容', width: 1024, height: 1024 }] }))}
    <p>读取 data[0].b64_json 还原图片；output_format 为 png、jpeg 或 webp，width / height 为实际像素尺寸。比例和透明背景作为生成要求传入，实际尺寸、格式及透明度以结果为准。</p>
    <h3>参考图与继续编辑</h3>
    <p>在 prompt 中按顺序指明「图 1」「图 2」。将 reference_images 中的占位内容替换为真实图片的 Base64 后提交。</p>
    ${block('images-edit', '参考图编辑 · 请求体示例', json({ model: imageId, prompt: '保留图 1 的杯子造型，将杯身改为绿色，背景透明。', reference_images: ['data:image/png;base64,替换为真实图片的Base64'], background: 'transparent' }))}
    <p class="api-note">继续编辑时，将上一张结果组合成 ${code('data:image/${output_format};base64,${data[0].b64_json}')} 并加入 reference_images。文本与图片请求共享 Codex 的单个并发名额；连接断开会取消请求，当前没有结果找回接口。请关闭 SDK 自动重试，避免响应丢失后重复生成。</p>
  `, expanded);

  const health = endpoint('health', 'GET', '/healthz', '健康检查', '确认本机网关进程可访问，并读取版本。', `
    <p>无需鉴权或请求参数，路径位于网关根目录，不包含 /v1。仅反映网关进程状态，不检查上游连接或模型推理权限。</p>
    ${block('health-request', '健康检查 · cURL', curl(`${origin}/healthz`, undefined, { auth: false }), '复制 cURL')}
    ${block('health-response', '200 · 响应结构示例', json({ ok: true, version: state.version }))}
  `, expanded, false);

  return `<div class="api-docs">
    <header class="page-heading"><div class="eyebrow">API REFERENCE</div><h1>接口文档</h1><p>查看接口、展开详情，把模型能力接入你的应用。</p></header>
    <section class="card api-connection" aria-labelledby="api-connection-title">
      <div class="between wrap"><div><h2 id="api-connection-title">接入地址与鉴权</h2><p>兼容客户端的 Base URL</p><code class="api-base-url">${escape(baseUrl)}</code></div><button data-action="copy-endpoint">${copyIcon}复制地址</button></div>
      <div class="api-authorization"><div><span>请求头</span><code>Authorization: Bearer $MODEL_DOCK_API_KEY</code></div><button class="small-button" data-view="keys">管理项目密钥 →</button></div>
      <p class="api-note">先在「项目访问」创建密钥，将其存入环境变量 MODEL_DOCK_API_KEY。带请求体时使用 Content-Type: application/json。本机网关仅接受本机访问，密钥请由后端或本机应用保管。</p>
    </section>
    <div class="section-header between wrap"><h2 id="api-list-title">接口列表 <span class="api-count">4</span></h2><span class="muted">点击接口查看参数与示例</span></div>
    <section class="api-endpoints" aria-labelledby="api-list-title">${catalog}${chat}${images}${health}</section>
    <section class="card api-errors" aria-labelledby="api-errors-title"><h2 id="api-errors-title">错误处理</h2><p>响应头包含 x-request-id，可用于排查请求；错误返回统一的 JSON 结构。</p>
      ${block('error', '错误响应结构示例', json({ error: { message: 'This key cannot use the selected model.', type: 'invalid_request_error', code: 'model_forbidden', param: null } }))}
      ${table(['HTTP 状态', '常见错误码', '处理方式'], [
        ['400', code('invalid_request / unsupported_parameter'), '检查字段、类型和当前模型的参数支持。'],
        ['401', code('unauthorized / key_revoked'), '检查项目密钥是否有效、是否已撤销。'],
        ['403', code('model_forbidden'), '为项目密钥授权所选模型。'],
        ['404', code('model_unavailable'), '重新获取模型目录，确认模型已发布且可用。'],
        ['413', code('request_too_large / image_reference_too_large'), '减小请求体或参考图大小。'],
        ['429', code('connection_busy'), '当前并发已满；此时尚未开始生成，按 Retry-After: 2 等待后重试。'],
        ['502', code('upstream_auth_failed / upstream_protocol_error'), '在服务端检查上游连接、凭证及模型支持情况。'],
        ['504', code('request_timeout'), '请求超时；检查服务端连接超时设置与上游状态。']
      ])}
      <p class="api-note">网关不会自动切换模型或重放失败请求。网络中断或超时后，上游执行结果可能未知；请由应用明确决定是否重试。</p>
    </section>
  </div>`;
}
