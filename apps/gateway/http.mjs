import { once } from 'node:events';

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function write(response, data, signal) {
  signal.throwIfAborted();
  if (!response.write(data)) await once(response, 'drain', { signal });
}

export function beginStream(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  return setInterval(() => {
    if (!response.destroyed && response.writableLength < 65536) response.write(': keep-alive\n\n');
  }, 15_000);
}
