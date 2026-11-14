import { decodeImageData, imageDataByteLength, parseImageDataUrl } from './image-data.mjs';
import { imageAspectRatios, maxImageReferences, maxImageReferenceBytes, maxImageReferenceTotalBytes } from './image-options.mjs';

export const VERSION = '0.1.0';
export const SCHEMA_VERSION = 2;
export class GatewayError extends Error {
  constructor(message, status = 400, code = 'invalid_request', param = null, { retryAfter } = {}) {
    super(message); this.name = 'GatewayError'; this.status = status; this.code = code; this.param = param;
    this.retryAfter = retryAfter;
  }
}
export function normalizeRetryAfter(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (/^\d+$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isFinite(date.getTime()) && date.toUTCString() === value) return value;
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
export const IMAGE_PARAMS = ['model', 'prompt', 'n', 'response_format', 'aspect_ratio', 'reference_images', 'background'];
export function validateImageGeneration(body) {
  exact(body, IMAGE_PARAMS);
  const model = string(body.model, 'model', 512);
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(body.prompt)) {
    fail('Use a non-empty image prompt of at most 4000 characters.', 'invalid_request', 'prompt');
  }
  if (body.n !== undefined && body.n !== 1) fail('This endpoint generates one image per request.', 'unsupported_parameter', 'n');
  if (body.response_format !== undefined && body.response_format !== 'b64_json') {
    fail('Use response_format b64_json.', 'unsupported_parameter', 'response_format');
  }
  if (body.aspect_ratio !== undefined && !imageAspectRatios.includes(body.aspect_ratio)) {
    fail(`Choose an aspect_ratio from ${imageAspectRatios.join(', ')}.`, 'invalid_request', 'aspect_ratio');
  }
  if (body.background !== undefined && !['auto', 'transparent'].includes(body.background)) {
    fail('Choose background auto or transparent.', 'invalid_request', 'background');
  }
  if (body.reference_images !== undefined && (!Array.isArray(body.reference_images) || body.reference_images.length > maxImageReferences)) {
    fail(`reference_images must be an array of up to ${maxImageReferences} images.`, 'invalid_image_reference', 'reference_images');
  }
  return { model, prompt: body.prompt.trim(), aspectRatio: body.aspect_ratio, background: body.background };
}
export function decodeImageReferences(references = []) {
  let total = 0;
  return references.map((value, index) => {
    const param = `reference_images[${index}]`;
    const invalid = () => fail('Use a Base64 data URL with matching PNG, JPEG or WebP image data.', 'invalid_image_reference', param);
    const tooLarge = () => { throw new GatewayError('A reference image exceeds 30 MiB.', 413, 'image_reference_too_large', param); };
    const source = parseImageDataUrl(value);
    if (!source) invalid();
    const { encoded, format } = source;
    if (encoded.length > Math.ceil(maxImageReferenceBytes / 3) * 4) tooLarge();
    const size = imageDataByteLength(encoded);
    if (!size) invalid();
    if (size > maxImageReferenceBytes) tooLarge();
    total += size;
    if (total > maxImageReferenceTotalBytes) throw new GatewayError('Reference images exceed 50 MiB in total.', 413, 'image_reference_too_large', 'reference_images');
    const image = decodeImageData(encoded, format);
    if (!image) invalid();
    return image;
  });
}

function validateImagePart(part, param) {
  exact(part, ['type', 'image_url']);
  exact(part.image_url, ['url', 'detail']);
  const { url, detail } = part.image_url;
  if (detail !== undefined && detail !== 'auto') fail('Omit image detail or use auto.', 'unsupported_parameter', param);
  if (typeof url === 'string' && !/^data:/i.test(url)) fail('Use a Base64 image data URL.', 'unsupported_content', param);
  const source = parseImageDataUrl(url);
  if (!source || !imageDataByteLength(source.encoded) || !decodeImageData(source.encoded, source.format, { checkContainer: true })) {
    fail('Use a Base64 data URL with matching PNG, JPEG or WebP image data.', 'invalid_image_input', param);
  }
}

export const PARAMS = ['model', 'messages', 'n', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'user'];
export function validateChat(body, contentParam = 'messages') {
  exact(body, PARAMS); string(body.model, 'model', 512);
  if (body.n !== undefined && body.n !== 1) fail('This endpoint returns one choice per request.', 'unsupported_parameter', 'n');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2048) fail('messages must be a non-empty array (maximum 2048).');
  const pending = new Set(), seen = new Set();
  let normalizedMessages;
  for (const [index, message] of body.messages.entries()) {
    exact(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'refusal']);
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) fail('Unsupported message role.');
    if (message.name !== undefined) string(message.name, 'name', 128);
    if (message.refusal !== undefined && (message.role !== 'assistant' || message.refusal !== null && typeof message.refusal !== 'string')) {
      fail('refusal is only valid on assistant messages and must be a string or null.', 'invalid_request', 'messages');
    }
    const content = message.content;
    if (Array.isArray(content)) {
      if (!content.length) fail('A content array must contain at least one part.', 'invalid_request', contentParam);
      const parts = [];
      let hasImages = false;
      for (const part of content) {
        if (part?.type === 'text') {
          exact(part, ['type', 'text']);
          if (typeof part.text !== 'string') fail('A text content part must contain a string.', 'invalid_request', contentParam);
          parts.push(part.text);
        } else if (part?.type === 'image_url' && message.role === 'user') {
          validateImagePart(part, contentParam);
          hasImages = true;
        } else fail('Use text content parts or images in user messages.', 'unsupported_content', contentParam);
      }
      if (!hasImages) {
        normalizedMessages ||= [...body.messages];
        normalizedMessages[index] = { ...message, content: parts.join('') };
      }
    } else if (content === undefined && message.role === 'assistant' && message.tool_calls?.length) {
      normalizedMessages ||= [...body.messages];
      normalizedMessages[index] = { ...message, content: null };
    } else if (content !== null && typeof content !== 'string') {
      fail('Use string content or a content array.', 'unsupported_content', contentParam);
    }
    if (message.content === null && !(message.role === 'assistant' && (message.tool_calls?.length || message.refusal))) {
      fail('Only assistant tool calls or refusals may have null content.');
    }
    if (pending.size && message.role !== 'tool') fail('Every tool call must have a tool result before the next message.');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) fail('Invalid tool calls.');
      for (const call of message.tool_calls) {
        exact(call, ['id', 'type', 'function']); string(call.id, 'tool call id');
        exact(call.function, ['name', 'arguments']); string(call.function.name, 'function name', 128);
        if (call.type !== 'function' || seen.has(call.id) || typeof call.function.arguments !== 'string') fail('Invalid or duplicate tool call.');
        try { object(JSON.parse(call.function.arguments), 'tool arguments'); } catch { fail('Tool arguments must be a JSON object.'); }
        seen.add(call.id); pending.add(call.id);
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
      if (tool.type !== 'function' || typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name) || names.has(fn.name)) fail('Invalid or duplicate function name.');
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
  if (!normalizedMessages && body.n === undefined) return body;
  const normalized = { ...body, messages: normalizedMessages ?? body.messages };
  delete normalized.n;
  return normalized;
}
export function errorPayload(error) {
  const known = error instanceof GatewayError;
  return { error: {
    message: known ? error.message : 'The request could not be completed.',
    type: known && error.status < 500 ? 'invalid_request_error' : 'server_error',
    code: known ? error.code : 'internal_error', param: known ? error.param : null
  } };
}
