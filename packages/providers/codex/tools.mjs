// Adapted from Cursor Blinking's codex-bridge/tool-protocol.mjs.
// The application executes tools; this adapter only transports requests/results.
import { createHash } from 'node:crypto';
import { GatewayError } from '../../protocol/index.mjs';
export const nativeToolName = name => `fn_${createHash('sha256').update(name).digest('hex')}`;
export function prepareTools(request) {
  const choice = request.tool_choice || 'auto';
  const selected = typeof choice === 'object' ? choice.function.name : null;
  const offered = choice === 'none' ? [] : (request.tools || []).filter(tool => !selected || tool.function.name === selected);
  const names = new Map(offered.map(tool => [nativeToolName(tool.function.name), tool.function.name]));
  return {
    required: choice === 'required' || Boolean(selected),
    dynamicTools: offered.length ? [{ type: 'namespace', name: 'application', description: 'Functions executed by the API caller.', tools: offered.map(({ function: fn }) => ({
      type: 'function', name: nativeToolName(fn.name), deferLoading: false,
      description: `Application function: ${fn.name}. ${fn.description || ''}`, inputSchema: fn.parameters
    })) }] : [],
    readCall(params) {
      const name = names.get(params.tool);
      if (params.namespace !== 'application' || !name || typeof params.callId !== 'string' || !params.callId.trim()
        || params.callId.length > 200 || /[\u0000-\u001f]/u.test(params.callId)
        || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
        throw new GatewayError('Codex returned an invalid application function call.', 502, 'codex_tool_invalid');
      }
      return { id: params.callId, type: 'function', function: { name, arguments: JSON.stringify(params.arguments) } };
    }
  };
}
export function prepareConversation(messages) {
  const history = [], instructions = []; let input = [];
  for (const [index, message] of messages.entries()) {
    const text = message.content || message.refusal || '';
    if (['system', 'developer'].includes(message.role)) { instructions.push(text); continue; }
    if (message.role === 'user' && index === messages.length - 1) { input = [{ type: 'text', text }]; continue; }
    if (message.role === 'tool') { history.push({ type: 'function_call_output', call_id: message.tool_call_id, output: text }); continue; }
    if (text) history.push({ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text }] });
    for (const call of message.tool_calls || []) history.push({ type: 'function_call', call_id: call.id, namespace: 'application', name: nativeToolName(call.function.name), arguments: call.function.arguments });
  }
  if (!input.length) input = [{ type: 'text', text: 'Continue the application conversation using the completed tool results above.' }];
  return { history, input, instructions: instructions.join('\n\n') };
}
