// The calling application owns execution. Never execute arbitrary generated commands.
const base = process.env.MODEL_DOCK_BASE_URL || 'http://127.0.0.1:4317/v1';
const key = process.env.MODEL_DOCK_API_KEY;
if (!key) throw new Error('Set MODEL_DOCK_API_KEY first.');
const model = process.env.MODEL_DOCK_MODEL;
if (!process.env.MODEL_DOCK_MODEL) throw new Error('Set MODEL_DOCK_MODEL to an authorized model ID from the catalog.');
const messages = [{ role: 'user', content: 'Use the add function to calculate 17 + 25.' }];
const tools = [{ type: 'function', function: { name: 'add', description: 'Add two finite numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } } }];
for (let turn = 0; turn < 4; turn++) {
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, tools }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error.message);
  const message = body.choices[0].message;
  if (!message.tool_calls?.length) { console.log(message.content); break; }
  messages.push(message);
  for (const call of message.tool_calls) {
    const input = JSON.parse(call.function.arguments);
    if (call.function.name !== 'add' || !Number.isFinite(input.a) || !Number.isFinite(input.b) || Object.keys(input).some(key => !['a', 'b'].includes(key))) throw new Error('The function request failed application validation.');
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result: input.a + input.b }) });
  }
  if (turn === 3) throw new Error('Tool loop exceeded the application limit.');
}
