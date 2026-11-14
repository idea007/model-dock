import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startGateway } from '../../apps/gateway/server.mjs';

// Isolated, deterministic providers. Never read personal gateway credentials or call upstreams.
export async function startMockGateway() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-demo-'));
  const calls = [];
  const provider = {
    async discover() { return []; },
    async *generate(connection, request, { signal }) {
      calls.push(structuredClone(request));
      if (calls.length > 50) calls.shift();
      const prompt = request.messages.at(-1).content;
      const content = request.response_format ? JSON.stringify({ demo: true, model: request.model, input: prompt, note: '模拟提取结果，请连接真实模型获得分析。' }, null, 2)
        : `模拟回复 · ${request.model}\n${request.reasoning_effort ? `思考深度：${request.reasoning_effort}\n` : ''}\n已收到：${prompt}\n\n这是本地模拟结果，用于体验功能选择、分组配置与流式输出。连接真实 Model Dock 后，同一功能会请求你明确选择的模型。`;
      for (let offset = 0; offset < content.length; offset += 8) {
        await delay(24, undefined, { signal });
        yield { type: 'delta', delta: { content: content.slice(offset, offset + 8) } };
      }
      yield { type: 'done', finishReason: 'stop' };
    }
  };
  let app;
  try {
    app = await startGateway({ directory, port: 0, providers: { openai: provider } });
    await app.store.mutate(0, state => {
      state.connections.push({ id: 'demo-source', name: '模拟模型服务', type: 'openai', baseUrl: 'http://127.0.0.1', enabled: true, status: 'connected', maxConcurrency: 4, timeoutSeconds: 60 });
      state.models.push(...['demo-chat', 'demo-reasoner'].map((name, index) => ({ id: `demo-source/${name}`, nativeId: name, name, connectionId: 'demo-source', enabled: true, available: true, capabilities: { text: true, structured: true, tools: false, thinking: Boolean(index) }, contextWindow: 32768, reasoningEfforts: index ? ['none', 'low', 'medium', 'high'] : [], defaultEffort: index ? 'medium' : null })));
    });
    const { token } = await app.gateway.createKey({ revision: app.store.read().revision, name: 'Isolated client demo', models: app.store.read().models.map(model => model.id) });
    let closing;
    return { app, calls, connection: { baseUrl: `${app.origin}/v1`, apiKey: token }, close() { return closing ||= app.close().finally(() => fs.rm(directory, { recursive: true, force: true })); } };
  } catch (error) { await app?.close(); await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
