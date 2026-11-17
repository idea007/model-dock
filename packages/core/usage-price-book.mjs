// Reviewed price snapshots. Stored calls and ledger entries retain their own version.
export const AI_USAGE_PRICE_BOOK = Object.freeze({
  basis: 'versioned_public_list_price', rateAsOf: '2026-10-23', version: '2026-10-23-public-v3'
})
const SOURCES = {
  deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  minimax: 'https://platform.minimax.cn/docs/pricing/overview'
}
// State Council 2026 schedule. Weekends remain idle even on makeup workdays.
// https://www.gov.cn/zhengce/content/202511/content_7047090.htm
const HOLIDAYS_2026 = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']
]
function deepSeekPriceBand(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'unknown'
  const local = new Date(Number(timestamp) + 8 * 3600_000)
  const date = local.toISOString().slice(5, 10)
  const weekday = local.getUTCDay()
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (weekday === 0 || weekday === 6 || !((minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080))) return 'idle'
  if (local.getUTCFullYear() !== 2026) return 'unknown'
  return HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end) ? 'idle' : 'peak'
}
export function findAiUsageRate(provider, model, capability, context = {}) {
  provider = key(provider)
  model = normalizeModelAlias(provider, model)
  const expectedCapability = model.startsWith('speech-') ? 'video_tts'
    : model.startsWith('image-') ? 'image_generation'
      : model === 'minimax-h3' ? 'video_generation' : 'content_ai'
  if (capability && capability !== expectedCapability) return null
  const timestamp = Number(context.started_at ?? context.created_at ?? context.startedAt)
  // No reviewed directory predates the first provider-call snapshot. Historical
  // receipts remain readable; unpriced older records require a verified receipt.
  if (timestamp > 0 && timestamp < Date.parse('2026-08-20T00:00:00+08:00')) return null
  const metadata = context.requestMetadata || {}
  const base = { currency: 'CNY', source: SOURCES[provider],
    version: AI_USAGE_PRICE_BOOK.version, rateAsOf: AI_USAGE_PRICE_BOOK.rateAsOf, model,
    effectiveFrom: '2026-08-20T00:00:00+08:00', effectiveTo: null }
  if (provider === 'deepseek' && ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(model)) {
    const historical = timestamp > 0 && timestamp < Date.parse('2026-10-17T00:00:00+08:00')
    const idle = model === 'deepseek-v4-pro' ? { cacheRead: 0.15, input: 4.5, output: 13.5 }
      : historical ? { cacheRead: 0.05, input: 1.5, output: 4.5 } : { cacheRead: 0.02, input: 1, output: 4 }
    const priceBand = deepSeekPriceBand(timestamp)
    const multiplier = priceBand === 'peak' ? 2 : 1
    return { ...base, ...tokenRate(idle.cacheRead * multiplier, idle.input * multiplier, idle.output * multiplier),
      ...(historical ? { version: '2026-08-20-provider-call-v1', rateAsOf: '2026-08-20' } : {}),
      effectiveFrom: historical ? '2026-08-20T00:00:00+08:00' : '2026-10-17T00:00:00+08:00',
      effectiveTo: historical ? '2026-10-17T00:00:00+08:00' : null,
      priceBand, timezone: 'Asia/Shanghai', contextComplete: priceBand !== 'unknown',
      maximumTimeMultiplier: priceBand === 'unknown' ? 2 : 1 }
  }
  if (provider !== 'minimax') return null
  if (model === 'minimax-m3.1-flash') {
    if (timestamp > 0 && timestamp < Date.parse('2026-10-23T00:00:00+08:00')) return null
    return { ...base, ...tokenRate(0.1, 1, 4), effectiveFrom: '2026-10-23T00:00:00+08:00' }
  }
  if (model === 'minimax-m3') {
    const long = Number(context.input_tokens || 0) > 512_000
    const multiplier = key(context.service_tier || context.serviceTier) === 'priority' ? 1.5 : 1
    const factor = (long ? 2 : 1) * multiplier
    return { ...base, ...tokenRate(0.42 * factor, 2.1 * factor, 8.4 * factor), multiplier,
      contextBand: long ? '>512k' : '<=512k', serviceTier: multiplier > 1 ? 'priority' : 'standard' }
  }
  if (['minimax-m2.7', 'minimax-m2.7-highspeed'].includes(model)) {
    const high = model.endsWith('-highspeed')
    return { ...base, ...tokenRate(0.42, high ? 4.2 : 2.1, high ? 16.8 : 8.4, 2.625),
      serviceTier: high ? 'highspeed' : 'standard' }
  }
  if (['image-01', 'image-01-live'].includes(model)) return { ...base, kind: /** @type {const} */ ('generated_count'), amountPerUnit: 0.025 }
  if (/^speech-(2[.]8|2[.]6|02)-(hd|turbo)$/.test(model)) return {
    ...base, kind: /** @type {const} */ ('characters'), amountPerTenThousand: model.endsWith('hd') ? 3.5 : 2,
    voiceActivationPerUnit: 9.9
  }
  if (model === 'minimax-h3') {
    const resolution = String(metadata.resolution || context.resolution || '').toUpperCase()
    if (!['2K', '768P', '720P'].includes(resolution)) return null
    return { ...base, kind: /** @type {const} */ ('seconds'), amountPerSecond: resolution === '2K' ? 0.8 : 0.5,
      inputVideoPerSecond: resolution === '2K' ? 0.8 : 0.5, freeInputImages: 5, inputImagePerUnit: 0.2, resolution }
  }
  return null
}
function tokenRate(cacheRead, input, output, cacheWrite = 0) {
  return { kind: /** @type {const} */ ('tokens'), cacheReadPerMillion: cacheRead, cacheWritePerMillion: cacheWrite,
    inputPerMillion: input, outputPerMillion: output }
}
function normalizeModelAlias(provider, value) {
  const model = key(value)
  if (provider === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return 'deepseek-v4-flash'
  return model
}
function key(value) { return String(value || '').trim().toLowerCase() }
export function getAiUsagePriceCatalog() {
  // This endpoint reads a reviewed release snapshot; it never probes Providers.
  const models = [
    ['deepseek', 'deepseek-flash', 'content_ai'], ['deepseek', 'deepseek-v4-pro', 'content_ai'],
    ['minimax', 'MiniMax-M3', 'content_ai'], ['minimax', 'MiniMax-M3.1-Flash', 'content_ai'],
    ['minimax', 'MiniMax-M2.7', 'content_ai'], ['minimax', 'MiniMax-M2.7-highspeed', 'content_ai'],
    ['minimax', 'speech-2.8-hd', 'video_tts'], ['minimax', 'speech-2.8-turbo', 'video_tts'],
    ['minimax', 'speech-2.6-hd', 'video_tts'], ['minimax', 'speech-2.6-turbo', 'video_tts'],
    ['minimax', 'speech-02-hd', 'video_tts'], ['minimax', 'speech-02-turbo', 'video_tts'],
    ['minimax', 'image-01', 'image_generation'], ['minimax', 'image-01-live', 'image_generation'],
    ['minimax', 'MiniMax-H3', 'video_generation']
  ]
  return { ...AI_USAGE_PRICE_BOOK, updatePolicy: 'reviewed_release', models: models.map(([provider, model, capability]) => ({
    provider, model, capability,
    rates: (provider === 'deepseek' ? [
      { startedAt: Date.parse('2026-10-23T08:00:00+08:00') }, { startedAt: Date.parse('2026-10-23T10:00:00+08:00') }
    ] : model === 'MiniMax-H3' ? [{ resolution: '768P' }, { resolution: '2K' }]
      : model === 'MiniMax-M3' ? [{ input_tokens: 1 }, { input_tokens: 512001 }, { input_tokens: 1, serviceTier: 'priority' }, { input_tokens: 512001, serviceTier: 'priority' }] : [{}])
      .map(context => findAiUsageRate(provider, model, capability, context))
  })), additionalItems: [
    { provider: 'deepseek', item: 'Search / Fetch（独立 API）', amountPerUnit: 0.005, unit: '成功请求', currency: 'CNY', source: SOURCES.deepseek },
    { provider: 'deepseek', item: 'Search / Fetch（服务端工具）', amountPerUnit: 0.005, unit: '成功请求', currency: 'CNY', effectiveFrom: '2026-11-01T00:00:00+08:00', source: SOURCES.deepseek },
    { provider: 'minimax', item: 'web_search', amountPerUnit: 0.03, unit: '次', currency: 'CNY', source: SOURCES.minimax }
  ] }
}
