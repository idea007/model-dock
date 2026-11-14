import { messages } from './messages.mjs';

const languageKey = 'model-dock-language';
const defaultLanguage = 'zh-CN';
const languages = ['zh-CN', 'en'];
let currentLanguage = defaultLanguage;

export const language = () => currentLanguage;
export const languageSeparator = () => currentLanguage === 'en' ? ', ' : '、';

function applyLanguage(next, titleKey) {
  currentLanguage = languages.includes(next) ? next : defaultLanguage;
  document.documentElement.lang = currentLanguage;
  document.title = t(titleKey);
  document.querySelector('meta[name="description"]')?.setAttribute('content', t(titleKey + 'Description'));
}

export function initLanguage(titleKey) {
  let saved;
  try { saved = window.localStorage.getItem(languageKey); } catch {}
  applyLanguage(saved, titleKey);
}

export function selectLanguage(next, titleKey) {
  applyLanguage(next, titleKey);
  try { window.localStorage.setItem(languageKey, currentLanguage); } catch {}
}

export function t(key, ...args) {
  const variants = Object.hasOwn(messages, key) ? messages[key] : undefined;
  const message = variants?.[currentLanguage === 'en' ? 1 : 0] ?? String(key ?? '');
  return message.replace(/\{(\d+)\}/g, (placeholder, index) => args[index] ?? placeholder);
}

export function languagePicker() {
  return `<div class="language-picker" role="group" aria-label="${t('common.language')}">
    <button type="button" data-language="zh-CN" lang="zh-CN" aria-pressed="${currentLanguage === 'zh-CN'}">简体中文</button>
    <button type="button" data-language="en" lang="en" aria-pressed="${currentLanguage === 'en'}">English</button>
  </div>`;
}

export const dateTime = value => new Date(value).toLocaleString(currentLanguage, { hour12: false });
export const number = (value, options) => value.toLocaleString(currentLanguage, options);
export const duration = seconds => t('common.seconds', number(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

export function requestMetadata({ seconds, usage, image }) {
  const elapsed = duration(seconds);
  if (image) return `${number(image.width)} × ${number(image.height)} · ${image.format} · ${elapsed}`;
  return `${elapsed} · ${usage ? t('common.usage', number(usage.prompt_tokens), number(usage.completion_tokens)) : t('common.usageUnreported')}`;
}

const translatedErrors = new Map([
  ['Failed to fetch', 'errors.network'],
  ['NetworkError when attempting to fetch resource.', 'errors.network'],
  ['Load failed', 'errors.network'],
  ['The request could not be completed.', 'common.requestFailed'],
  ['A valid access token is required.', 'errors.accessToken'],
  ['Endpoint not found.', 'errors.endpointMissing'],
  ['Settings changed. Refresh and try again.', 'errors.revisionConflict'],
  ['Settings changed. Refresh first.', 'errors.revisionConflict'],
  ['Choose at least one allowed model or function.', 'errors.chooseModels'],
  ['Use Content-Type: application/json.', 'errors.contentType'],
  ['Use application/json.', 'errors.contentType'],
  ['Invalid JSON.', 'errors.invalidJson'],
  ['Request body must be valid JSON.', 'errors.invalidJson'],
  ['This key cannot use the selected model.', 'errors.forbiddenModel'],
  ['The selected model is disabled or unavailable. Choose it explicitly in model management.', 'errors.unavailableModel'],
  ['This connection is at capacity. Retry after the active request finishes.', 'errors.connectionBusy'],
  ['Access key revoked.', 'errors.revoked'],
  ['Request timed out.', 'errors.timeout'],
  ['Request cancelled.', 'errors.cancelled'],
  ['Model discovery is already running.', 'errors.discovering'],
  ['Model discovery timed out or failed.', 'errors.discoveryFailed'],
  ['This model already exists.', 'errors.duplicateModel'],
  ['Invalid concurrency limit. Codex permits one active request.', 'errors.concurrencyLimit'],
  ['Invalid provider base URL.', 'errors.providerUrl'],
  ['Use HTTPS, or HTTP on loopback. Credentials belong in the API key field.', 'errors.providerHttps'],
  ['Invalid API key.', 'errors.providerKey']
]);

const translatedErrorCodes = new Map([
  ['upstream_auth_failed', 'console.checkKeyAndAccess'],
  ['upstream_unreachable', 'console.checkServiceAddress'],
  ['upstream_rate_limited', 'console.upstreamRateLimited'],
  ['upstream_protocol_error', 'console.upstreamUnreadable'],
  ['codex_auth_required', 'console.signInCodex'],
  ['codex_unavailable', 'console.checkCodexInstall'],
  ['codex_timeout', 'console.codexDidNotRespond'],
  ['codex_connection_failed', 'console.codexConnectionFailed'],
  ['codex_rate_limited', 'console.codexQuotaExhausted'],
  ['codex_failed', 'errors.codexFailed'],
  ['codex_image_unavailable', 'errors.imageUnavailable'],
  ['reasoning_effort_disabled', 'errors.reasoningLevelDisabled']
]);

export class LocalizedError extends Error {
  constructor(key, ...values) {
    super(t(key, ...values));
    this.translation = [key, ...values];
  }
}

// Localize app-owned errors at the UI boundary without changing API responses.
export function errorText(error, fallback = 'common.requestFailed') {
  if (error instanceof LocalizedError) return t(...error.translation);
  const message = typeof error === 'string' ? error : error?.message;
  if (!message) return t(fallback);
  if (currentLanguage === 'en') {
    const status = message.match(/^无法读取授权目录（HTTP (\d+)），请检查项目密钥和模型权限。$/)?.[1];
    if (status) return t('errors.catalogStatus', status);
    const gatewayStatus = message.match(/^网关请求失败（(\d+)）。$/)?.[1];
    return gatewayStatus ? t('errors.gatewayStatus', gatewayStatus) : englishErrors.get(message) || message;
  }
  const key = translatedErrors.get(message) || translatedErrorCodes.get(error?.code);
  return key ? t(key) : message;
}

const englishErrors = new Map(Object.entries(messages)
  .filter(([key]) => key.startsWith('errors.'))
  .map(([, [zh, en]]) => [zh, en]));
