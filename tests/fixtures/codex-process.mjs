// Protocol fixture: no real CLI, account, model or inference service is used.
import readline from 'node:readline';
import { createHash } from 'node:crypto';
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
const imageDigest = url => createHash('sha256').update(Buffer.from(url.split(',')[1], 'base64')).digest('hex');
function checkReferences(params) {
  const workingDirectory = realpathSync(process.cwd());
  return params.input.slice(1).every((image, index) => {
    if (image.type !== 'localImage' || image.detail !== 'original') return false;
    const directory = realpathSync(path.dirname(image.path));
    if (path.dirname(directory) !== workingDirectory || path.basename(image.path) !== `reference-${index + 1}.png`) return false;
    // Windows does not report POSIX owner, group, and other permission bits.
    if (process.platform !== 'win32' && (statSync(image.path).mode & 0o777) !== 0o600) return false;
    return readFileSync(image.path).subarray(0, pngBytes.length).equals(pngBytes);
  });
}
function finishTurn(thread, status, error) {
  const { threadId, turnId } = thread.turn;
  thread.turn = null;
  const turn = { id: turnId, status, itemsView: 'full', items: [{ type: 'userMessage' }, ...(thread.output || [])], ...(error ? { error } : {}) };
  if (!thread.ephemeral) thread.completed.push(turn);
  notify('turn/completed', { threadId, turn });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'fixture/finishInterrupt') {
    const thread = threads.get(params.threadId);
    if (thread?.turn) finishTurn(thread, 'interrupted');
    return;
  }
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
  if (method === 'model/list') {
    ok(id, { data: [{ id: 'codex-fixture', displayName: 'Codex fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault: true },
      { id: 'codex-text-only', inputModalities: ['text'] }], nextCursor: null }); return;
  }
  if (method === 'thread/start') {
    if (params.config?.['mcp_servers.inherited.enabled'] !== false || params.config.web_search !== 'disabled' ||
      params.sandbox !== 'read-only' || params.approvalPolicy !== 'never' || typeof params.ephemeral !== 'boolean' || imageChannel && params.dynamicTools?.length) {
      write({ id, error: { message: 'Isolation missing' } }); return;
    }
    const threadId = `thread_${++next}`; threads.set(threadId, { ...params, history: [], completed: [] }); ok(id, { thread: { id: threadId } }); return;
  }
  const thread = threads.get(params.threadId);
  if (method === 'thread/resume' && thread && !thread.ephemeral && params.excludeTurns && params.sandbox === 'read-only') {
    thread.resumed = true; thread.history = []; ok(id, { thread: { id: params.threadId } }); return;
  }
  if (method === 'thread/fork' && thread && !thread.ephemeral && params.excludeTurns && params.sandbox === 'read-only') {
    const threadId = `thread_${++next}`;
    threads.set(threadId, { ...thread, history: [], completed: [], forked: true });
    ok(id, { thread: { id: threadId } }); return;
  }
  if (method === 'thread/read' && thread && !thread.ephemeral && params.includeTurns) {
    ok(id, { thread: { id: params.threadId, turns: thread.completed } }); return;
  }
  if (method === 'thread/inject_items') { thread.history = params.items; ok(id); return; }
  if (method === 'turn/interrupt') {
    if (!params.turnId || thread?.turn?.turnId !== params.turnId) {
      write({ id, error: { code: -32602, message: 'The interrupt requires the active turn ID' } }); return;
    }
    ok(id);
    if (['no-interrupt-terminal', 'await-interrupt-terminal'].includes(thread.prompt)) {
      notify('fixture/interruptAccepted', params);
    } else finishTurn(thread, 'interrupted');
    return;
  }
  if (method === 'thread/unsubscribe') { if (thread?.ephemeral) threads.delete(params.threadId); ok(id); return; }
  if (method === 'turn/start') {
    const turnId = `turn_${++next}`, base = { threadId: params.threadId, turnId }, prompt = params.input.map(item => item.text || '').join('');
    if ([...threads.values()].some(row => row.turn)) {
      write({ id, error: { message: 'Previous fixture turn is still running' } }); return;
    }
    thread.turn = base;
    thread.output = null;
    thread.prompt = prompt;
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
      thread.output = [{ type: 'imageGeneration', id: 'image', status: 'completed', result }];
      notify('item/completed', { ...base, turnId: 'another-turn', item: { type: 'imageGeneration', id: 'wrong', status: 'completed', result: 'wrong-turn' } });
      notify('item/completed', { ...base, item: { type: 'imageGeneration', id: 'image', status: 'completed', result, savedPath: '/private/secret/path.png' } });
      ok(id, { turn: { id: turnId } });
      finishTurn(thread, 'completed'); return;
    }
    if (prompt === 'cancel-before-start-ack') { notify('fixture/turnAccepted', base); return; }
    // Notifications before the RPC response must not be lost.
    notify('item/started', { ...base, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
    if (prompt === 'retryable-native-error') {
      notify('error', { ...base, willRetry: true, error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } });
    }
    if (prompt === 'tools') {
      const exposed = thread.dynamicTools?.flatMap(namespace => namespace.tools);
      if (exposed?.length !== 1 || !exposed[0].description.startsWith('Application function: weather.')) {
        write({ id, error: { message: 'Only the selected function should be exposed' } }); return;
      }
      const [tool] = exposed;
      for (const [offset, callId] of ['call_stale', 'call_codex', 'call_duplicate'].entries()) {
        write({ id: 900 + offset, method: 'item/tool/call', params: { ...base,
          ...(offset === 0 ? { turnId: 'stale-turn' } : {}), namespace: 'application', tool: tool.name, callId, arguments: { city: '杭州' } } });
      }
      ok(id, { turn: { id: turnId } });
      return;
    }
    ok(id, { turn: { id: turnId } });
    notify('item/agentMessage/delta', { ...base, itemId: 'commentary', delta: 'PRIVATE COMMENTARY' });
    const failures = {
      failure: null, usage_limit: 'usageLimitExceeded', rate_limit: 'rateLimitExceeded',
      context_limit: 'contextWindowExceeded', bad_request: 'badRequest',
      network_failure: { responseStreamDisconnected: { httpStatusCode: null } },
      http_rate_limit: { httpConnectionFailed: { httpStatusCode: 429 } }
    };
    if (Object.hasOwn(failures, prompt)) {
      const error = { codexErrorInfo: failures[prompt], message: '/private/secret/path' };
      notify('error', { ...base, willRetry: false, error });
      finishTurn(thread, 'failed', error); return;
    }
    if (prompt === 'slow') return;
    if (['await-interrupt-terminal', 'no-interrupt-terminal'].includes(prompt)) {
      notify('item/started', { ...base, item: { type: 'agentMessage', id: 'partial', phase: 'partial_answer' } });
      notify('item/agentMessage/delta', { ...base, itemId: 'partial', delta: 'Partial. ' });
      return;
    }
    if (prompt === 'empty-completion') { finishTurn(thread, 'completed'); return; }
    if (prompt === 'complete-message-items' || prompt === 'inconsistent-message-items') {
      notify('item/agentMessage/delta', { ...base, itemId: 'unknown', delta: 'UNCLASSIFIED' });
      notify('item/completed', { ...base, item: { type: 'agentMessage', id: 'unknown', phase: 'commentary', text: 'UNCLASSIFIED' } });
      notify('item/started', { ...base, item: { type: 'agentMessage', id: 'first', phase: 'partial_answer' } });
      notify('item/agentMessage/delta', { ...base, itemId: 'first', delta: 'First' });
      const text = prompt === 'complete-message-items' ? 'First. ' : 'Different text.';
      notify('item/completed', { ...base, item: { type: 'agentMessage', id: 'first', phase: 'partial_answer', text } });
      const final = { type: 'agentMessage', id: 'later', phase: 'final_answer', text: 'Last.' };
      notify('item/completed', { ...base, item: final });
      notify('item/completed', { ...base, item: final });
      finishTurn(thread, 'completed'); return;
    }
    const multiplier = thread.completed.length + 1;
    notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { inputTokens: 10 * multiplier, outputTokens: 4 * multiplier, totalTokens: 14 * multiplier } } });
    const toolResult = thread.history.find(item => item.type === 'function_call_output');
    let text = toolResult ? `工具结果：${toolResult.output}` : thread.history.some(item => item.role === 'assistant') ? '原生角色历史已保留' : 'Codex 测试回答';
    if (prompt === 'fixture-session-continue') text = thread.resumed && !thread.history.length ? 'native session resumed' : 'new thread';
    if (prompt === 'fixture-session-fork') text = thread.forked ? 'native session forked' : 'new thread';
    if (prompt.startsWith('vision-check')) {
      const current = params.input.map(part => part.type === 'image' ? ['image', imageDigest(part.url), part.detail ?? null] : ['text', part.text]);
      const history = thread.history.filter(item => item.role === 'user').map(item => item.content.map(part => (
        part.type === 'input_image' ? ['image', imageDigest(part.image_url), part.detail ?? null] : ['text', part.text]
      )));
      text = JSON.stringify({ current, history });
    }
    notify('item/started', { ...base, item: { id: 'final', type: 'agentMessage', phase: 'final_answer' } });
    notify('item/agentMessage/delta', { ...base, itemId: 'final', delta: text });
    thread.output = [{ type: 'agentMessage', phase: 'final_answer', text }];
    finishTurn(thread, 'completed'); return;
  }
  write({ id, error: { code: -32601, message: 'Unknown fixture method' } });
});
