// Isolated browser QA: deterministic local upstream and disposable credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureUpstream } from './helpers.mjs';
import { startGateway } from '../apps/gateway/server.mjs';
const cleanup = [], upstream = await fixtureUpstream({ after: fn => cleanup.push(fn) });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dock-browser-'));
await fs.writeFile(path.join(directory, 'admin.token'), 'browser-qa-local-only\n', { mode: 0o600 });
const app = await startGateway({ directory, port: 4318 });
console.log(JSON.stringify({ console: app.origin, fixtureBaseUrl: `${upstream.origin}/v1` }));
const stop = async () => { await app.close(); for (const fn of cleanup) await fn(); await fs.rm(directory, { recursive: true, force: true }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
