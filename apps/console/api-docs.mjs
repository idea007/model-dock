import { languageSeparator, t } from '../../packages/ui/i18n.mjs';

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

function imageFileCurl(url, model, prompt, body) {
  const encode = [
    'const fs = require("node:fs")',
    'const [file, model, prompt] = process.argv.slice(1)',
    'const image = "data:image/png;base64," + fs.readFileSync(file).toString("base64")',
    `process.stdout.write(JSON.stringify(${body}))`
  ].join('\n');
  return [
    'IMAGE_PATH=reference.png',
    `node -e ${quote(encode)} "$IMAGE_PATH" ${quote(model)} ${quote(prompt)} |`,
    `  curl ${quote(url)} \\`,
    '    -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \\',
    '    -H "Content-Type: application/json" \\',
    '    --data-binary @-'
  ].join('\n');
}

function table(headers, rows) {
  return `<div class="api-table-scroll" tabindex="0"><table><thead><tr>${headers.map(header => `<th scope="col">${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function block(id, title, value, copyLabel = t('docs.copy')) {
  return `<section class="code-card api-code"><div class="between"><h3>${escape(title)}</h3><button class="small-button" data-action="copy-api-example" data-code-id="api-code-${id}" aria-label="${t('docs.copyAria', escape(title))}">${copyIcon}${escape(copyLabel)}</button></div><pre id="api-code-${id}">${escape(value)}</pre></section>`;
}

function endpoint(id, method, path, title, description, content, expanded, auth = true) {
  return `<details class="api-endpoint" data-api-id="${id}"${expanded.has(id) ? ' open' : ''}>
    <summary><span class="api-method ${method.toLowerCase()}">${method}</span><span class="api-endpoint-name"><code>${path}</code><span>${title}</span><small>${description}</small></span><span class="api-auth">${auth ? t('common.projectKey') : t('docs.noKeyNeeded')}</span><svg class="api-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></summary>
    <div class="api-endpoint-body">${content}</div>
  </details>`;
}

function modelHint(id, kind, client) {
  if (id) {
    const scope = client ? t('docs.authorizedScope') : t('docs.publishedScope');
    const access = client ? '' : t('docs.verifyModelAccess');
    return `<p class="api-note">${t('docs.modelInExample', scope, kind, code(id), access)}</p>`;
  }
  const modelsEndpoint = code('GET /v1/models');
  if (client) return `<p class="api-note">${t('docs.chooseAuthorizedModel', modelsEndpoint, kind, code('model'))}</p>`;
  return `<p class="api-note">${t('docs.publishModelForExample', kind, modelsEndpoint)}</p>`;
}

export function apiDocsPage({ baseUrl: gatewayUrl, models, imageModelId, version, expanded = new Set(), client = false }, imageOptions) {
  const baseUrl = gatewayUrl.replace(/\/+$/, '');
  const origin = new URL(baseUrl).origin;
  const textModel = models.find(model => model.capability !== 'image_generation' && model.capabilities?.text !== false);
  const visionModel = models.find(model => model.capability !== 'image_generation' && model.capabilities?.text !== false && model.capabilities?.image_input === true);
  const toolModel = models.find(model => model.capability !== 'image_generation' && model.capabilities?.text !== false && model.capabilities?.tools === true);
  const visionId = visionModel?.id || 'connection-id/vision-model';
  const toolId = toolModel?.id || 'connection-id/tool-model';
  const publishedImageId = imageModelId || models.find(model => model.capability === 'image_generation')?.id;
  const textId = textModel?.id || 'connection-id/model-id';
  const imageId = publishedImageId || 'connection-id/codex-imagegen';
  const { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes, maxImageRequestBytes, maxImageResultBytes, maxInferenceRequestBytes } = imageOptions;
  const chatBody = { model: textId, messages: [{ role: 'user', content: t('docs.greetingPrompt') }] };
  const responsesBody = { model: textId, input: t('docs.greetingPrompt'), store: false };
  const toolHistory = [{ role: 'user', content: t('docs.addPrompt') }];
  const add = { name: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'], additionalProperties: false } };
  const toolRequest = { model: toolId, tool_choice: 'auto', parallel_tool_calls: false };
  const toolArguments = JSON.stringify({ a: 17, b: 25 });
  const toolResult = JSON.stringify({ result: 42 });

  const catalog = endpoint('models', 'GET', '/v1/models', t('docs.listModels'), t('docs.listModelsSummary'), `
    <p>${t('docs.listModelsHelp')}</p>
    ${block('models-request', t('docs.listModelsCurl'), curl(`${baseUrl}/models`), t('docs.copyCurl'))}
    <h3>${t('docs.responseFields')}</h3>
    ${table([t('docs.field'), t('docs.description')], [
      [code('data[].id'), t('docs.modelIdField')],
      [code('data[].name / source'), t('docs.modelSourceField')],
      [code('data[].capabilities'), t('docs.capabilitiesField')],
      [code('data[].context_window'), t('docs.contextField')],
      [code('data[].reasoning_efforts'), t('docs.effortsField')],
      [code('data[].default_reasoning_effort'), t('docs.defaultEffortField')],
      [code('data[].legacy_alias'), t('docs.aliasField')]
    ])}
    ${block('models-response', t('docs.successResponse'), json({ object: 'list', data: [{ id: textId, object: 'model', created: 0, owned_by: 'connection-id', name: t('docs.modelName'), source: { id: 'connection-id', name: t('console.connectionName'), type: 'openai' }, capabilities: { text: true, tools: textModel?.capabilities?.tools ?? null, structured: null, thinking: null, image_input: textModel?.capabilities?.image_input ?? null }, context_window: null, reasoning_efforts: [], default_reasoning_effort: null }] }))}
    <p class="api-note">${t('docs.emptyCatalogHelp')}</p>
  `, expanded);

  const chat = endpoint('chat', 'POST', '/v1/chat/completions', t('docs.chat'), t('docs.chatSummary'), `
    <p>${t('docs.chatHelp', mib(maxInferenceRequestBytes))}</p>
    <h3>${t('docs.requestParameters')}</h3>
    ${table([t('docs.parameter'), t('docs.parameterType'), t('docs.description')], [
      [code('model'), t('docs.requiredString'), t('docs.chatModelField')],
      [code('messages'), t('docs.requiredArray'), t('docs.messagesField')],
      [code('n'), t('docs.optionalInteger'), t('docs.choiceCountField')],
      [code('stream'), t('docs.optionalBoolean'), t('docs.streamField')],
      [code('stream_options'), t('docs.optionalObject'), t('docs.streamOptionsField')],
      [code('reasoning_effort'), t('docs.optionalString'), t('docs.reasoningField')],
      [code('response_format'), t('docs.optionalObject'), t('docs.responseFormatField')],
      [code('tools'), t('docs.optionalArray'), t('docs.toolsField')],
      [code('tool_choice'), t('docs.optionalStringObject'), t('docs.toolChoiceField')],
      [code('parallel_tool_calls'), t('docs.optionalBoolean'), t('docs.parallelToolsField')],
      [code('max_tokens / max_completion_tokens'), t('docs.optionalInteger'), t('docs.tokenLimitField')],
      [code('temperature / top_p'), t('docs.optionalNumber'), t('docs.samplingField')],
      [code('stop / seed / user'), t('docs.optional'), t('docs.stopSeedUserFields')]
    ])}
    ${modelHint(textModel?.id, t('docs.textKind'), client)}
    ${block('chat-request', t('docs.chatCurl'), curl(`${baseUrl}/chat/completions`, chatBody), t('docs.copyCurl'))}
    ${block('chat-response', t('docs.successResponse'), json({ id: 'chatcmpl-example', object: 'chat.completion', created: 0, model: textId, choices: [{ index: 0, message: { role: 'assistant', content: t('docs.chatResponse') }, finish_reason: 'stop' }] }))}
    <p class="api-note">${t('docs.chatResponseHelp')}</p>
    <p class="api-note">${t('docs.structuredOutputHelp')}</p>
    <h3>${t('docs.streaming')}</h3>
    ${block('chat-stream', t('docs.streamingCurl'), curl(`${baseUrl}/chat/completions`, { ...chatBody, stream: true, stream_options: { include_usage: true } }, { stream: true }), t('docs.copyCurl'))}
    <p>${t('docs.streamingHelp', code('text/event-stream'), code('data: [DONE]'))}</p>
    <p>${t('docs.visionInputHelp', mib(maxInferenceRequestBytes))} ${t('docs.visionReplay')}</p>
    ${modelHint(visionModel?.id, t('docs.visionKind'), client)}
    ${block('chat-vision', t('docs.visionCurl'), imageFileCurl(`${baseUrl}/chat/completions`, visionId, t('docs.visionPrompt'),
      '{ model, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] }] }'), t('docs.copyCurl'))}
    <h3>${t('docs.providerSupport')}</h3>
    ${table([t('docs.capabilityParameter'), t('common.modelApi'), 'Ollama', 'Codex'], [
      [t('docs.samplingLimits'), t('docs.forwarded'), t('docs.nativeMapping'), t('docs.unsupported')],
      ['tool_choice', t('docs.forwarded'), 'auto / none', t('docs.namedTool')],
      ['parallel_tool_calls', t('docs.forwarded'), t('docs.onlyFalse'), t('docs.onlyFalse')],
      [t('docs.strictToolSchema'), t('docs.forwarded'), t('docs.unsupported'), t('docs.unsupported')],
      [t('docs.strictOutputSchema'), t('docs.forwarded'), t('docs.unsupported'), t('docs.nativeOutputSchema')],
      ['user', t('docs.forwarded'), t('docs.unsupported'), t('docs.unsupported')]
    ])}
    <p class="api-note">${t('docs.toolRoundTrip')}</p>
    ${toolModel ? modelHint(toolId, t('docs.toolKind'), client) : `<p class="api-note">${t('docs.toolModelForExample')}</p>`}
    ${block('chat-tool', t('docs.toolRequestCurl'), curl(`${baseUrl}/chat/completions`, {
      ...toolRequest, messages: toolHistory, tools: [{ type: 'function', function: add }]
    }), t('docs.copyCurl'))}
    ${block('chat-tool-result', t('docs.toolResultCurl'), curl(`${baseUrl}/chat/completions`, {
      model: toolId, messages: [
        ...toolHistory,
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_example', type: 'function',
          function: { name: add.name, arguments: toolArguments } }] },
        { role: 'tool', tool_call_id: 'call_example', content: toolResult }
      ]
    }), t('docs.copyCurl'))}
  `, expanded);

  const responses = endpoint('responses', 'POST', '/v1/responses', t('docs.responses'), t('docs.responsesSummary'), `
    <p>${t('docs.responsesHelp', mib(maxInferenceRequestBytes))}</p>
    <h3>${t('docs.requestParameters')}</h3>
    ${table([t('docs.parameter'), t('docs.parameterType'), t('docs.description')], [
      [code('model'), t('docs.requiredString'), t('docs.chatModelField')],
      [code('input'), t('docs.requiredStringArray'), t('docs.responsesInput')],
      [code('instructions'), t('docs.optionalString'), t('docs.responsesInstructions')],
      [code('stream'), t('docs.optionalBoolean'), t('docs.responsesStreamField')],
      [code('store'), t('docs.optionalBoolean'), t('docs.responsesStore')],
      [code('max_output_tokens'), t('docs.optional'), t('docs.responsesOutputLimit')],
      [code('tools / tool_choice'), t('docs.optional'), t('docs.responsesTools')],
      [code('parallel_tool_calls'), t('docs.optionalBoolean'), t('docs.responsesParallel')]
    ])}
    ${modelHint(textModel?.id, t('docs.textKind'), client)}
    ${block('responses-request', t('docs.responsesCurl'), curl(`${baseUrl}/responses`, responsesBody), t('docs.copyCurl'))}
    ${block('responses-response', t('docs.successResponse'), json({
      id: 'resp_example', object: 'response', model: textId, created_at: 0, status: 'completed',
      output: [{ id: 'msg_example', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t('docs.chatResponse'), annotations: [], logprobs: [] }] }],
      error: null, incomplete_details: null, usage: null, instructions: null, tools: [], tool_choice: 'auto',
      parallel_tool_calls: false, store: false, text: { format: { type: 'text' } }, temperature: null, top_p: null, metadata: null, access_programs: null
    }))}
    <p>${t('docs.responsesOutput')}</p>
    <h3>${t('docs.streaming')}</h3>
    ${block('responses-stream', t('docs.responsesStreamCurl'), curl(`${baseUrl}/responses`, { ...responsesBody, stream: true }, { stream: true }), t('docs.copyCurl'))}
    <p>${t('docs.responsesStream')}</p>
    <p class="api-note">${t('docs.responsesReplay')}</p>
    ${toolModel ? modelHint(toolId, t('docs.toolKind'), client) : `<p class="api-note">${t('docs.toolModelForExample')}</p>`}
    ${block('responses-tool', t('docs.toolRequestCurl'), curl(`${baseUrl}/responses`, {
      ...toolRequest, store: false, input: toolHistory, tools: [{ type: 'function', ...add }]
    }), t('docs.copyCurl'))}
    ${block('responses-tool-result', t('docs.toolResultCurl'), curl(`${baseUrl}/responses`, {
      model: toolId, store: false, input: [
        ...toolHistory,
        { type: 'function_call', id: 'fc_example', call_id: 'call_example', name: add.name, arguments: toolArguments, status: 'completed' },
        { type: 'function_call_output', call_id: 'call_example', output: toolResult }
      ]
    }), t('docs.copyCurl'))}
    <p>${t('docs.visionInputHelp', mib(maxInferenceRequestBytes))} ${t('docs.visionReplay')}</p>
    ${modelHint(visionModel?.id, t('docs.visionKind'), client)}
    ${block('responses-vision', t('docs.visionCurl'), imageFileCurl(`${baseUrl}/responses`, visionId, t('docs.visionPrompt'),
      '{ model, store: false, input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: image }] }] }'), t('docs.copyCurl'))}
  `, expanded);

  const images = endpoint('images', 'POST', '/v1/images/generations', t('docs.images'), t('docs.imagesSummary'), `
    <p>${t('docs.imagesHelp')}</p>
    <h3>${t('docs.requestParameters')}</h3>
    ${table([t('docs.parameter'), t('docs.parameterType'), t('docs.description')], [
      [code('model'), t('docs.requiredString'), t('docs.imageModelField')],
      [code('prompt'), t('docs.requiredString'), t('docs.imagePromptField')],
      [code('reference_images'), t('docs.optionalStrings'), t('docs.referenceImagesField', maxImageReferences, mib(maxImageReferenceBytes), mib(maxImageReferenceTotalBytes))],
      [code('aspect_ratio'), t('docs.optionalString'), t('docs.aspectRatioField', imageAspectRatios.map(code).join(languageSeparator()))],
      [code('background'), t('docs.optionalString'), t('docs.backgroundField', code('auto'), code('transparent'))],
      [code('n / response_format'), t('docs.optional'), t('docs.imageOutputFields', mib(maxImageRequestBytes))]
    ])}
    ${modelHint(publishedImageId, t('docs.imageKind'), client)}
    ${block('images-request', t('docs.imagesCurl'), curl(`${baseUrl}/images/generations`, { model: imageId, prompt: t('docs.imagePrompt'), aspect_ratio: '1:1', n: 1, response_format: 'b64_json' }), t('docs.copyCurl'))}
    ${block('images-response', t('docs.successResponse'), json({ created: 0, output_format: 'png', data: [{ b64_json: t('docs.imageData'), width: 1024, height: 1024 }] }))}
    <p>${t('docs.imageResponseHelp', mib(maxImageResultBytes))}</p>
    <h3>${t('docs.editReferences')}</h3>
    <p>${t('docs.referenceEditHelp')}</p>
    ${block('images-edit', t('docs.editCurl'), imageFileCurl(`${baseUrl}/images/generations`, imageId, t('docs.editPrompt'),
      '{ model, prompt, reference_images: [image] }'), t('docs.copyCurl'))}
    <p class="api-note">${t('docs.continueImageHelp', code('data:image/${output_format};base64,${data[0].b64_json}'))}</p>
  `, expanded);

  const health = endpoint('health', 'GET', '/healthz', t('docs.health'), t('docs.healthSummary'), `
    <p>${t('docs.healthHelp')}</p>
    ${block('health-request', t('docs.healthCurl'), curl(`${origin}/healthz`, undefined, { auth: false }), t('docs.copyCurl'))}
    ${block('health-response', t('docs.successResponse'), json({ ok: true, version }))}
  `, expanded, false);

  const keyView = client ? 'settings' : 'keys';
  const keyLink = client ? t('client.settings') : t('docs.manageKeys');
  return `<div class="api-docs">
    <header class="page-heading"><div class="eyebrow">${t('docs.reference')}</div><h1>${t('common.apiDocs')}</h1><p>${t('docs.introduction')}</p></header>
    <section class="card api-connection" aria-labelledby="api-connection-title">
      <div class="between wrap"><div><h2 id="api-connection-title">${t('docs.connectionAndAuth')}</h2><p>${t('docs.compatibleBaseUrl')}</p><code class="api-base-url">${escape(baseUrl)}</code></div><button data-action="copy-endpoint">${t('docs.copyAddress', copyIcon)}</button></div>
      <div class="api-authorization"><div><span>${t('docs.requestHeader')}</span><code>Authorization: Bearer $MODEL_DOCK_API_KEY</code></div><button class="small-button" data-view="${keyView}">${keyLink} →</button></div>
      <p class="api-note">${t('docs.authHelp')}</p>
      <p class="api-note"><a href="/openapi.json" download="model-dock.openapi.json">${t('docs.openapiDownload')}</a></p>
    </section>
    <div class="section-header between wrap"><h2 id="api-list-title">${t('docs.endpoints')} <span class="api-count">5</span></h2><span class="muted">${t('docs.expandHelp')}</span></div>
    <section class="api-endpoints" aria-labelledby="api-list-title">${catalog}${chat}${responses}${images}${health}</section>
    <section class="card api-errors" aria-labelledby="api-errors-title"><h2 id="api-errors-title">${t('docs.errorHandling')}</h2><p>${t('docs.errorHelp')}</p>
      ${block('error', t('docs.errorExample'), json({ error: { message: 'This key cannot use the selected model.', type: 'invalid_request_error', code: 'model_forbidden', param: null } }))}
      ${table([t('docs.httpStatus'), t('docs.errorCodes'), t('docs.errorResolution')], [
        ['400', code('invalid_request / unsupported_parameter / unsupported_model_capability / invalid_image_input'), t('docs.badRequestHelp')],
        ['400', code('context_length_exceeded'), t('errors.codexContextLength')],
        ['401', code('unauthorized / key_revoked'), t('docs.unauthorizedHelp')],
        ['403', code('model_forbidden'), t('docs.forbiddenHelp')],
        ['404', code('model_unavailable'), t('docs.modelUnavailableHelp')],
        ['409', code('budget_price_required / budget_token_ceiling_required'), t('docs.budgetRequirements')],
        ['413', code('request_too_large / image_reference_too_large'), t('docs.tooLargeHelp')],
        ['415', code('unsupported_media_type'), code('Content-Type: application/json')],
        ['429', code('connection_busy'), t('docs.busyHelp')],
        ['429', code('project_rate_limited / project_at_capacity / request_body_capacity'), t('docs.localLimitsHelp')],
        ['429', code('project_budget_exceeded'), t('errors.projectBudgetExceeded')],
        ['429', code('upstream_rate_limited / codex_rate_limited'), t('docs.rateLimitedHelp')],
        ['502', code('upstream_auth_failed / upstream_protocol_error / upstream_json_invalid / codex_protocol_error'), t('docs.upstreamErrorHelp')],
        ['502', code('upstream_tool_choice_failed / codex_tool_required / codex_tool_invalid'), t('docs.toolErrorHelp')],
        ['503', code('pool_unavailable'), t('errors.poolUnavailable')],
        ['503', code('budget_ledger_unavailable'), t('errors.budgetLedgerUnavailable')],
        ['504', code('request_timeout'), t('docs.timeoutHelp')]
      ])}
      <p class="api-note">${t('docs.retryHelp')}</p>
    </section>
  </div>`;
}
