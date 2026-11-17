import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayError } from '../protocol/index.mjs';
import { writePrivateJson } from './store.mjs';
import { localDay, retentionDays } from './usage.mjs';

export const developmentCallLimit = 1024 * 1024;
const storeLimit = 64 * developmentCallLimit;
const recordName = /^(\d{4}-\d{2}-\d{2})-(?:chatcmpl|img|resp)_[a-f0-9]{16}\.json$/;
const sensitiveKey = /^(?:authorization|proxy-authorization|set-cookie|cookies?|password|passwd|api[-_]?key|x-api-key|secret|(?:access|refresh|auth|session|id)[-_]?token|token|credential(?:s)?|signature|private[-_]?key)$/i;
const tokenText = /\b(?:md_(?:key|admin|session|console)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|[Bb]earer\s+[A-Za-z0-9._+/-]+=*|[Bb]asic\s+[A-Za-z0-9+/]+=*)\b/g;
const privatePathText = /(?:file:\/\/)?(?:\/(?:Users|home|private\/var|var\/folders)\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/gi;
const assignment = /((?:api[-_ ]?key|password|authorization|secret|access[-_ ]?token|refresh[-_ ]?token|cookie|signature|x-amz-signature|x-amz-credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi;

function redactText(value, secrets, paths) {
  let result = value;
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]');
  for (const privatePath of paths) if (privatePath) result = result.replaceAll(privatePath, '[private path]');
  return result.replace(tokenText, '[redacted]').replace(assignment, '$1[redacted]')
    .replace(privatePathText, '[private path]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}

function redactValue(value, secrets, paths, depth = 0) {
  if (depth > 80) throw new Error('capture_depth');
  if (typeof value === 'string') return redactText(value, secrets, paths);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets, paths, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets, paths),
      sensitiveKey.test(key) ? '[redacted]' : redactValue(item, secrets, paths, depth + 1)]));
  }
  return value;
}

export function safeAuditId(value, secrets = []) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(id)
    || /^(?:md_(?:key|admin|session|console)_|sk-)/i.test(id)
    || secrets.some(secret => secret && id.includes(secret))) return null;
  return id;
}

export class DevelopmentCapture {
  constructor(secrets = [], directory) {
    this.secrets = secrets.filter(Boolean);
    this.paths = [directory, os.homedir(), os.tmpdir()].filter(Boolean).sort((a, b) => b.length - a.length);
    this.size = 0;
    this.output = {};
    this.tools = new Map();
    this.reasoning = [];
  }

  reserve(value) {
    if (this.failure || value === undefined) return false;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return false;
      this.size += Buffer.byteLength(serialized);
    } catch { this.failure = 'invalid_payload'; return false; }
    if (this.size > developmentCallLimit) this.failure = 'payload_too_large';
    return !this.failure;
  }

  begin(input, secret) {
    if (secret) this.secrets.push(secret);
    if (this.reserve(input)) this.input = input;
  }

  response(value) {
    if (this.reserve(value)) this.responseValue = value;
  }

  appendReasoning(text) {
    if ((typeof text === 'string' || Array.isArray(text)) && this.reserve(text)) this.reasoning.push(text);
  }

  delta(value) {
    if (!value || !this.reserve(value)) return;
    for (const key of ['content', 'refusal']) {
      if (typeof value[key] === 'string') (this.output[key] ??= []).push(value[key]);
    }
    for (const key of ['reasoning', 'reasoning_content', 'thinking']) {
      if (typeof value[key] === 'string') this.reasoning.push(value[key]);
    }
    if (!Array.isArray(value.tool_calls)) return;
    for (const [index, call] of value.tool_calls.entries()) {
      if (!call || typeof call !== 'object') continue;
      const id = Number.isSafeInteger(call.index) ? call.index : index;
      if (!this.tools.has(id)) this.tools.set(id, { id: [], name: [], arguments: [] });
      const tool = this.tools.get(id);
      for (const key of ['id', 'name', 'arguments']) {
        const part = key === 'id' ? call.id : call.function?.[key];
        if (typeof part === 'string') tool[key].push(part);
      }
    }
  }

  snapshot() {
    if (this.failure) return { status: 'failed', reason: this.failure };
    const text = Object.fromEntries(Object.entries(this.output).map(([key, parts]) => [key, parts.join('')]));
    const tools = [...this.tools.values()].map(tool => Object.fromEntries(Object.entries(tool).map(([key, parts]) => [key, parts.join('')])));
    if (tools.length) text.tool_calls = tools;
    const reasoning = this.reasoning.every(part => typeof part === 'string') ? this.reasoning.join('') : this.reasoning;
    const parts = { input: this.input, output: this.responseValue ?? (Object.keys(text).length ? text : undefined),
      reasoning: this.reasoning.length ? reasoning : undefined };
    try {
      const payload = redactValue(parts, this.secrets, this.paths);
      if (Buffer.byteLength(JSON.stringify(payload)) > developmentCallLimit) return { status: 'failed', reason: 'payload_too_large' };
      if (Object.values(payload).every(value => value === undefined)) return { status: 'unavailable' };
      return { status: 'captured', payload };
    } catch { return { status: 'failed', reason: 'invalid_payload' }; }
  }
}

export class UsageDevelopment {
  constructor(directory, enabled) {
    this.directory = path.join(directory, 'usage-development');
    this.enabled = enabled;
    this.queue = Promise.resolve();
  }

  async prepare(now = Date.now()) {
    const day = localDay(now);
    if (day === this.preparedDay) return;
    const from = localDay(now, 1 - retentionDays);
    const files = await fs.readdir(this.directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let size = 0;
    for (const file of files) {
      const match = file.isFile() && recordName.exec(file.name);
      if (!match) continue;
      const filename = path.join(this.directory, file.name);
      if (match[1] < from) await fs.rm(filename, { force: true });
      else size += (await fs.stat(filename)).size;
    }
    this.size = size;
    this.preparedDay = day;
  }

  record(row, capture) {
    const action = this.queue.then(async () => {
      if (!this.enabled || !capture) return undefined;
      try {
        const snapshot = capture.snapshot();
        if (snapshot.status !== 'captured') return snapshot;
        await this.prepare();
        const name = `${localDay(row.finishedAt)}-${row.id}.json`;
        if (!recordName.test(name)) return { status: 'failed', reason: 'invalid_payload' };
        const data = snapshot.payload;
        // Account for the same format written to disk by writePrivateJson.
        const size = Buffer.byteLength(JSON.stringify(data, null, 2)) + 1;
        if (this.size + size > storeLimit) return { status: 'failed', reason: 'capacity' };
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await fs.chmod(this.directory, 0o700);
        await writePrivateJson(path.join(this.directory, name), data);
        this.size += size;
        return { status: 'captured', parts: Object.keys(data).filter(key => data[key] !== undefined), size };
      } catch { return { status: 'failed', reason: 'storage' }; }
    });
    this.queue = action.catch(() => {});
    return action;
  }

  async get(row) {
    if (!this.enabled) throw new GatewayError('Development capture is disabled.', 404, 'usage_development_disabled');
    if (row.audit?.development?.status !== 'captured') {
      throw new GatewayError('No development details were captured for this call.', 404, 'usage_development_missing');
    }
    const name = `${localDay(row.finishedAt)}-${row.id}.json`;
    if (!recordName.test(name)) throw new GatewayError('No development details were captured for this call.', 404, 'usage_development_missing');
    try {
      return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
    } catch { throw new GatewayError('No development details were captured for this call.', 404, 'usage_development_missing'); }
  }
}
