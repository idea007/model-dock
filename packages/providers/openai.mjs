import { sse } from '../protocol/events.mjs';
import { fetchUpstream, jsonResponse, usage, headers, protocolError } from './http.mjs';

const tokenLimit = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const effortName = value => typeof value === 'string' && value.length > 0 && value.length <= 30 && value.trim() === value && !/[\u0000-\u001f]/u.test(value);

export const openai = {
  async discover(connection, { secret, signal }) {
    const result = await jsonResponse(await fetchUpstream(`${connection.baseUrl}/models`, { headers: headers(secret), signal }));
    if (!Array.isArray(result.data)) throw protocolError();
    return result.data.slice(0, 1000).filter(model => typeof model?.id === 'string' && model.id.length <= 300).map(model => {
      const levels = Array.isArray(model.reasoning_efforts) ? [...new Set(model.reasoning_efforts.filter(effortName))] : [];
      return {
        nativeId: model.id, name: model.id,
        capabilities: Object.fromEntries(['text', 'tools', 'structured', 'thinking', 'image_input'].map(key => [key, typeof model.capabilities?.[key] === 'boolean' ? model.capabilities[key] : null])),
        maxInputTokens: tokenLimit(model.max_input_tokens),
        maxOutputTokens: tokenLimit(model.max_output_tokens),
        contextWindow: tokenLimit(model.context_window),
        reasoningEfforts: levels,
        defaultEffort: levels.includes(model.default_reasoning_effort) ? model.default_reasoning_effort : null,
        details: 'Capabilities depend on the provider model listing.'
      };
    });
  },
  async *generate(connection, request, { secret, signal, responses }) {
    const body = responses ? { ...request, store: false } : request;
    if (responses && request.stream && new URL(connection.baseUrl).origin === 'https://api.openai.com') {
      body.stream_options = { include_usage: true };
    }
    const response = await fetchUpstream(`${connection.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(secret), body: JSON.stringify(body), signal
    });
    if (!request.stream) {
      const result = await jsonResponse(response);
      const choice = result.choices?.[0];
      if (!choice?.message || !choice.finish_reason) throw protocolError();
      const message = choice.message;
      if (message.content != null && typeof message.content !== 'string') throw protocolError();
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw protocolError();
      yield { type: 'delta', delta: {
        ...(message.content != null ? { content: message.content } : {}),
        ...(message.refusal != null ? { refusal: message.refusal } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {})
      } };
      if (usage(result.usage)) yield { type: 'usage', usage: usage(result.usage) };
      yield { type: 'done', finishReason: choice.finish_reason }; return;
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw protocolError(); }
    let finishReason, ended = false;
    try {
      for await (const data of sse(response.body)) {
        if (data === '[DONE]') { ended = true; break; }
        const result = JSON.parse(data);
        if (result.error) throw protocolError();
        for (const choice of result.choices || []) {
          if (choice.index && choice.index !== 0) throw protocolError();
          if (choice.delta) yield { type: 'delta', delta: choice.delta };
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (usage(result.usage)) yield { type: 'usage', usage: usage(result.usage) };
      }
    } catch (error) { if (signal.aborted) throw signal.reason; throw protocolError(); }
    if (!ended || !finishReason) throw protocolError();
    yield { type: 'done', finishReason };
  }
};
