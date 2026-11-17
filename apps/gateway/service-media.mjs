import { createHash, randomBytes } from 'node:crypto';
import { decodeImageReferences, exact, GatewayError, normalizeRetryAfter, object, string } from '../../packages/protocol/index.mjs';
import { imageDataByteLength } from '../../packages/protocol/image-data.mjs';
import { maxInferenceRequestBytes } from '../../packages/protocol/image-options.mjs';
import { isMlxKokoro, maxAudioFileBytes, maxStandardTranscriptionBytes, maxStandardVideoBytes, mediaInterfaces, requiredVideoModelProfiles } from '../../packages/protocol/media-options.mjs';
import { fetchUpstream, jsonResponse, protocolError } from '../../packages/providers/http.mjs';
import { serviceJobId, serviceRequest, standardSpeechProfiles, standardVideoProfiles } from '../../packages/providers/services.mjs';
import { videoDownloadUrl, videoServiceInput, videoServicePaths, videoServiceResult } from '../../packages/providers/video-service.mjs';
import { json, write } from './http.mjs';

const MiB = 1024 * 1024;
const postPaths = new Set(Object.values(mediaInterfaces).map(({ path }) => path));
const jsonType = 'application/json';
const empty = Buffer.alloc(0);
const jsonRequest = (pathname, value, headers = {}) => ({ method: 'POST', pathname,
  headers: { 'content-type': jsonType, ...headers }, body: Buffer.from(JSON.stringify(value)) });

export function standardMediaRoute(method, pathname) {
  if (!pathname.startsWith('/v1/')) return;
  const path = pathname.slice(3);
  if (method === 'POST' && postPaths.has(path)) return { method, pathname: path };
  const video = method === 'GET' && /^\/videos\/([^/]+)(\/content)?$/.exec(path);
  if (video) return { method, pathname: path, videoId: video[1], download: Boolean(video[2]) };
}

async function requireSuccess(upstream, notReady = false) {
  if (upstream.ok) return;
  await upstream.body?.cancel();
  if (notReady && upstream.status === 409) throw new GatewayError('The video is not ready to download.', 409, 'video_not_ready');
  const auth = [401, 403].includes(upstream.status);
  const status = !auth && upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
  const code = auth ? 'upstream_auth_failed' : status === 429 ? 'upstream_rate_limited' : 'upstream_rejected';
  throw new GatewayError(`Provider service rejected the request (HTTP ${upstream.status}).`, status, code, null,
    { retryAfter: normalizeRetryAfter(upstream.headers.get('retry-after')) });
}

export async function forwardServiceResponse(response, upstream, signal, observer, extra = {}) {
  const headers = { 'cache-control': 'no-store' };
  for (const key of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(key);
    if (value) headers[key] = value;
  }
  response.writeHead(upstream.status, { ...headers, ...extra });
  if (upstream.body) {
    let transferred = 0;
    for await (const part of upstream.body) {
      transferred += part.length;
      if (transferred > 1024 * MiB) throw new GatewayError('Provider result exceeds the size limit.', 502, 'upstream_protocol_error');
      observer?.chunk(part);
      await write(response, part, signal);
    }
  }
  response.end();
}

function mediaType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

async function requestJson(headers, read, limit = maxInferenceRequestBytes, multiplier = 1) {
  if (mediaType(headers['content-type']) !== jsonType) throw new GatewayError('Use Content-Type: application/json.', 415, 'unsupported_media_type');
  const bytes = await read(limit, multiplier);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new GatewayError('Request body must be valid JSON.'); }
  return object(value);
}

async function requestForm(headers, read, limit) {
  const type = headers['content-type'];
  if (mediaType(type) !== 'multipart/form-data') {
    throw new GatewayError('Use Content-Type: multipart/form-data.', 415, 'unsupported_media_type');
  }
  // The parsed files and re-encoded body may coexist with the original bytes.
  const bytes = await read(limit, 3);
  try { return await new Response(bytes, { headers: { 'content-type': type } }).formData(); }
  catch { throw new GatewayError('Invalid multipart form data.'); }
}

