import { developmentCallLimit } from './usage-development.mjs';

function jsonType(type) {
  return /(?:application\/json|\+json)(?:\s*;|$)/i.test(type);
}

export function serviceAuditInput(trace, body, type) {
  if (!body.length) return undefined;
  if (!jsonType(type) || body.length > developmentCallLimit) {
    if (trace.development) trace.development.failure = body.length > developmentCallLimit ? 'payload_too_large' : 'unsupported_payload';
    return undefined;
  }
  try { return JSON.parse(body.toString('utf8')); }
  catch { if (trace.development) trace.development.failure = 'invalid_payload'; return undefined; }
}

const statuses = new Map([
  ['done', 'succeeded'], ['finished', 'succeeded'], ['success', 'succeeded'], ['succeeded', 'succeeded'], ['completed', 'succeeded'],
  ['failed', 'failed'], ['fail', 'failed'], ['error', 'failed'], ['cancelled', 'cancelled'], ['canceled', 'cancelled'],
  ['running', 'running'], ['processing', 'running'], ['queued', 'queued'], ['pending', 'queued'], ['preparing', 'queued']
]);

function inspectServicePayload(trace, payload, streaming, videoPoll) {
  if (!payload || typeof payload !== 'object') return;
  const code = payload.base_resp?.status_code;
  if (Number.isSafeInteger(code) && code !== 0) {
    trace.providerFailed = true;
    trace.metadata.providerErrorCode = code;
  }
  if (payload.error) trace.providerFailed = true;
  const video = trace.metadata.endpoint === 'video';
  const taskId = payload.task_id ?? payload.output?.task_id ?? payload.task?.id ?? (video ? payload.id : null);
  trace.identify(payload.request_id ?? payload.base_resp?.request_id ?? (!video && payload.id), taskId);
  trace.modelName(payload.model ?? payload.task?.model);
  const measured = payload.usage ?? payload.output?.usage ?? payload.data?.usage ?? payload.extra_info;
  if (measured) trace.usage(measured);
  const choice = payload.choices?.[0];
  if (choice?.finish_reason) trace.stopReason(choice.finish_reason);
  if (streaming && choice?.delta) trace.delta(choice.delta);
  if (!streaming) {
    trace.output(payload);
    trace.reasoning(choice?.message?.reasoning_content ?? choice?.message?.reasoning);
    if (trace.metadata.endpoint === 'images') {
      const assets = payload.data?.image_urls || payload.data;
      if (Array.isArray(assets)) trace.measure({ images: assets.length });
    }
    if (video) {
      const taskStatus = statuses.get(String(payload.status ?? payload.task?.status ?? payload.output?.task_status ?? '').toLowerCase());
      if (taskStatus) trace.taskStatus = taskStatus;
      const asset = payload.video_url || payload.file_id || payload.output?.video_url || payload.content?.video_url || payload.task?.result;
      if (taskStatus === 'succeeded' && asset && trace.metadata.providerTaskId) {
        trace.mediaTask = trace.metadata.providerTaskId;
        trace.measure({ videos: 1 });
        const seconds = measured?.duration_seconds ?? payload.duration ?? payload.output?.duration ?? payload.task?.duration;
        if (Number.isFinite(seconds) && seconds >= 0) trace.measure({ mediaSeconds: seconds });
      } else if (videoPoll) {
        // A status lookup without a confirmed result does not measure new video usage.
        delete trace.metrics.videos;
        delete trace.metrics.mediaSeconds;
      }
    }
  }
}

export function observeServiceUsage(response, trace, { method, ownedId }) {
  const type = response.headers.get('content-type') || '';
  const eventStream = /text\/event-stream/i.test(type), json = jsonType(type);
  const videoPoll = method !== 'POST' && trace.metadata.endpoint === 'video';
  if (ownedId) trace.identify(null, ownedId);
  if (!eventStream && !json) return {
    chunk() {},
    end() {
      if (trace.development && response.body) trace.development.failure ||= 'unsupported_payload';
    }
  };
  const decoder = eventStream && new TextDecoder();
  let buffer = '', parts = [], chunks = [], bytes = 0, failed = false;
  function invalid(reason) {
    failed = true;
    chunks = [];
    parts = [];
    buffer = '';
    if (trace.development) trace.development.failure ||= reason;
  }
  function parse(text, streaming) {
    if (!text || text === '[DONE]') return;
    try { inspectServicePayload(trace, JSON.parse(text), streaming, videoPoll); }
    catch { if (trace.development) trace.development.failure ||= 'invalid_payload'; }
  }
  function ingest(text) {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        bytes += Buffer.byteLength(data);
        if (bytes > developmentCallLimit) { invalid('payload_too_large'); return; }
        parts.push(data);
      } else if (!line) {
        parse(parts.join('\n'), true);
        parts = [];
        bytes = 0;
      }
    }
    if (buffer.length > developmentCallLimit) invalid('payload_too_large');
  }
  return {
    chunk(value) {
      if (failed) return;
      if (eventStream) { ingest(decoder.decode(value, { stream: true })); return; }
      bytes += value.byteLength;
      if (bytes > developmentCallLimit) { invalid('payload_too_large'); return; }
      chunks.push(Buffer.from(value));
    },
    end() {
      if (failed) return;
      if (eventStream) ingest(decoder.decode() + '\n\n');
      else parse(Buffer.concat(chunks, bytes).toString('utf8'), false);
    }
  };
}
