import { safeAuditId } from './usage-development.mjs';

const serviceModels = new Map([
  ['deepseek', ['text', ['deepseek-flash', 'deepseek-v4-pro']]],
  ['minimax-chat', ['text', ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed']]],
  ['minimax-image', ['image_generation', ['image-01', 'image-01-live']]],
  ['seedream', ['image_generation', ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128']]],
  ['seedance', ['video_generation', ['Doubao-Seedance-1.5-pro', 'doubao-seedance-1-5-pro-251215', 'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615']]],
  ['minimax-video', ['video_generation', ['MiniMax-H3']]],
  ['wan', ['video_generation', ['wan2.6-i2v-flash']]],
  ['local-ltx', ['video_generation', ['ltx-2.5-fast-q4', 'ltx-2.3-q4']]],
  ['minimax-speech', ['speech', ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd']]],
  ['edge-tts', ['speech', ['edge-tts']]],
  ['greyscope', ['text_detection', ['greyscope-v2-mlx-q4']]],
  ['speech', ['speech', []]],
  ['transcription', ['transcription', []]],
  ['embedding', ['embeddings', []]]
]);

export function validServiceModelId(value) {
  return typeof value === 'string' && value.length <= 200 && value.split('/').every(part => safeAuditId(part));
}

function serviceModelMetadata(service, nativeId, task) {
  const deepseek = service === 'deepseek' && /^deepseek-(?:v4-|flash$)/.test(nativeId);
  const minimax = service === 'minimax-chat' && nativeId.startsWith('MiniMax-M3');
  const imageInput = minimax || service === 'deepseek' && nativeId === 'deepseek-flash';
  const levels = deepseek ? ['none', 'low', 'high', 'max'] : minimax ? ['none', 'medium'] : [];
  return { task, name: nativeId, capabilities: { [task]: true, ...(task === 'text' && {
    image_input: imageInput, video_input: minimax, web_search: deepseek, thinking: levels.length > 0
  }) }, reasoning_efforts: levels, default_reasoning_effort: deepseek ? 'high' : minimax ? 'medium' : null,
  context_window: deepseek ? 1_000_000 : null };
}

export function projectCatalog(published, state) {
  const models = new Map(state.models.map(model => [model.id, model]));
  const connections = new Map(state.connections.map(connection => [connection.id, connection]));
  const credentials = new Map(state.apiCredentials.map(credential => [credential.id, credential.name]));
  return published.flatMap(item => {
    const model = models.get(item.id);
    const connection = connections.get(model?.connectionId);
    if (!connection) return [];
    const credentialId = connection.credentialId || connection.id;
    const base = {
      deployment_id: item.id, source: item.source,
      credential: { id: credentialId, name: credentials.get(credentialId) || connection.name },
      health: { status: connection.status, checked_at: connection.checkedAt }
    };
    if (connection.type !== 'service') {
      const task = model.capability === 'image_generation' ? 'image_generation' : 'text';
      return [{ ...base, task, native_model: model.nativeId, name: item.name, capabilities: item.capabilities,
        context_window: item.context_window, reasoning_efforts: item.reasoning_efforts,
        default_reasoning_effort: item.default_reasoning_effort,
        ...(item.image_operations && { image_operations: true }),
        ...(item.image_sizes && { image_sizes: item.image_sizes, max_reference_images: item.max_reference_images,
          model_revision: item.model_revision }) }];
    }
    const profile = serviceModels.get(connection.service);
    if (!profile) return [];
    const [task, defaults] = profile;
    const ids = connection.serviceModels || (connection.upstreamModel ? [connection.upstreamModel] : defaults);
    return ids.filter(validServiceModelId).map(nativeId => ({ ...base, service: connection.service,
      native_model: nativeId, ...serviceModelMetadata(connection.service, nativeId, task) }));
  });
}