function formValue(form, name) {
  const values = form.getAll(name);
  if (values.length > 1) throw new GatewayError(`Send one ${name} field.`, 400, 'invalid_request', name);
  return values[0];
}

function assertProfile(connection, profile) {
  const supported = typeof profile === 'string' ? connection.service === profile : profile.has(connection.service);
  if (!supported) {
    throw new GatewayError('The selected model does not support this media endpoint.', 400, 'unsupported_model_capability', 'model');
  }
}

async function upstreamModel(connection, secret, signal) {
  if (connection.upstreamModel) return connection.upstreamModel;
  if (connection.service === 'minimax-speech') return 'speech-2.8-hd';
  if (connection.service === 'minimax-video') return 'MiniMax-H3';
  if (!requiredVideoModelProfiles.includes(connection.service)) {
    const call = serviceRequest(connection, 'GET', '/models', '', {}, empty, secret);
    const catalog = await jsonResponse(await fetchUpstream(call.url, { headers: call.headers, signal }), 512 * 1024);
    const ids = Array.isArray(catalog.data) ? [...new Set(catalog.data.map(model => model?.id).filter(id =>
      typeof id === 'string' && id.length <= 300 && id.trim() === id && id && !/[\u0000-\u001f]/u.test(id)))] : [];
    if (ids.length === 1) return ids[0];
  }
  throw new GatewayError('Set the upstream model ID in the service settings.', 400, 'upstream_model_required', 'model');
}

async function serviceJson(upstream, limit) {
  const value = await jsonResponse(upstream, limit);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
  return value;
}

async function observedJson(upstream, observer, limit) {
  const value = await serviceJson(upstream, limit);
  observer.chunk(Buffer.from(JSON.stringify(value)));
  return value;
}

function speechInput(body) {
  exact(body, ['model', 'input', 'voice', 'response_format', 'speed', 'instructions', 'stream_format']);
  if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 4096) {
    throw new GatewayError('input must contain between 1 and 4096 characters.', 400, 'invalid_request', 'input');
  }
  if (typeof body.voice === 'string') string(body.voice, 'voice', 300);
  else {
    exact(body.voice, ['id']);
    string(body.voice.id, 'voice.id', 300);
  }
  if (body.speed !== undefined && (!Number.isFinite(body.speed) || body.speed < 0.25 || body.speed > 4)) {
    throw new GatewayError('speed must be between 0.25 and 4.', 400, 'invalid_request', 'speed');
  }
  if (body.response_format !== undefined && !['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(body.response_format)) {
    throw new GatewayError('Invalid audio response format.', 400, 'invalid_request', 'response_format');
  }
  if (body.stream_format !== undefined && !['audio', 'sse'].includes(body.stream_format)) {
    throw new GatewayError('Use audio or sse for stream_format.', 400, 'invalid_request', 'stream_format');
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    throw new GatewayError('instructions must be a string.', 400, 'invalid_request', 'instructions');
  }
}

const audioTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', pcm: 'application/octet-stream' };

