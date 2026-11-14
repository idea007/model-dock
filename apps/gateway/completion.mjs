import { GatewayError } from '../../packages/protocol/index.mjs';

export const completionState = () => ({ content: '', refusal: '', tools: new Map(), finishReason: null });

export function mergeDelta(state, delta) {
  if (delta.content != null) {
    if (typeof delta.content !== 'string') throw new GatewayError('Invalid provider text delta.', 502, 'upstream_protocol_error');
    state.content += delta.content;
  }
  if (delta.refusal != null) {
    if (typeof delta.refusal !== 'string') throw new GatewayError('Invalid provider refusal delta.', 502, 'upstream_protocol_error');
    state.refusal += delta.refusal;
  }
  if (delta.tool_calls != null) {
    if (!Array.isArray(delta.tool_calls)) throw new GatewayError('Invalid function delta.', 502, 'upstream_protocol_error');
    for (const call of delta.tool_calls) {
      if (!Number.isInteger(call?.index) || call.index < 0 || call.index > 127) throw new GatewayError('Invalid function index.', 502, 'upstream_protocol_error');
      if ((call.type != null && call.type !== 'function') || [call.id, call.function?.name, call.function?.arguments].some(value => value != null && typeof value !== 'string')) {
        throw new GatewayError('Invalid function delta.', 502, 'upstream_protocol_error');
      }
      const current = state.tools.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) current.id += call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      state.tools.set(call.index, current);
    }
  }
}

export function finalizeCompletion(state, body) {
  const { finishReason } = state;
  if (finishReason === 'length' || finishReason === 'content_filter') return [];
  const tools = [...state.tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
  const ids = new Set();
  for (const tool of tools) {
    if (!tool.id.trim() || tool.id.length > 200 || /[\u0000-\u001f]/u.test(tool.id) || ids.has(tool.id)
      || !body.tools?.some(item => item.function.name === tool.function.name)) {
      throw new GatewayError('Provider returned an invalid application function call.', 502, 'upstream_protocol_error');
    }
    ids.add(tool.id);
    try { const args = JSON.parse(tool.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
    catch { throw new GatewayError('Provider returned invalid function arguments.', 502, 'upstream_protocol_error'); }
  }
  if (!['stop', 'tool_calls'].includes(finishReason) || (finishReason === 'tool_calls') !== Boolean(tools.length)) throw new GatewayError('Invalid provider finish reason.', 502, 'upstream_protocol_error');
  if (tools.length || !state.refusal) {
    const choice = body.tool_choice;
    const mismatch = (choice === 'none' && tools.length) || (choice === 'required' && !tools.length)
      || (typeof choice === 'object' && (!tools.length || tools.some(tool => tool.function.name !== choice.function.name)))
      || (body.parallel_tool_calls === false && tools.length > 1);
    if (mismatch) throw new GatewayError('Provider did not honor the requested tool selection.', 502, 'upstream_tool_choice_failed');
  }
  if (!tools.length && !state.refusal && ['json_object', 'json_schema'].includes(body.response_format?.type)) {
    try {
      const parsed = JSON.parse(state.content);
      if (body.response_format.type === 'json_object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error();
    } catch { throw new GatewayError('Provider did not return valid JSON for the requested format.', 502, 'upstream_json_invalid'); }
  }
  return tools;
}
