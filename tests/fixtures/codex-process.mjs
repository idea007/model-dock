// Protocol fixture: no real CLI, account, model or inference service is used.
import readline from 'node:readline';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
const threads = new Map(); let next = 0;
const hasFlag = (mode, name) => process.argv.some((value, index) => value === mode && process.argv[index + 1] === name);
const imageChannel = hasFlag('--enable', 'image_generation');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxoAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(png, 'base64');
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => write({ method, params });
const ok = (id, result = {}) => write({ id, result });
function checkReferences(params) {
  return params.input.slice(1).every((image, index) => {
    if (image.type !== 'localImage' || image.detail !== 'original') return false;
    const directory = path.dirname(image.path);
    if (path.dirname(realpathSync(directory)) !== process.cwd() || path.basename(image.path) !== `reference-${index + 1}.png`) return false;
    return (statSync(image.path).mode & 0o777) === 0o600 && readFileSync(image.path).subarray(0, pngBytes.length).equals(pngBytes);
  });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (!method || id === undefined) return;
  if (method === 'initialize') {
    const blocked = ['shell_tool', 'hooks', 'apps', 'unified_exec'];
    const switch_ = imageChannel ? '--enable' : '--disable';
    if (!blocked.every(name => hasFlag('--disable', name)) || !hasFlag(switch_, 'code_mode_host') ||
      !hasFlag(switch_, 'image_generation') || params.capabilities?.experimentalApi !== true) {
      write({ id, error: { message: 'Unsafe fixture configuration' } }); return;
    }
    ok(id); return;
  }
  if (method === 'config/read') { ok(id, { config: { mcp_servers: { inherited: { enabled: true } } } }); return; }
  if (method === 'account/read') { ok(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }); return; }
  if (method === 'experimentalFeature/list') { ok(id, { data: [{ name: 'image_generation', enabled: imageChannel, stage: 'stable' }], nextCursor: null }); return; }
  if (method === 'model/list') { ok(id, { data: [{ id: 'codex-fixture', displayName: 'Codex fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault: true }], nextCursor: null }); return; }
  if (method === 'thread/start') {
    if (params.config?.['mcp_servers.inherited.enabled'] !== false || params.config.web_search !== 'disabled' ||
      params.sandbox !== 'read-only' || params.approvalPolicy !== 'never' || !params.ephemeral || imageChannel && params.dynamicTools?.length) {
      write({ id, error: { message: 'Isolation missing' } }); return;
    }
    const threadId = `thread_${++next}`; threads.set(threadId, { ...params, history: [] }); ok(id, { thread: { id: threadId } }); return;
  }
  const thread = threads.get(params.threadId);
  if (method === 'thread/inject_items') { thread.history = params.items; ok(id); return; }
  if (method === 'turn/interrupt') { ok(id); notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); return; }
  if (method === 'thread/unsubscribe') { threads.delete(params.threadId); ok(id); return; }
  if (method === 'turn/start') {
    const turnId = `turn_${next}`, base = { threadId: params.threadId, turnId }, prompt = params.input.map(item => item.text || '').join('');
    if (imageChannel) {
      if (params.model !== 'codex-fixture' || !prompt.startsWith('$imagegen ') || params.sandboxPolicy?.type !== 'readOnly') {
        write({ id, error: { message: 'Invalid image turn' } }); return;
      }
      try {
        if (!checkReferences(params)) throw new Error();
        if (prompt.endsWith('fixture-edit')) {
          const labels = params.input.slice(1).map(image => String.fromCharCode(readFileSync(image.path).at(-1)));
          if (labels.join('') !== 'AB' || !prompt.includes('9:16') || !prompt.includes('real alpha pixels')) throw new Error();
        }
      } catch {
        write({ id, error: { message: 'Invalid reference attachments or image options' } }); return;
      }
      if (prompt.endsWith('slow-image')) { ok(id, { turn: { id: turnId } }); return; }
      const result = prompt.endsWith('invalid-image') ? '/private/secret/path.png' : png;
      notify('item/completed', { ...base, turnId: 'another-turn', item: { type: 'imageGeneration', id: 'wrong', status: 'completed', result: 'wrong-turn' } });
      notify('item/completed', { ...base, item: { type: 'imageGeneration', id: 'image', status: 'completed', result, savedPath: '/private/secret/path.png' } });
      ok(id, { turn: { id: turnId } });
      notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed' } }); return;
    }
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