async function speechRequest(connection, secret, signal, body) {
  const profile = connection.service;
  assertProfile(connection, standardSpeechProfiles);
  if (profile === 'speech') {
    const model = await upstreamModel(connection, secret, signal);
    const loopback = new URL(connection.baseUrl).protocol === 'http:';
    const chineseVoice = typeof body.voice === 'string' && /^z[fm]_/.test(body.voice);
    return jsonRequest('/audio/speech', { ...body, model, ...(loopback && isMlxKokoro(model) && chineseVoice && { lang_code: 'z' }) });
  }
  const format = body.response_format ?? 'mp3';
  const speed = body.speed ?? 1;
  const edge = profile === 'edge-tts';
  if (!(edge ? format === 'mp3' : Object.hasOwn(audioTypes, format))) {
    throw new GatewayError('This speech provider does not support the requested audio format.', 400, 'unsupported_parameter', 'response_format');
  }
  if (typeof body.voice !== 'string' || body.instructions !== undefined || ![undefined, 'audio'].includes(body.stream_format)) {
    throw new GatewayError('Use a voice ID and audio output with this speech provider.', 400, 'unsupported_parameter');
  }
  if (speed < 0.5 || speed > 2 || edge && body.input.length > 2000) {
    throw new GatewayError('This speech provider requires speed between 0.5 and 2 and Edge TTS accepts up to 2000 characters.');
  }
  if (edge) return jsonRequest('/audio/speech-with-timestamps', { text: body.input, voice: body.voice, speed });
  return jsonRequest('/v1/t2a_v2', { model: await upstreamModel(connection, secret, signal), text: body.input, stream: false,
    voice_setting: { voice_id: body.voice, speed }, audio_setting: { format }, output_format: 'hex' });
}

async function writeSpeech(response, upstream, signal, observer, connection, body) {
  if (connection.service === 'speech') {
    const type = mediaType(upstream.headers.get('content-type'));
    if (!type.startsWith('audio/') && !['application/octet-stream', 'text/event-stream'].includes(type)) {
      await upstream.body?.cancel(); throw protocolError();
    }
    return forwardServiceResponse(response, upstream, signal, observer);
  }
  const { audio, data, words, ...metadata } = await serviceJson(upstream, 32 * MiB);
  observer.chunk(Buffer.from(JSON.stringify(metadata)));
  const edge = connection.service === 'edge-tts';
  if (metadata.base_resp?.status_code || metadata.error) throw new GatewayError('Speech synthesis failed at the provider.', 502, 'upstream_rejected');
  const encoded = edge ? audio : data?.audio;
  if (typeof encoded !== 'string' || !encoded || (edge ? !imageDataByteLength(encoded) : encoded.length % 2 || /[^A-Fa-f0-9]/.test(encoded))) {
    throw protocolError();
  }
  const output = Buffer.from(encoded, edge ? 'base64' : 'hex');
  response.writeHead(200, { 'content-type': audioTypes[body.response_format ?? 'mp3'], 'cache-control': 'no-store' });
  await write(response, output, signal);
  response.end();
}

async function transcriptionRequest(form, connection, secret, signal) {
  assertProfile(connection, 'transcription');
  form.set('model', await upstreamModel(connection, secret, signal));
  const body = new Response(form);
  return { method: 'POST', pathname: '/audio/transcriptions', headers: { 'content-type': body.headers.get('content-type') },
    body: Buffer.from(await body.arrayBuffer()) };
}

async function readVideo(headers, read) {
  let body;
  if (mediaType(headers['content-type']) === 'multipart/form-data') {
    const form = await requestForm(headers, read, maxStandardVideoBytes);
    const fields = ['model', 'prompt', 'seconds', 'size', 'input_reference', 'input_reference[image_url]'];
    for (const key of form.keys()) if (!fields.includes(key)) throw new GatewayError(`Unsupported field: ${key}`, 400, 'unsupported_parameter', key);
    body = Object.fromEntries(fields.filter(key => form.has(key)).map(key => [key, formValue(form, key)]));
    const [upload, url] = [body.input_reference, body['input_reference[image_url]']];
    if (upload !== undefined && url !== undefined) throw new GatewayError('Send at most one video reference image.');
    if (upload instanceof File) body.input_reference = { image_url: `data:${upload.type};base64,${Buffer.from(await upload.arrayBuffer()).toString('base64')}` };
    else if (url !== undefined || upload !== undefined) body.input_reference = { image_url: url ?? upload };
    delete body['input_reference[image_url]'];
  } else body = await requestJson(headers, read, maxStandardVideoBytes, 2);
  exact(body, ['model', 'prompt', 'seconds', 'size', 'input_reference']);
  const deployment = string(body.model, 'model', 512);
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000) {
    throw new GatewayError('prompt must contain between 1 and 4000 characters.', 400, 'invalid_request', 'prompt');
  }
  const seconds = typeof body.seconds === 'string' && /^\d{1,2}$/.test(body.seconds) ? Number(body.seconds) : body.seconds;
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)) {
    throw new GatewayError('seconds must be an integer between 1 and 30.', 400, 'invalid_request', 'seconds');
  }
  let reference;
  if (body.input_reference !== undefined) {
    exact(body.input_reference, ['image_url']);
    reference = body.input_reference.image_url;
    decodeImageReferences([reference]);
  }
  return { deployment, prompt: body.prompt.trim(), seconds, size: body.size, reference };
}

