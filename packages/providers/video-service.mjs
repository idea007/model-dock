import { GatewayError } from '../protocol/index.mjs';
import { cloudVideoSizes, localVideoSizes } from '../protocol/media-options.mjs';
import { protocolError } from './http.mjs';
import { serviceJobId } from './services.mjs';

export const videoServicePaths = {
  'local-ltx': { create: '/video/generations', status: id => `/video/generations/${id}`, content: id => `/video/generations/${id}/content` },
  seedance: { create: '/contents/generations/tasks', status: id => `/contents/generations/tasks/${id}` },
  'minimax-video': { create: '/v2/video_generation', status: id => `/v2/query/video_generation/${id}` },
  wan: { create: '/services/aigc/video-generation/video-synthesis', status: id => `/tasks/${id}` }
};

export function videoServiceInput(service, upstreamModel, { prompt, reference, seconds = 4, size }) {
  const local = service === 'local-ltx';
  size ??= local ? '768x448' : '1280x720';
  if (!(local ? localVideoSizes : cloudVideoSizes).includes(size)) {
    throw new GatewayError('The selected video service does not support this size.', 400, 'unsupported_parameter', 'size');
  }
  const [width, height] = size.split('x').map(Number);
  if (local) {
    if (seconds !== 4) throw new GatewayError('LTX supports four-second clips.', 400, 'unsupported_parameter', 'seconds');
    return { size, seconds, input: { model: upstreamModel, prompt, width, height, fps: 24, num_frames: 97,
      reference_images: reference ? [reference] : [], seed: 42 } };
  }
  const ratio = width > height ? '16:9' : '9:16';
  const resolution = Math.min(width, height) <= 720 ? '720p' : '1080p';
  if (service === 'wan') {
    // The I2V protocol uses a tier. Earlier text-to-video models use WIDTH*HEIGHT.
    const dimensions = /^wan(?:2\.[789]|3\.)/.test(upstreamModel) ? { resolution: resolution.toUpperCase(), ratio }
      : { size: `${width}*${height}` };
    return { size, seconds, input: { model: upstreamModel, input: { prompt, ...(reference && { img_url: reference }) },
      parameters: { ...(reference ? { resolution: resolution.toUpperCase(), audio: false } : dimensions), duration: seconds } } };
  }
  const minimax = service === 'minimax-video';
  const content = [{ type: 'text', text: prompt }];
  if (reference) content.push({ type: 'image_url', image_url: { url: reference }, role: 'first_frame' });
  return { size, seconds, input: { model: upstreamModel, content, duration: seconds,
    ratio: reference && minimax ? 'adaptive' : ratio,
    resolution: minimax ? (resolution === '720p' ? '768P' : '2K') : resolution } };
}

const videoStatuses = new Map([
  ['queued', 'queued'], ['queueing', 'queued'], ['pending', 'queued'], ['preparing', 'queued'],
  ['running', 'in_progress'], ['processing', 'in_progress'], ['in_progress', 'in_progress'],
  ['succeeded', 'completed'], ['success', 'completed'], ['completed', 'completed'],
  ['failed', 'failed'], ['fail', 'failed'], ['error', 'failed'], ['cancelled', 'failed'], ['canceled', 'failed'],
  ['expired', 'failed'], ['unknown', 'failed']
]);

export function videoServiceResult(service, payload, { created = false, taskId } = {}) {
  if (payload.base_resp?.status_code || (!payload.status && !payload.task?.status && !payload.output?.task_status && payload.error)) {
    throw new GatewayError('The provider rejected this video request.', 502, 'upstream_rejected');
  }
  const task = service === 'wan' ? payload.output : service === 'minimax-video' ? payload.task || payload : payload;
  const upstreamId = serviceJobId(task?.id ?? task?.task_id ?? payload.task_id);
  if (created && !upstreamId || taskId && upstreamId && upstreamId !== taskId) throw protocolError();
  const providerStatus = task?.status ?? task?.task_status;
  const status = providerStatus === undefined && created ? 'queued' : videoStatuses.get(String(providerStatus).toLowerCase());
  if (!status) throw protocolError();
  const progress = Number(task?.progress);
  return { taskId: upstreamId, status, progress: status === 'completed' ? 100 : Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.round(progress))) : 0,
    url: task?.video_url ?? task?.content?.video_url ?? task?.content?.url };
}

const resultHosts = {
  seedance: ['volces.com', 'bytepluses.com'],
  'minimax-video': ['algeng-video-infer.oss-cn-shanghai.aliyuncs.com', 'minimax.chat', 'minimaxi.com', 'minimax.io', 'minimax.cn', 'hailuoai.com'],
  wan: ['aliyuncs.com']
};

export function videoDownloadUrl(service, value) {
  let url;
  try { url = new URL(value); } catch { throw protocolError(); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !resultHosts[service]?.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw protocolError();
  return url.href;
}
