// Protocol fixture: no real CLI, account, model or inference service is used.
import readline from 'node:readline';
const threads = new Map(); let next = 0;
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => write({ method, params });
const ok = (id, result = {}) => write({ id, result });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (!method || id === undefined) return;
  if (method === 'initialize') {
    if (!process.argv.includes('shell_tool') || !process.argv.includes('hooks') || params.capabilities?.experimentalApi !== true) { write({ id, error: { message: 'Unsafe fixture configuration' } }); return; }
    ok(id); return;
  }
  if (method === 'config/read') { ok(id, { config: { mcp_servers: { inherited: { enabled: true } } } }); return; }
  if (method === 'account/read') { ok(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }); return; }
  if (method === 'model/list') { ok(id, { data: [{ id: 'codex-fixture', displayName: 'Codex fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null }); return; }
  if (method === 'thread/start') {
    if (params.config?.['mcp_servers.inherited.enabled'] !== false || params.sandbox !== 'read-only' || params.approvalPolicy !== 'never' || !params.ephemeral) { write({ id, error: { message: 'Isolation missing' } }); return; }
    const threadId = `thread_${++next}`; threads.set(threadId, { ...params, history: [] }); ok(id, { thread: { id: threadId } }); return;
  }
  const thread = threads.get(params.threadId);
  if (method === 'thread/inject_items') { thread.history = params.items; ok(id); return; }
  if (method === 'turn/interrupt') { ok(id); notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); return; }
  if (method === 'thread/unsubscribe') { threads.delete(params.threadId); ok(id); return; }
  if (method === 'turn/start') {
    const turnId = `turn_${next}`, base = { threadId: params.threadId, turnId }, prompt = params.input.map(item => item.text || '').join('');
    // Notifications before the RPC response must not be lost.
    notify('item/started', { ...base, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
    ok(id, { turn: { id: turnId } });
    notify('item/agentMessage/delta', { ...base, itemId: 'commentary', delta: 'PRIVATE COMMENTARY' });
    if (prompt === 'failure') { notify('error', { ...base, willRetry: false, error: { message: '/private/secret/path' } }); return; }
    if (prompt === 'network_failure') { notify('error', { ...base, willRetry: false, error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, message: '/private/secret/path' } }); return; }
    if (prompt === 'slow') return;
    notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } });
    if (prompt === 'tools' && thread.dynamicTools?.length) {
      const tool = thread.dynamicTools[0].tools[0];
      write({ id: 900 + next, method: 'item/tool/call', params: { ...base, namespace: 'application', tool: tool.name, callId: 'call_codex', arguments: { city: '杭州' } } }); return;
    }
    const toolResult = thread.history.find(item => item.type === 'function_call_output');
    const text = toolResult ? `工具结果：${toolResult.output}` : thread.history.some(item => item.role === 'assistant') ? '原生角色历史已保留' : 'Codex 测试回答';
    notify('item/started', { ...base, item: { id: 'final', type: 'agentMessage', phase: 'final_answer' } });
    notify('item/agentMessage/delta', { ...base, itemId: 'final', delta: text });
    notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed' } }); return;
  }
  write({ id, error: { code: -32601, message: 'Unknown fixture method' } });
});
