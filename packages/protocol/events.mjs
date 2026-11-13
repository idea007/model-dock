// Browser-safe bounded streaming decoders shared by providers and the console.
export async function* lines(body, maximum = 4 * 1024 * 1024) {
  if (!body) throw new Error('Missing response body.');
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > maximum) throw new Error('Stream frame exceeds limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1); yield line;
      }
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function* sse(body) {
  let data = [], size = 0;
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = []; size = 0;
    } else if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, ''); data.push(value); size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error('SSE event exceeds limit.');
    }
  }
  // An event without its delimiter is incomplete, never a successful terminal.
  if (data.length) throw new Error('Incomplete SSE event.');
}
