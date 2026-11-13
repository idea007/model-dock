// Explicit deterministic demo upstream. No account, model weights or inference cost.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
export async function startMockServer(port = 4321) {
  const server = http.createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && request.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'demo-echo', object: 'model', created: 0, owned_by: 'explicit-test-fixture' }] });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(404, { error: { message: 'Not found' } });
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (raw.length > 65536) return json(413, { error: { message: 'Test request too large' } }); }
    let body; try { body = JSON.parse(raw); } catch { return json(400, { error: { message: 'Invalid JSON' } }); }
    if (body.model !== 'demo-echo') return json(404, { error: { message: 'Unknown demo model' } });
    const content = '这是 Model Dock 的固定测试响应。请求已通过网关到达模拟上游；这里没有调用真实模型。';
    const common = { id: 'demo-completion', created: Math.floor(Date.now() / 1000), model: 'demo-echo' };
    if (!body.stream) return json(200, { ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = content.match(/.{1,5}/gu); let index = 0;
    const timer = setInterval(() => {
      if (index < chunks.length) response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[index++] }, finish_reason: null }] })}\n\n`);
      else { clearInterval(timer); response.end(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); }
    }, 80);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const app = await startMockServer();
  console.log(`Explicit mock upstream: ${app.origin}/v1\nAdd an API connection named “测试上游”, leave API Key empty, then discover and enable demo-echo.\nResponses are fixed test data, not real model output.`);
  process.once('SIGINT', () => { void app.close(); }); process.once('SIGTERM', () => { void app.close(); });
}
