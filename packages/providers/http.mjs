import { GatewayError, normalizeRetryAfter } from '../protocol/index.mjs';

export async function fetchUpstream(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        throw new GatewayError('Upstream rejected the request (HTTP 429).', 429, 'upstream_rate_limited', null,
          { retryAfter: normalizeRetryAfter(response.headers.get('retry-after')) });
      }
      const authFailed = response.status === 401 || response.status === 403;
      throw new GatewayError(`Upstream rejected the request (HTTP ${response.status}).`, authFailed || response.status >= 500 ? 502 : 400,
        authFailed ? 'upstream_auth_failed' : 'upstream_rejected');
    }
    return response;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (options.signal?.aborted) throw options.signal.reason;
    throw new GatewayError('Cannot connect to this provider. Check its address and service status.', 502, 'upstream_unreachable');
  }
}
export async function jsonResponse(response, maximum = 4 * 1024 * 1024) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel(); throw new GatewayError('Upstream did not return JSON.', 502, 'upstream_protocol_error');
  }
  let length = 0; const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new GatewayError('Upstream response exceeds the size limit.', 502, 'upstream_protocol_error');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError('Upstream returned invalid JSON.', 502, 'upstream_protocol_error'); }
}
export function usage(value) {
  if (!value || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) || value.total_tokens < value.prompt_tokens + value.completion_tokens) return null;
  return { prompt_tokens: value.prompt_tokens, completion_tokens: value.completion_tokens, total_tokens: value.total_tokens };
}
export function protocolError() { return new GatewayError('Upstream returned an incomplete or invalid response.', 502, 'upstream_protocol_error'); }
export function headers(key) { return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }; }
