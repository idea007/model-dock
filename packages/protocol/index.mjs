export const VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export class GatewayError extends Error {
  constructor(message, status = 400, code = 'invalid_request', param = null) {
    super(message); this.name = 'GatewayError'; this.status = status; this.code = code; this.param = param;
  }
}
export function fail(message, code = 'invalid_request', param = null) {
  throw new GatewayError(message, 400, code, param);
}
export function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}
export function exact(value, fields) {
  object(value);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`Unsupported field: ${key}`, 'unsupported_parameter', key);
}
export function string(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(`Invalid ${name}.`, 'invalid_request', name);
  return value.trim();
}
export function slug(value, name = 'alias') {
  const result = string(value, name, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) fail(`${name} must contain only letters, digits, dots, hyphens or underscores.`);
  return result;
}
export const PARAMS = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'user'];
export function validateChat(body) {
  exact(body, PARAMS); string(body.model, 'model', 512);
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2048) fail('messages must be a non-empty array (maximum 2048).');
  const pending = new Map(), seen = new Set();
  for (const message of body.messages) {
    exact(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls']);
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) fail('Unsupported message role.');
    if (message.name !== undefined) string(message.name, 'name', 128);
    if (message.content !== null && typeof message.content !== 'string') fail('This release accepts text content only.', 'unsupported_content', 'messages');
    if (message.content === null && !(message.role === 'assistant' && message.tool_calls?.length)) fail('Only assistant tool calls may have null content.');
    if (pending.size && message.role !== 'tool') fail('Every tool call must have a tool result before the next message.');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) fail('Invalid tool calls.');
      for (const call of message.tool_calls) {
        exact(call, ['id', 'type', 'function']); string(call.id, 'tool call id');
        exact(call.function, ['name', 'arguments']); string(call.function.name, 'function name', 128);
        if (call.type !== 'function' || seen.has(call.id) || typeof call.function.arguments !== 'string') fail('Invalid or duplicate tool call.');
        try { object(JSON.parse(call.function.arguments), 'tool arguments'); } catch { fail('Tool arguments must be a JSON object.'); }
        seen.add(call.id); pending.set(call.id, call.function.name);
      }
    }
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) fail('Tool result has no matching call.');
    } else if (message.tool_call_id !== undefined) fail('tool_call_id is only valid on tool messages.');
  }
  if (pending.size) fail('A tool result is missing.');
  for (const key of ['stream', 'parallel_tool_calls']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(`${key} must be boolean.`);
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > 1_000_000)) fail(`${key} must be an integer between 1 and 1000000.`);
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) fail('Use one output-token limit.');
  for (const [key, max] of [['temperature', 2], ['top_p', 1]]) if (body[key] !== undefined && (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > max)) fail(`Invalid ${key}.`);
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) fail('seed must be an integer.');
  if (body.stop !== undefined && !(typeof body.stop === 'string' || Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every(x => typeof x === 'string'))) fail('Invalid stop sequences.');
  if (body.stream_options !== undefined) {
    exact(body.stream_options, ['include_usage']);
    if (body.stream !== true || typeof body.stream_options.include_usage !== 'boolean') fail('stream_options requires streaming and a boolean include_usage.');
  }
  if (body.reasoning_effort !== undefined) string(body.reasoning_effort, 'reasoning_effort', 30);
  if (body.user !== undefined) string(body.user, 'user', 200);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) fail('Invalid tools array.');
    const names = new Set();
    for (const tool of body.tools) {
      exact(tool, ['type', 'function']); exact(tool.function, ['name', 'description', 'parameters', 'strict']);
      const fn = tool.function;
      if (tool.type !== 'function' || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name || '') || names.has(fn.name)) fail('Invalid or duplicate function name.');
      names.add(fn.name); object(fn.parameters, 'parameters');
      if (fn.parameters.type !== 'object') fail('Function parameters must be an object schema.');
      if (fn.description !== undefined && typeof fn.description !== 'string') fail('Invalid function description.');
      if (fn.strict !== undefined && typeof fn.strict !== 'boolean') fail('Invalid strict flag.');
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) fail('Invalid tool_choice.');
      if (choice === 'required' && !body.tools?.length) fail('tool_choice requires tools.');
    } else {
      exact(choice, ['type', 'function']); exact(choice.function, ['name']);
      if (choice.type !== 'function' || !body.tools?.some(tool => tool.function.name === choice.function.name)) fail('Selected tool was not supplied.');
    }
  }
  if (body.response_format !== undefined) {
    const format = body.response_format; exact(format, ['type', 'json_schema']);
    if (!['text', 'json_object', 'json_schema'].includes(format.type)) fail('Invalid response_format.');
    if (format.type === 'json_schema') {
      exact(format.json_schema, ['name', 'description', 'schema', 'strict']);
      string(format.json_schema.name, 'schema name', 128); object(format.json_schema.schema, 'schema');
      if (format.json_schema.strict !== undefined && typeof format.json_schema.strict !== 'boolean') fail('Invalid strict flag.');
    } else if (format.json_schema !== undefined) fail('json_schema requires type=json_schema.');
  }
  return body;
}
export function errorPayload(error) {
  const known = error instanceof GatewayError;
  return { error: {
    message: known ? error.message : 'The request could not be completed.',
    type: known && error.status < 500 ? 'invalid_request_error' : 'server_error',
    code: known ? error.code : 'internal_error', param: known ? error.param : null
  } };
}