function videoResponse(job, result, prompt = null) {
  return { id: job.id, object: 'video', model: job.deployment, status: result.status, progress: result.progress,
    created_at: job.createdAt, completed_at: null, expires_at: null, remixed_from_video_id: null, prompt,
    seconds: String(job.seconds), size: job.size,
    error: result.status === 'failed' ? { code: 'video_failed', message: 'The provider could not complete this video.' } : null };
}

async function fetchVideoAsset(service, location, signal) {
  let url = videoDownloadUrl(service, location);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let asset;
    try {
      asset = await fetch(url, { signal, redirect: 'manual', headers: { accept: 'video/mp4, application/octet-stream' } });
    } catch {
      signal.throwIfAborted();
      throw new GatewayError('Could not download the provider video.', 502, 'upstream_unreachable');
    }
    if ([301, 302, 303, 307, 308].includes(asset.status)) {
      await asset.body?.cancel();
      const next = asset.headers.get('location');
      if (!next) throw protocolError();
      try { url = videoDownloadUrl(service, new URL(next, url).href); }
      catch { throw protocolError(); }
      continue;
    }
    await requireSuccess(asset);
    if (!asset.body || !['video/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(mediaType(asset.headers.get('content-type')))) {
      await asset.body?.cancel();
      throw protocolError();
    }
    return asset;
  }
  throw protocolError();
}

async function videoCall({ route, gateway, response, principal, context, headers, read }) {
  if (route.videoId) {
    const job = await gateway.serviceOwnership.video(principal, route.videoId);
    const prepare = connection => {
      if (JSON.stringify([connection.id, connection.baseUrl, connection.credentialId, connection.service]) !== JSON.stringify(job.source)) {
        throw new GatewayError('The video deployment changed.', 409, 'video_deployment_changed');
      }
      const paths = videoServicePaths[connection.service];
      const pathname = (route.download && paths.content ? paths.content : paths.status)(job.taskId);
      return { method: 'GET', pathname, headers: {}, body: empty };
    };
    await gateway.callService(job.deployment, { ...route, prepare }, principal, context, async (upstream, signal, observer, connection) => {
      await requireSuccess(upstream, route.download);
      if (route.download && connection.service === 'local-ltx') {
        if (mediaType(upstream.headers.get('content-type')) !== 'video/mp4') { await upstream.body?.cancel(); throw protocolError(); }
        return forwardServiceResponse(response, upstream, signal, observer, { 'content-disposition': `attachment; filename="${job.id}.mp4"` });
      }
      const result = videoServiceResult(connection.service, await observedJson(upstream, observer, 512 * 1024), { taskId: job.taskId });
      if (!route.download) { json(response, 200, videoResponse(job, result)); return; }
      if (result.status !== 'completed') throw new GatewayError('The video is not ready to download.', 409, 'video_not_ready');
      if (mediaType(headers.accept) === 'video/mp4') {
        const asset = await fetchVideoAsset(connection.service, result.url, signal);
        return forwardServiceResponse(response, asset, signal, undefined, {
          'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${job.id}.mp4"`, vary: 'Accept'
        });
      }
      response.writeHead(303, { location: videoDownloadUrl(connection.service, result.url), 'cache-control': 'no-store', vary: 'Accept' });
      response.end();
    });
    return;
  }
  const input = await readVideo(headers, read);
  let video;
  const prepare = async (connection, secret, signal) => {
    assertProfile(connection, standardVideoProfiles);
    const providerHeaders = {};
    const key = headers['idempotency-key'];
    if (connection.service === 'local-ltx') {
      if (key !== undefined && !serviceJobId(key)) throw new GatewayError('Invalid idempotency key.');
      providerHeaders['idempotency-key'] = key === undefined ? randomBytes(32).toString('hex')
        : createHash('sha256').update(JSON.stringify(['video', principal.id, input.deployment, key])).digest('hex');
    } else if (key !== undefined) throw new GatewayError('Idempotency-Key is supported for local LTX.', 400, 'unsupported_parameter', 'Idempotency-Key');
    video = videoServiceInput(connection.service, await upstreamModel(connection, secret, signal), input);
    return jsonRequest(videoServicePaths[connection.service].create, video.input, providerHeaders);
  };
  await gateway.callService(input.deployment, { ...route, prepare }, principal, context, async (upstream, _signal, observer, connection) => {
    await requireSuccess(upstream);
    const result = videoServiceResult(connection.service, await observedJson(upstream, observer, 512 * 1024), { created: true });
    const job = await gateway.serviceOwnership.saveVideo(principal, connection, input.deployment, result.taskId, video);
    response.setHeader('location', `/v1/videos/${job.id}`);
    json(response, 200, videoResponse(job, result, input.prompt));
  });
}

