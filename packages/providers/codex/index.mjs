import { GatewayError } from '../../protocol/index.mjs';
import { CodexClient } from './client.mjs';

export function createCodexProvider(options = {}) {
  const client = new CodexClient(options);
  return {
    async discover(connection, { signal }) {
      return (await client.models(signal)).map(model => ({
        nativeId: model.id, name: model.displayName || model.id,
        capabilities: { text: true, tools: true, structured: true },
        reasoningEfforts: (model.supportedReasoningEfforts || []).map(value => value.reasoningEffort || value.effort || value).filter(value => typeof value === 'string'),
        defaultEffort: model.defaultReasoningEffort || null,
        details: 'Local Codex CLI bridge. Inference uses the account/provider configured in Codex.'
      }));
    },
    async *generate(connection, request, { signal, model }) {
      const allowed = ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort'];
      for (const key of Object.keys(request)) if (!allowed.includes(key)) throw new GatewayError(`Codex cannot enforce ${key}; omit this parameter.`, 400, 'unsupported_parameter', key);
      if (request.parallel_tool_calls === true) throw new GatewayError('Codex bridge currently hands off one function per request.', 400, 'unsupported_parameter', 'parallel_tool_calls');
      if (request.tools?.some(tool => tool.function.strict === true)) throw new GatewayError('Codex dynamic functions cannot guarantee strict schemas.', 400, 'unsupported_parameter', 'tools.function.strict');
      if (request.reasoning_effort && !model.reasoningEfforts?.includes(request.reasoning_effort)) throw new GatewayError('This reasoning effort was not declared by the model.', 400, 'unsupported_parameter', 'reasoning_effort');
      const queue = []; let wake, finished = false, result, failure;
      const task = client.run(request, { signal, onDelta(content) { queue.push({ type: 'delta', delta: { content } }); wake?.(); } })
        .then(value => { result = value; }, error => { failure = error; }).finally(() => { finished = true; wake?.(); });
      while (!finished || queue.length) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; });
        while (queue.length) yield queue.shift();
      }
      await task; if (failure) throw failure;
      if (result.toolCalls?.length) yield { type: 'delta', delta: { tool_calls: result.toolCalls.map((call, index) => ({ index, ...call })) } };
      if (result.usage) yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: result.finishReason };
    },
    close: () => client.stop()
  };
}
