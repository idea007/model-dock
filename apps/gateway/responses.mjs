import { newId } from '../../packages/core/store.mjs';
import { errorPayload } from '../../packages/protocol/index.mjs';
import { responsesToChat } from '../../packages/protocol/responses.mjs';
import { completionState, finalizeCompletion, mergeDelta } from './completion.mjs';
import { beginStream, json, write } from './http.mjs';

const incompleteReasons = new Map([['length', 'max_output_tokens'], ['content_filter', 'content_filter']]);

export async function createResponse(http, gateway, body, principal, context) {
  const { id, signal } = context;
  const request = responsesToChat(body);
  const streaming = body.stream === true;
  const state = completionState();
  const response = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model,
    status: 'in_progress', output: [], error: null, incomplete_details: null, usage: null,
    store: false, instructions: body.instructions ?? null, tools: (request.tools || []).map(({ type, function: fn }) => ({ type, ...fn })),
    tool_choice: body.tool_choice ?? 'auto', parallel_tool_calls: false, text: { format: { type: 'text' } },
    temperature: null, top_p: null, metadata: null, access_programs: null
  };
  let heartbeat, sequence = 0, message;
  const parts = new Map();
  const emit = (type, value) => write(http, `event: ${type}\ndata: ${JSON.stringify({ ...value, type, sequence_number: sequence++ })}\n\n`, signal);
  const itemEvent = (type, output_index, item) => emit(type, { output_index, item });

  async function addContent(field, delta) {
    if (!delta) return;
    if (!message) {
      message = { id: newId('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      response.output.push(message);
      if (streaming) await itemEvent('response.output_item.added', 0, message);
    }
    const type = field === 'content' ? 'output_text' : 'refusal';
    const key = field === 'content' ? 'text' : 'refusal';
    const extra = field === 'content' ? { logprobs: [] } : {};
    let content_index = parts.get(field);
    if (content_index === undefined) {
      const part = { type, [key]: '', ...(field === 'content' ? { annotations: [], ...extra } : {}) };
      content_index = message.content.length;
      parts.set(field, content_index);
      message.content.push(part);
      if (streaming) await emit('response.content_part.added', { item_id: message.id, output_index: 0, content_index, part });
    }
    message.content[content_index][key] = state[field];
    if (streaming) await emit(`response.${type}.delta`, { item_id: message.id, output_index: 0, content_index, delta, ...extra });
  }

  async function finishMessage(status) {
    if (!message || message.status !== 'in_progress') return;
    message.status = status;
    if (!streaming) return;
    for (const [content_index, part] of message.content.entries()) {
      const location = { item_id: message.id, output_index: 0, content_index };
      const value = part.type === 'output_text' ? { text: part.text, logprobs: part.logprobs } : { refusal: part.refusal };
      await emit(`response.${part.type}.done`, { ...location, ...value });
      await emit('response.content_part.done', { ...location, part });
    }
    await itemEvent('response.output_item.done', 0, message);
  }

  async function addTool(call) {
    const item = { type: 'function_call', id: newId('fc'), call_id: call.id, name: call.function.name,
      arguments: call.function.arguments, status: 'completed' };
    const output_index = response.output.length;
    response.output.push(item);
    if (!streaming) return;
    await itemEvent('response.output_item.added', output_index, { ...item, arguments: '', status: 'in_progress' });
    const location = { item_id: item.id, output_index };
    await emit('response.function_call_arguments.delta', { ...location, delta: item.arguments });
    await emit('response.function_call_arguments.done', { ...location, name: item.name, arguments: item.arguments });
    await itemEvent('response.output_item.done', output_index, item);
  }

  try {
    for await (const event of gateway.generate(request, principal, context)) {
      if (event.type === 'delta') mergeDelta(state, event.delta);
      if (streaming && !http.headersSent) {
        heartbeat = beginStream(http);
        await emit('response.created', { response });
        await emit('response.in_progress', { response });
      }
      if (event.type === 'delta') {
        await addContent('content', event.delta.content);
        await addContent('refusal', event.delta.refusal);
      } else if (event.type === 'usage') {
        const { prompt_tokens, completion_tokens, total_tokens } = event.usage;
        response.usage = { input_tokens: prompt_tokens, output_tokens: completion_tokens, total_tokens };
      } else if (event.type === 'done') state.finishReason = event.finishReason;
    }
    const incomplete = incompleteReasons.get(state.finishReason);
    const [tool] = finalizeCompletion(state, request);
    response.status = incomplete ? 'incomplete' : 'completed';
    response.incomplete_details = incomplete ? { reason: incomplete } : null;
    await finishMessage(response.status);
    if (tool) await addTool(tool);
    if (streaming) {
      await emit(`response.${response.status}`, { response });
      http.end();
    } else json(http, 200, response);
  } catch (error) {
    if (body.max_output_tokens !== undefined && error?.param === 'max_completion_tokens') error.param = 'max_output_tokens';
    gateway.recordResponseFailure(context, error);
    if (!http.headersSent) throw error;
    if (signal.aborted || http.destroyed) return;
    const failure = errorPayload(error).error;
    response.status = 'failed';
    response.incomplete_details = null;
    response.error = { code: failure.code, message: failure.message };
    if (message) message.status = 'incomplete';
    try {
      await emit('response.failed', { response });
      http.end();
    } catch {
      http.destroy();
    }
  } finally {
    clearInterval(heartbeat);
  }
}
