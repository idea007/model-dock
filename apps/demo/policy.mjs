import { GatewayError, exact, object, string, slug } from '../../packages/protocol/index.mjs';
import { FEATURE_KINDS } from './features.mjs';
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : null;
const invalid = message => { throw new GatewayError(message, 400, 'invalid_client_settings'); };
export function compatible(feature, model) { return model.capabilities?.text !== false && (!FEATURE_KINDS[feature.kind]?.structured || model.capabilities?.structured !== false); }
export function reasoning(policy, available) {
  if (policy == null) return null;
  exact(policy, ['allowedEfforts', 'defaultEffort']);
  if (!Array.isArray(policy.allowedEfforts) || !policy.allowedEfforts.length || new Set(policy.allowedEfforts).size !== policy.allowedEfforts.length || policy.allowedEfforts.some(level => !available.includes(level)) || !policy.allowedEfforts.includes(policy.defaultEffort)) invalid('请选择模型实际开放的思考等级，并从中指定默认值。');
  return { allowedEfforts: [...policy.allowedEfforts], defaultEffort: policy.defaultEffort };
}
export function validateSettings(state, input) {
  exact(input, ['revision', 'models', 'routes']);
  if (!Array.isArray(input.models) || input.models.length !== state.models.length || !Array.isArray(input.routes) || input.routes.length > 100) invalid('请提交完整的应用模型与功能设置。');
  const seen = new Set();
  const models = input.models.map(row => {
    exact(row, ['id', 'enabled', 'reasoningPolicy', 'groupPolicies']);
    const previous = state.models.find(model => model.id === row.id), catalog = state.catalog.find(model => model.id === row.id);
    if (!previous || seen.has(row.id) || typeof row.enabled !== 'boolean') invalid('无效或重复的应用模型。');
    seen.add(row.id);
    if ((!catalog?.available || state.catalogError) && row.enabled && !previous.enabled) invalid('此模型未在当前项目的授权目录中，无法启用。');
    const levels = catalog?.reasoningEfforts || [];
    const next = { id: row.id, enabled: row.enabled, reasoningPolicy: reasoning(row.reasoningPolicy, levels), groupPolicies: {} };
    object(row.groupPolicies ?? {}, 'group policies');
    next.groupPolicies = Object.fromEntries(Object.entries(row.groupPolicies || {}).map(([key, value]) => [string(key, 'group', 80), reasoning(value, next.reasoningPolicy?.allowedEfforts || levels)]));
    return next;
  });
  const ids = new Set();
  const routes = input.routes.map(row => {
    exact(row, ['id', 'name', 'kind', 'group', 'selection', 'modelId', 'allowedModelIds', 'reasoningOverrides']);
    const id = slug(row.id); if (ids.has(id)) invalid('功能 ID 重复。'); ids.add(id);
    if (!Object.hasOwn(FEATURE_KINDS, row.kind) || !['single', 'multiple'].includes(row.selection) || typeof row.modelId !== 'string') invalid('无效的功能类型或模型选择方式。');
    if (!Array.isArray(row.allowedModelIds) || new Set(row.allowedModelIds).size !== row.allowedModelIds.length || row.allowedModelIds.some(id => !models.some(model => model.id === id)) || row.selection === 'single' && row.allowedModelIds.length > 1) invalid('无效的功能候选模型。');
    const previous = state.routes.find(feature => feature.id === id);
    for (const modelId of row.allowedModelIds) {
      const catalog = state.catalog.find(model => model.id === modelId);
      if ((!catalog?.available || !compatible(row, catalog)) && !(previous?.kind === row.kind && previous.allowedModelIds.includes(modelId))) invalid('此模型尚未获授权或不支持该功能。');
    }
    if (row.modelId && !models.some(model => model.id === row.modelId)) invalid('默认模型不存在。');
    const group = row.group ? string(row.group, 'group', 80) : '';
    object(row.reasoningOverrides ?? {}, 'reasoning overrides');
    const overrides = Object.entries(row.reasoningOverrides || {}).map(([id, policy]) => {
      const model = models.find(model => model.id === id), catalog = state.catalog.find(model => model.id === id);
      if (!model) invalid('思考设置引用了未知模型。');
      return [id, reasoning(policy, own(model.groupPolicies, group)?.allowedEfforts || model.reasoningPolicy?.allowedEfforts || catalog.reasoningEfforts || [])];
    });
    return { id, name: string(row.name, 'feature name', 100), kind: row.kind, group, selection: row.selection, modelId: row.modelId, allowedModelIds: [...row.allowedModelIds], reasoningOverrides: Object.fromEntries(overrides) };
  });
  state.models = models; state.routes = routes;
}
export function buildRequest(state, input) {
  exact(input, ['featureId', 'modelId', 'prompt', 'stream', 'reasoningEffort']);
  const feature = state.routes.find(feature => feature.id === input.featureId);
  if (!feature) throw new GatewayError('功能不存在。', 404, 'feature_not_found');
  const modelId = input.modelId || feature.modelId;
  const model = state.models.find(model => model.id === modelId), catalog = state.catalog.find(model => model.id === modelId);
  if (!model?.enabled || !catalog?.available || state.catalogError || !feature.allowedModelIds.includes(modelId) || !compatible(feature, catalog)) throw new GatewayError('此功能所选模型不可用，请明确选择一个已授权的模型。', 409, 'feature_model_unavailable');
  const group = own(model.groupPolicies, feature.group), override = own(feature.reasoningOverrides, modelId);
  const levels = catalog.reasoningEfforts || [];
  reasoning(model.reasoningPolicy, levels); reasoning(group, model.reasoningPolicy?.allowedEfforts || levels); reasoning(override, group?.allowedEfforts || model.reasoningPolicy?.allowedEfforts || levels);
  const effective = override || group || model.reasoningPolicy;
  const effort = input.reasoningEffort || effective?.defaultEffort || (levels.includes(catalog.defaultEffort) ? catalog.defaultEffort : undefined);
  if (effort && !(effective?.allowedEfforts || levels).includes(effort)) throw new GatewayError('此思考深度未对当前功能开放。', 400, 'reasoning_effort_disabled');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') invalid('stream 必须为布尔值。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.prompt)) invalid('请输入不超过 20000 个字符的内容。');
  return { model: modelId, messages: [{ role: 'system', content: FEATURE_KINDS[feature.kind].instruction }, { role: 'user', content: input.prompt }], stream: input.stream ?? true,
    ...((input.stream ?? true) ? { stream_options: { include_usage: true } } : {}), ...(effort ? { reasoning_effort: effort } : {}), ...(FEATURE_KINDS[feature.kind].structured ? { response_format: { type: 'json_object' } } : {}) };
}
