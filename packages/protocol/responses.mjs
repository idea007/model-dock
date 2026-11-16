import { exact, fail } from './index.mjs';

export const RESPONSES_PARAMS = ['model', 'input', 'instructions', 'stream', 'store', 'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls'];

function messageFromItem(item) {
  exact(item, ['type', 'role', 'content', 'id', 'status']);
  if (![undefined, 'message'].includes(item.type) || !['system', 'developer', 'user', 'assistant'].includes(item.role)) {
    fail('Use a system, developer, user or assistant text message.', 'invalid_request', 'input');
  }
  if ((item.id !== undefined && typeof item.id !== 'string') || ![undefined, 'completed', 'incomplete'].includes(item.status)) {
    fail('Invalid message item id or status.', 'invalid_request', 'input');
  }
  if (typeof item.content === 'string') return { role: item.role, content: item.content };
  if (!Array.isArray(item.content) || !item.content.length) fail('Use text content or a non-empty array of content parts.', 'unsupported_content', 'input');
  const content = [], refusal = [];
  for (const part of item.content) {
    if (part?.type === 'input_text') {
      exact(part, ['type', 'text']);
    } else if (item.role === 'user' && part?.type === 'input_image') {
      exact(part, ['type', 'image_url', 'detail']);
      const { image_url: url, detail } = part;
      content.push({ type: 'image_url', image_url: { url, ...(detail === undefined ? {} : { detail }) } });
      continue;
    } else if (item.role === 'assistant' && part?.type === 'output_text') {
      exact(part, ['type', 'text', 'annotations', 'logprobs', 'parsed']);
      if ([part.annotations, part.logprobs].some(value => value !== undefined && (!Array.isArray(value) || value.length))) {
        fail('Only plain assistant text can be replayed.', 'unsupported_content', 'input');
      }
    } else if (item.role === 'assistant' && part?.type === 'refusal') {
      exact(part, ['type', 'refusal', 'parsed']);
      if (typeof part.refusal !== 'string' || !part.refusal.length) fail('Use non-empty refusal text.', 'invalid_request', 'input');
      refusal.push(part.refusal);
      continue;
    } else {
      fail('Use text, images in user messages, or assistant refusals.', 'unsupported_content', 'input');
    }
    if (typeof part.text !== 'string') fail('A text part must contain a string.', 'invalid_request', 'input');
    content.push({ type: 'text', text: part.text });
  }
  return { role: item.role, content: content.length ? content : null, ...(refusal.length ? { refusal: refusal.join('') } : {}) };
}

function inputMessages(input) {
  if (typeof input === 'string' && input.length) return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || !input.length || input.length > 2048) {
    fail('Use a non-empty input string or an array of up to 2048 items.', 'invalid_request', 'input');
  }
  const messages = [];
  for (const item of input) {
    switch (item?.type) {
      case undefined:
      case 'message':
        messages.push(messageFromItem(item));
        break;
      case 'function_call': {
        exact(item, ['type', 'id', 'status', 'call_id', 'name', 'arguments', 'parsed_arguments']);
        if ((item.id !== undefined && typeof item.id !== 'string') || ![undefined, 'completed'].includes(item.status)) {
          fail('Replay a completed function call.', 'invalid_request', 'input');
        }
        const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && !previous.tool_calls) previous.tool_calls = [call];
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        break;
      }
      case 'function_call_output':
        exact(item, ['type', 'id', 'status', 'call_id', 'output']);
        if (typeof item.output !== 'string' || (item.id !== undefined && typeof item.id !== 'string') || ![undefined, 'completed'].includes(item.status)) {
          fail('Supply completed function output as a string.', 'invalid_request', 'input');
        }
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        break;
      default:
        fail('Unsupported Responses input item.', 'unsupported_content', 'input');
    }
  }
  return messages;
}

export function responsesToChat(body) {
  exact(body, RESPONSES_PARAMS);
  if (body.store !== undefined && body.store !== false) fail('This endpoint uses store: false.', 'unsupported_parameter', 'store');
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) {
    fail('This endpoint hands off at most one function per request.', 'unsupported_parameter', 'parallel_tool_calls');
  }
  if (body.instructions != null && typeof body.instructions !== 'string') fail('Use string instructions.', 'invalid_request', 'instructions');
  if (body.max_output_tokens !== undefined && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 1_000_000)) {
    fail('max_output_tokens must be an integer between 1 and 1000000.', 'invalid_request', 'max_output_tokens');
  }
  const messages = inputMessages(body.input);
  if (body.instructions) {
    if (messages.length === 2048) fail('Leave room for instructions in the 2048-message limit.', 'invalid_request', 'input');
    messages.unshift({ role: 'system', content: body.instructions });
  }
  const request = { model: body.model, messages, stream: body.stream };
  if (body.max_output_tokens !== undefined) request.max_completion_tokens = body.max_output_tokens;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) fail('Use an array of up to 128 functions.', 'invalid_request', 'tools');
    request.tools = body.tools.map(tool => {
      exact(tool, ['type', 'name', 'description', 'parameters', 'strict']);
      const { type, ...fn } = tool;
      if (type !== 'function') fail('Only application functions are supported.', 'unsupported_parameter', 'tools');
      return { type, function: { ...fn, strict: fn.strict ?? false } };
    });
    if (request.tools.length) request.parallel_tool_calls = false;
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') request.tool_choice = body.tool_choice;
    else {
      exact(body.tool_choice, ['type', 'name']);
      request.tool_choice = { type: body.tool_choice.type, function: { name: body.tool_choice.name } };
    }
  }
  return request;
}
