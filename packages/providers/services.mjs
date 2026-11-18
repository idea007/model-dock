import { GatewayError } from '../protocol/index.mjs';
import { mediaInterfaces } from '../protocol/media-options.mjs';

const taskId = '([A-Za-z0-9_.:-]{1,160})';
const route = (method, path, options = {}) => ({ method, path: new RegExp(`^${path}$`), ...options });
const models = route('GET', '/models');
const minimaxModels = route('GET', '/v1/models');
const health = route('GET', '/health', { useOrigin: true });
const chat = route('POST', '/chat/completions');
const parts = [
  ['deepseek', [models, route('GET', '/user/balance'), chat]],
  ['deepseek-search', [route('POST', '/tools/search')]],
  ['minimax-chat', [models, chat, route('POST', '/responses')]],
  ['seedream', [models, route('POST', '/images/generations', { image: true })]],
  ['minimax-image', [minimaxModels, route('POST', '/v1/image_generation', { image: true })]],
  ['seedance', [
    models, route('POST', '/contents/generations/tasks', { created: body => body.id }),
    route('GET', `/contents/generations/tasks/${taskId}`, { owned: 'task' }),
    route('DELETE', `/contents/generations/tasks/${taskId}`, { owned: 'task' })
  ]],
  ['minimax-video', [
    minimaxModels, route('POST', '/v2/video_generation', { created: body => body.task_id }),
    route('GET', `/v2/query/video_generation/${taskId}`, { owned: 'task' }),
    route('DELETE', `/v2/video_generation/${taskId}`, { owned: 'task' })
  ]],
  ['wan', [
    route('GET', '/tasks/credential-probe'),
    route('POST', '/services/aigc/video-generation/video-synthesis', {
      created: body => body.output?.task_id, headers: { 'x-dashscope-async': 'enable' }
    }),
    route('GET', `/tasks/${taskId}`, { owned: 'task' }),
    route('POST', `/tasks/${taskId}/cancel`, { owned: 'task' })
  ]],
  ['local-ltx', [
    models, health, route('POST', '/video/generations', { created: body => body.id, idempotency: true }),
    route('GET', `/video/operations/${taskId}`, { owned: 'operation', created: body => body.id || body.task?.id }),
    route('GET', `/video/generations/${taskId}`, { owned: 'task' }),
    route('GET', `/video/generations/${taskId}/content`, { owned: 'task' }),
    route('DELETE', `/video/generations/${taskId}`, { owned: 'task' })
  ]],
  ['minimax-speech', [
    minimaxModels, route('POST', '/v1/get_voice'), route('POST', '/v1/t2a_v2'),
    route('POST', '/v1/files/upload', { created: body => body.file?.file_id, outputKind: 'file' }),
    route('POST', '/v1/voice_clone', { bodyOwner: body => body.file_id, owned: 'file' })
  ]],
  ['speech', [
    models, health, route('POST', '/audio/speech'), route('POST', '/audio/speech-with-timestamps'),
    route('POST', '/audio/reference-speech'), route('POST', '/audio/moss-reference-speech'),
    route('GET', '/audio/timing-capabilities', { query: ['model'] })
  ]],
  ['transcription', [models, health, route('POST', '/audio/transcriptions')]],
  ['edge-tts', [health, route('POST', '/audio/speech-with-timestamps')]],
  ['greyscope', [health, route('POST', '/detect')]],
  ['embedding', [models, route('POST', '/embeddings')]]
];
export const serviceProfiles = new Map(parts);
export const standardSpeechProfiles = new Set(mediaInterfaces.speech.profiles);
export const standardVideoProfiles = new Set(mediaInterfaces.video.profiles);
export const standardUpstreamModelProfiles = new Set([
  'speech', 'minimax-speech', 'transcription', 'embedding', ...standardVideoProfiles
]);
export const serviceJobId = value => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id) ? id : '';
};

export function validateServiceBaseUrl(profile, baseUrl) {
  if (profile === 'greyscope' && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(baseUrl)) {
    throw new GatewayError('Use the Greyscope loopback HTTP address with an explicit port and /v1.', 400, 'invalid_request', 'baseUrl');
  }
}

export const serviceProvider = {
  discover(connection) {
    return [{ nativeId: connection.service, name: connection.name, capability: 'provider_service',
      service: connection.service, capabilities: { text: false, tools: false, structured: false } }];
  }
};

export function serviceRequest(connection, method, pathname, search, incoming, body, secret) {
  const operations = serviceProfiles.get(connection.service) || [];
  const operation = operations.find(item => item.method === method && item.path.test(pathname));
  if (!operation || pathname.split('/').some(part => part === '.' || part === '..')) {
    throw new GatewayError('This provider operation is unavailable.', 404, 'service_operation_unavailable');
  }
  validateServiceBaseUrl(connection.service, connection.baseUrl);
  const params = new URLSearchParams(search);
  for (const [key, value] of params) {
    if (!operation.query?.includes(key) || params.getAll(key).length !== 1 || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)) {
      throw new GatewayError('Invalid provider query parameter.', 400, 'invalid_request');
    }
  }
  const [, pathId] = operation.path.exec(pathname);
  let ownedId = pathId;
  if (operation.bodyOwner) {
    try { ownedId = serviceJobId(operation.bodyOwner(JSON.parse(body.toString('utf8')))); }
    catch { throw new GatewayError('Invalid provider operation input.', 400, 'invalid_request'); }
  }
  const headers = { ...operation.headers, ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  for (const key of ['accept', 'content-type']) if (typeof incoming[key] === 'string') headers[key] = incoming[key];
  const idempotency = operation.idempotency && serviceJobId(incoming['idempotency-key']);
  if (operation.idempotency && !idempotency) throw new GatewayError('An idempotency key is required.', 400, 'invalid_request');
  if (idempotency) headers['idempotency-key'] = idempotency;
  const base = operation.useOrigin ? new URL(connection.baseUrl).origin : connection.baseUrl;
  if (operation.useOrigin && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(base)) {
    throw new GatewayError('This health check is only available for a local runtime.', 404, 'service_operation_unavailable');
  }
  return { url: `${base}${pathname}${search}`, headers, operation, ownedId, idempotency };
}
