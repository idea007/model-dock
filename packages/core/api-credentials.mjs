import { GatewayError } from '../protocol/index.mjs';

export const isApiConnection = connection => ['openai', 'service', 'mflux'].includes(connection.type);

const providerNames = new Map([
  ['deepseek', 'DeepSeek'], ['deepseek-search', 'DeepSeek'],
  ['minimax-chat', 'MiniMax'], ['minimax-image', 'MiniMax'], ['minimax-video', 'MiniMax'], ['minimax-speech', 'MiniMax'],
  ['seedream', '火山方舟'], ['seedance', '火山方舟'], ['wan', '阿里云百炼']
]);

export function apiCredentialName(connections) {
  const providers = new Set(connections.map(connection => providerNames.get(connection.service)).filter(Boolean));
  if (providers.size === 1) return providers.values().next().value;
  const [first] = connections;
  return connections.length === 1 ? first.name : new URL(first.baseUrl).host;
}

export function providerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new GatewayError('Invalid provider base URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && local)) {
    throw new GatewayError('Use HTTPS, or HTTP on loopback. Credentials belong in the API key field.');
  }
  return url;
}

export function validateApiKey(value) {
  if (typeof value !== 'string' || value.length > 16000 || /[\r\n]/.test(value)) {
    throw new GatewayError('Invalid API key.', 400, 'invalid_request', 'apiKey');
  }
}

export function validateMfluxToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new GatewayError('Enter the MFLUX service token.', 400, 'invalid_request', 'apiKey');
  }
}
