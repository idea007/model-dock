import { randomUUID } from 'node:crypto';
import { GatewayError } from '../protocol/index.mjs';
import { parseImageDataUrl } from '../protocol/image-data.mjs';
import { lines } from '../protocol/events.mjs';
import { fetchUpstream, jsonResponse, headers, protocolError } from './http.mjs';

const unsupported = key => { throw new GatewayError(`Ollama adapter does not support ${key}.`, 400, 'unsupported_parameter', key); };
export const ollama = {
  async discover(connection, { secret, signal }) {
    const result = await jsonResponse(await fetchUpstream(`${connection.baseUrl}/api/tags`, { headers: headers(secret), signal }));
    if (!Array.isArray(result.models)) throw protocolError();
    const models = [];
    for (const item of result.models.slice(0, 128)) {
      const nativeId = item.name || item.model;
      if (typeof nativeId !== 'string') continue;
      const detail = await jsonResponse(await fetchUpstream(`${connection.baseUrl}/api/show`, {
        method: 'POST', headers: headers(secret), body: JSON.stringify({ model: nativeId }), signal
      }));
      const caps = detail.capabilities || [];
      // Older servers without capability metadata are unknown, never guessed from names.
      if (caps.length && !caps.includes('completion')) continue;
      const contexts = Object.entries(detail.model_info || {}).filter(([key, value]) => key.endsWith('.context_length') && Number.isSafeInteger(value) && value > 0).map(([, value]) => value);
      const nativeContext = contexts.length ? Math.max(...contexts) : null;
      const configured = Number(String(detail.parameters || '').match(/\bnum_ctx\s+(\d+)/)?.[1]);
      models.push({ nativeId, name: nativeId, capabilities: {
        text: caps.length ? caps.includes('completion') : null,
        tools: caps.length ? caps.includes('tools') : null,
        image_input: caps.length ? caps.includes('vision') : null,
        structured: true, thinking: caps.length ? caps.includes('thinking') : null
      }, contextWindow: nativeContext ? configured > 0 ? Math.min(configured, nativeContext) : nativeContext : null,
      sizeBytes: Number.isSafeInteger(item.size) ? item.size : null,
      details: [item.details?.parameter_size, item.details?.quantization_level].filter(Boolean).join(' · ') });
    }
    return models;
  },
  async *generate(connection, request, { secret, signal, model }) {
    if (request.user !== undefined) unsupported('user');
    if (request.parallel_tool_calls === true) unsupported('parallel_tool_calls');
    if (request.tool_choice !== undefined && !['auto', 'none'].includes(request.tool_choice)) unsupported('tool_choice');
    if (request.tools?.length && model.capabilities.tools === false) unsupported('tools');
    if (request.tools?.some(tool => tool.function.strict === true)) unsupported('tools.function.strict');
    if (request.response_format?.json_schema?.strict === true) unsupported('response_format.json_schema.strict');
    if (request.reasoning_effort !== undefined) {
      if (model.capabilities.thinking === false || !['none', 'low', 'medium', 'high'].includes(request.reasoning_effort)) unsupported('reasoning_effort');
    }
    const callNames = new Map();
    const messages = request.messages.map(message => {
      for (const call of message.tool_calls || []) callNames.set(call.id, call.function.name);
      const parts = Array.isArray(message.content) ? message.content : null;
      const content = parts ? parts.filter(part => part.type === 'text').map(part => part.text).join('') : message.content || message.refusal || '';
      const images = parts?.filter(part => part.type === 'image_url').map(part => parseImageDataUrl(part.image_url.url).encoded);
      return { role: message.role === 'developer' ? 'system' : message.role, content,
        ...(images?.length ? { images } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ id: call.id,
          function: { index, name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) } : {}),
        ...(message.role === 'tool' ? { tool_name: callNames.get(message.tool_call_id), tool_call_id: message.tool_call_id } : {}) };
    });
    const options = Object.fromEntries(['temperature', 'top_p', 'seed', 'stop'].filter(key => request[key] !== undefined).map(key => [key, request[key]]));
    if (request.max_tokens ?? request.max_completion_tokens) options.num_predict = request.max_tokens ?? request.max_completion_tokens;
    // Do not allocate the model's maximum context automatically. Respect Ollama's configured context.
    const body = { model: request.model, messages, stream: true, options,
      ...(request.reasoning_effort !== undefined ? { think: request.reasoning_effort === 'none' ? false : request.reasoning_effort } : {}) };
    if (request.tools?.length && request.tool_choice !== 'none') {
      body.tools = request.tools.map(({ type, function: { strict, ...fn } }) => ({ type, function: fn }));
    }
    if (request.response_format?.type === 'json_object') body.format = 'json';
    if (request.response_format?.type === 'json_schema') body.format = request.response_format.json_schema.schema;
    const response = await fetchUpstream(`${connection.baseUrl}/api/chat`, { method: 'POST', headers: headers(secret), body: JSON.stringify(body), signal });
    let done = false, hasTools = false, index = 0;
    try {
      for await (const line of lines(response.body)) {
        if (!line.trim()) continue;
        const value = JSON.parse(line); if (value.error) throw protocolError();
        if (value.message?.content) yield { type: 'delta', delta: { content: value.message.content } };
        for (const call of value.message?.tool_calls || []) {
          const fn = call?.function;
          if (!fn?.name || !fn.arguments || typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)) throw protocolError();
          const id = call.id == null || call.id === '' ? `call_${randomUUID()}` : call.id;
          hasTools = true;
          yield { type: 'delta', delta: { tool_calls: [{ index: index++, id, type: 'function',
            function: { name: fn.name, arguments: JSON.stringify(fn.arguments) } }] } };
        }
        if (value.done === true) {
          if ([value.prompt_eval_count, value.eval_count].every(x => Number.isSafeInteger(x) && x >= 0)) yield { type: 'usage', usage: {
            prompt_tokens: value.prompt_eval_count, completion_tokens: value.eval_count, total_tokens: value.prompt_eval_count + value.eval_count
          } };
          const finishReason = ['length', 'content_filter'].includes(value.done_reason) ? value.done_reason : hasTools ? 'tool_calls' : 'stop';
          yield { type: 'done', finishReason };
          done = true; break;
        }
      }
    } catch (error) { if (signal.aborted) throw signal.reason; throw protocolError(); }
    if (!done) throw protocolError();
  }
};
