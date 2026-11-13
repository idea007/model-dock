// Node 22+. No SDK dependency. Run from any directory after configuring the gateway.
import { sse } from '../packages/protocol/events.mjs';
const base = process.env.MODEL_DOCK_BASE_URL || 'http://127.0.0.1:4317/v1';
const key = process.env.MODEL_DOCK_API_KEY;
if (!key) throw new Error('Set MODEL_DOCK_API_KEY to a scoped project key from the console.');
if (!process.env.MODEL_DOCK_MODEL) throw new Error('Set MODEL_DOCK_MODEL to an authorized model ID from the catalog.');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const response = await fetch(`${base}/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: controller.signal,
  body: JSON.stringify({ model: process.env.MODEL_DOCK_MODEL, messages: [{ role: 'user', content: process.argv[2] || '你好，请用一句话介绍自己。' }], stream: true })
});
if (!response.ok) throw new Error((await response.json()).error.message);
let done = false;
for await (const data of sse(response.body)) {
  if (data === '[DONE]') { done = true; break; }
  const value = JSON.parse(data);
  if (value.error) throw new Error(value.error.message);
  process.stdout.write(value.choices[0]?.delta.content || '');
}
if (!done) throw new Error('The stream ended before completion.');
process.stdout.write('\n');
