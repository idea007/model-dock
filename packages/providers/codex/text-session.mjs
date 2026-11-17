import { createHash } from 'node:crypto';
import { GatewayError } from '../../protocol/index.mjs';
import { prepareConversation } from './tools.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isInstruction = message => ['system', 'developer'].includes(message.role);
const messageHash = ({ role, content, tool_call_id, tool_calls, name, refusal }) =>
  digest({ role, content, tool_call_id, tool_calls, name, refusal });
const unknown = () => new GatewayError('The previous Codex turn could not be confirmed. Check the same session before retrying.', 409, 'session_outcome_unknown');
const turnFailed = () => new GatewayError('The recorded Codex turn failed and was not dispatched again.', 409, 'session_turn_failed');
const emptyUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function completed(row, content, nativeUsage) {
  const { requestHash, threadId, turnId } = row;
  return { ...row, status: 'complete', nativeUsage,
    hashes: [...row.hashes, messageHash({ role: 'assistant', content })],
    recent: [...row.recent, { requestHash, threadId, turnId }].slice(-32) };
}

export async function runCodexSession({ store, session, request, instructions, tools, onDelta, signal, readTurn, runTurn }) {
  const lease = await store.acquire(session.id);
  try {
    const messages = request.messages.filter(message => !isInstruction(message));
    const hashes = messages.map(messageHash);
    const compatibility = digest({ model: request.model, tools: tools.dynamicTools, policy: 1 });
    const instructionsHash = digest(instructions);
    const requestHash = digest({ messages: request.messages, compatibility, instructionsHash, effort: request.reasoning_effort,
      format: request.response_format });
    let row = lease.row, recovered;
    if (row?.status === 'pending') {
      const outcome = row.turnId && await readTurn(row);
      if (!outcome) throw unknown();
      if (outcome.content) {
        recovered = row.requestHash;
        row = await lease.write(completed(row, outcome.content, null));
      } else {
        row = await lease.write({ ...row, status: 'failed' });
      }
    }
    const previous = row?.recent.find(turn => turn.requestHash === requestHash);
    if (previous) {
      const outcome = await readTurn(previous);
      if (!outcome?.content) throw unknown();
      onDelta(outcome.content);
      return { finishReason: 'stop', usage: recovered === requestHash ? null : emptyUsage, replayed: true, turnId: previous.turnId };
    }
    if (row?.requestHash === requestHash) throw row.status === 'failed' ? turnFailed() : unknown();
    signal.throwIfAborted();

    const compatible = row?.status === 'complete' && row.compatibility === compatibility;
    const incremental = compatible && row.hashes.length < hashes.length && row.hashes.every((hash, index) => hash === hashes[index]);
    const reuse = incremental || compatible && session.mode === 'snapshot';
    const parent = reuse ? null : await store.read(session.parentId);
    const fork = parent?.status === 'complete' && parent.compatibility === compatibility;
    const source = reuse ? row : fork ? parent : null;
    const next = prepareConversation(incremental ? messages.slice(row.hashes.length) : request.messages);
    if (source && source.instructionsHash !== instructionsHash) {
      next.history.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] });
    }
    let pending, content = '';
    const result = await runTurn({
      threadId: reuse ? row.threadId : null, parentThreadId: fork ? parent.threadId : null,
      history: next.history, input: next.input, persistent: true, usageBaseline: source ? source.nativeUsage ?? null : undefined,
      onDelta(text) { content += text; onDelta(text); },
      async onIdentity({ threadId, turnId }) {
        pending = await lease.write({ requestHash, instructionsHash, compatibility, hashes, threadId, turnId: turnId ?? null,
          status: 'pending', recent: row?.recent || [] });
      }
    });
    await lease.write(result.finishReason === 'stop'
      ? completed(pending, content, result.nativeUsage)
      : { ...pending, status: 'handoff' });
    return result;
  } finally { lease.release(); }
}