export async function serveStandardMedia({ route, gateway, response, principal, context, headers, read, query }) {
  const variants = query.getAll('variant');
  if (query.size && (!route.download || query.size !== 1 || variants[0] !== 'video')) {
    throw new GatewayError('Only variant=video is supported for video downloads.', 400, 'unsupported_parameter', 'variant');
  }
  if (route.videoId || route.pathname === '/videos') return videoCall({ route, gateway, response, principal, context, headers, read });

  const { pathname } = route;
  let deployment, prepare, body;
  if (pathname === '/audio/transcriptions') {
    const form = await requestForm(headers, read, maxStandardTranscriptionBytes);
    deployment = string(formValue(form, 'model'), 'model', 512);
    const file = formValue(form, 'file');
    if (!(file instanceof File) || !file.size) throw new GatewayError('Attach a non-empty audio file.', 400, 'invalid_request', 'file');
    if (file.size > maxAudioFileBytes) throw new GatewayError('Audio files must not exceed 25 MiB.', 413, 'request_too_large', 'file');
    prepare = (connection, secret, signal) => transcriptionRequest(form, connection, secret, signal);
  } else {
    body = await requestJson(headers, read);
    deployment = string(body.model, 'model', 512);
    if (pathname === '/audio/speech') {
      speechInput(body);
      prepare = (connection, secret, signal) => speechRequest(connection, secret, signal, body);
    } else {
      exact(body, ['model', 'input', 'encoding_format', 'dimensions', 'user']);
      if (!(typeof body.input === 'string' && body.input.trim() || Array.isArray(body.input) && body.input.length)) {
        throw new GatewayError('Send text or a non-empty array to embed.', 400, 'invalid_request', 'input');
      }
      if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) {
        throw new GatewayError('Use float or base64 for encoding_format.', 400, 'invalid_request', 'encoding_format');
      }
      if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || body.dimensions < 1)) {
        throw new GatewayError('dimensions must be a positive integer.', 400, 'invalid_request', 'dimensions');
      }
      prepare = async (connection, secret, signal) => {
        assertProfile(connection, 'embedding');
        return jsonRequest(pathname, { ...body, model: await upstreamModel(connection, secret, signal) });
      };
    }
  }
  return gateway.callService(deployment, { ...route, prepare }, principal, context, async (upstream, signal, observer, connection) => {
    await requireSuccess(upstream);
    if (pathname === '/audio/speech') return writeSpeech(response, upstream, signal, observer, connection, body);
    return forwardServiceResponse(response, upstream, signal, observer);
  });
}
