import { GatewayError, exact } from '../protocol/index.mjs';

export const routeGroup = route => route.group || '功能别名';
const groupPolicy = (model, name) => model.groupPolicies && Object.hasOwn(model.groupPolicies, name) ? model.groupPolicies[name] : null;
export const supportedEfforts = model => [...new Set(model.reasoningEfforts || [])];

export function validateReasoningPolicy(policy, available, label = 'reasoning policy') {
  if (policy == null) return null;
  exact(policy, ['allowedEfforts', 'defaultEffort']);
  const levels = policy.allowedEfforts;
  if (!Array.isArray(levels) || !levels.length || levels.length > available.length || new Set(levels).size !== levels.length || levels.some(level => !available.includes(level)) || !levels.includes(policy.defaultEffort)) {
    throw new GatewayError(`Invalid ${label}: choose declared reasoning levels and a default from that selection.`, 400, 'invalid_reasoning_policy');
  }
  return { allowedEfforts: [...levels], defaultEffort: policy.defaultEffort };
}

function validateModelReasoningPolicy(policy, declared) {
  if (policy == null) return null;
  exact(policy, ['allowedEfforts', 'defaultEffort', 'openEfforts']);
  const { openEfforts, allowedEfforts, defaultEffort } = policy;
  const opened = openEfforts === undefined ? declared
    : validateReasoningPolicy({ allowedEfforts: openEfforts, defaultEffort }, declared, 'open reasoning levels').allowedEfforts;
  const selected = validateReasoningPolicy({ allowedEfforts, defaultEffort }, opened);
  return openEfforts !== undefined && opened.length > selected.allowedEfforts.length
    ? { ...selected, openEfforts: opened } : selected;
}

export function modelReasoning(model) {
  const levels = supportedEfforts(model);
  return model.reasoningPolicy || (levels.length ? { allowedEfforts: levels, defaultEffort: levels.includes(model.defaultEffort) ? model.defaultEffort : levels[0] } : null);
}

export function routeReasoning(model, route) {
  return route?.reasoningPolicy || groupPolicy(model, routeGroup(route || {})) || modelReasoning(model);
}

// Application functions and preferences live in clients.
export function saveModelSettings(state, input) {
  exact(input, ['revision', 'models']);
  if (!Array.isArray(input.models) || input.models.length !== state.models.length) throw new GatewayError('Submit the complete model settings.');
  const seen = new Set();
  for (const row of input.models) {
    exact(row, ['id', 'enabled', 'reasoningPolicy']);
    const model = state.models.find(item => item.id === row.id);
    if (!model || seen.has(row.id) || typeof row.enabled !== 'boolean') throw new GatewayError('Invalid or duplicate model settings.');
    seen.add(row.id);
    model.enabled = row.enabled;
    if (!Object.hasOwn(row, 'reasoningPolicy')) continue;

    const declared = supportedEfforts(model);
    const policy = validateModelReasoningPolicy(row.reasoningPolicy, declared);
    const previous = model.reasoningPolicy?.openEfforts ?? model.reasoningPolicy?.allowedEfforts ?? declared;
    const next = policy?.openEfforts ?? policy?.allowedEfforts ?? declared;
    const removed = declared.filter(level => previous.includes(level) && !next.includes(level));
    if (removed.length) {
      const aliases = state.routes.filter(route => route.modelId === model.id).map(route => route.reasoningPolicy);
      const legacyPolicies = [...Object.values(model.groupPolicies || {}), ...aliases];
      if (legacyPolicies.some(legacy => Array.isArray(legacy?.allowedEfforts) && legacy.allowedEfforts.some(level => removed.includes(level)))) {
        throw new GatewayError('A legacy alias or group uses one of the removed reasoning levels.', 409, 'reasoning_policy_conflict');
      }
    }
    if (policy) model.reasoningPolicy = policy;
    else delete model.reasoningPolicy;
  }
}

export function applyReasoningPolicy(model, route, request) {
  const base = model.reasoningPolicy;
  const group = route && groupPolicy(model, routeGroup(route));
  const policy = route?.reasoningPolicy || group || base;
  // Without a saved policy, retain the provider's existing parameter behavior.
  if (!policy) return request;
  try {
    const levels = supportedEfforts(model);
    const opened = base?.openEfforts ?? base?.allowedEfforts ?? levels;
    if (base) validateModelReasoningPolicy(base, levels);
    if (group) validateReasoningPolicy(group, opened);
    if (policy !== base) validateReasoningPolicy(policy, group?.allowedEfforts ?? opened);
  } catch {
    throw new GatewayError('The saved reasoning settings no longer match the model catalog. Review and save model settings.', 409, 'reasoning_policy_unavailable');
  }
  const effort = request.reasoning_effort ?? policy.defaultEffort;
  if (!policy.allowedEfforts.includes(effort)) throw new GatewayError('This reasoning effort is not enabled for the selected model or function.', 400, 'reasoning_effort_disabled', 'reasoning_effort');
  return { ...request, reasoning_effort: effort };
}
