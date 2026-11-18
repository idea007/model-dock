#!/usr/bin/env node
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { serviceToken } from '../service-settings.mjs'
import { modelReady, readLtxRegistration, registry } from './installation.mjs'

const MAX_REQUEST_BYTES = 42 * 1024 * 1024
const scriptDir = import.meta.dirname

function json(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(body)
}

function failure(response, code, statusCode) {
  json(response, statusCode, { error: { code } })
}

function timingSafeEqual(value, expected) {
  const left = Buffer.from(String(value || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function validateVideoPayload(value) {
  const allowed = [
    'model', 'prompt', 'width', 'height', 'num_frames', 'fps', 'seed',
    'reference_images'
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TypeError('REQUEST_INVALID')
  }
  if (!Object.hasOwn(registry.models, value.model)) throw new TypeError('MODEL_UNSUPPORTED')
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4000) {
    throw new TypeError('PROMPT_INVALID')
  }
  if (![[512, 320], [320, 512], [768, 448], [448, 768]].some(([width, height]) => (
    value.width === width && value.height === height
  ))) throw new TypeError('SIZE_INVALID')
  if (value.num_frames !== 97 || value.fps !== 24 ||
    !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    throw new TypeError('PROFILE_INVALID')
  }
  const refs = value.reference_images ?? []
  if (!Array.isArray(refs) || refs.length > 1) throw new TypeError('REFERENCE_INVALID')
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith('data:image/') ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref)) {
      throw new TypeError('REFERENCE_INVALID')
    }
    const bytes = Buffer.from(ref.split(',', 2)[1], 'base64')
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) {
      throw new TypeError('REFERENCE_INVALID')
    }
  }
  return { ...value, prompt: value.prompt.trim(), reference_images: refs }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error(), { code: 'REQUEST_TOO_LARGE' })
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function publicStatus(status) {
  return {
    id: status.id,
    model: status.model,
    phase: status.phase || '',
    status: status.status,
    ...(status.errorCode ? { error: { code: status.errorCode } } : {}),
    ...(status.status === 'succeeded'
      ? { usage: { output_seconds: 97 / 24, generated_videos: 1 } }
      : {})
  }
}

function jobDirectory(jobsRoot, id) {
  if (!/^ltx-[0-9a-f-]{36}$/.test(id)) return ''
  return path.join(jobsRoot, id)
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function currentStatus(directory) {
  const file = path.join(directory, 'status.json')
  const status = readJson(file)
  if (['queued', 'running'].includes(status.status) && !processAlive(status.pid)) {
    const failed = { ...status, errorCode: 'WORKER_EXITED', phase: 'failed', status: 'failed' }
    atomicWrite(file, failed)
    return failed
  }
  return status
}

export async function cancelVideoJob(directory, ports = {}) {
  const alive = ports.alive || processAlive
  const signal = ports.signal || (pid => process.kill(pid, 'SIGTERM'))
  const wait = ports.wait || (() => new Promise(resolve => setTimeout(resolve, 100)))
  const statusFile = path.join(directory, 'status.json')
  const status = readJson(statusFile)
  if (['succeeded', 'failed', 'cancelled'].includes(status.status)) return status
  if (alive(status.pid)) {
    atomicWrite(statusFile, { ...status, phase: 'cancelling', status: 'running' })
    try { signal(status.pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
    for (let attempt = 0; attempt < 20 && alive(status.pid); attempt++) await wait()
    if (alive(status.pid)) return { ...status, phase: 'cancelling', status: 'running' }
  }
  const stopped = { ...status, errorCode: 'CANCELLED', phase: 'cancelled', status: 'cancelled' }
  atomicWrite(statusFile, stopped)
  return stopped
}

function activeJobCount(jobsRoot) {
  try {
    return readdirSync(jobsRoot, { withFileTypes: true }).filter(entry => {
      if (!entry.isDirectory() || !/^ltx-[0-9a-f-]{36}$/.test(entry.name)) return false
      try {
        return ['queued', 'running'].includes(currentStatus(path.join(jobsRoot, entry.name)).status)
      } catch { return false }
    }).length
  } catch { return 0 }
}

function saveReference(directory, dataUrl) {
  const header = dataUrl.slice(0, dataUrl.indexOf(','))
  const extension = header.includes('/png') ? 'png' : header.includes('/webp') ? 'webp' : 'jpg'
  const target = path.join(directory, `first-frame.${extension}`)
  writeFileSync(target, Buffer.from(dataUrl.split(',', 2)[1], 'base64'), {
    flag: 'wx', mode: 0o600
  })
  return target
}

function operationId(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(key)) {
    throw Object.assign(new Error('IDEMPOTENCY_KEY_INVALID'), { code: 'IDEMPOTENCY_KEY_INVALID' })
  }
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)
  return `ltx-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`
}

export function readVideoOperation(settings, key) {
  const directory = path.join(settings.jobsRoot, operationId(key))
  if (!existsSync(directory)) return null
  if (!existsSync(path.join(directory, 'status.json'))) {
    throw Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN' })
  }
  return publicStatus(currentStatus(directory))
}

export function createJob(payload, settings, key) {
  const id = key ? operationId(key) : `ltx-${crypto.randomUUID()}`
  const directory = path.join(settings.jobsRoot, id)
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    payload.model, payload.prompt, payload.width, payload.height,
    payload.num_frames, payload.fps, payload.seed, payload.reference_images
  ])).digest('hex')
  if (key && existsSync(directory)) {
    if (!existsSync(path.join(directory, 'receipt.json'))) {
      throw Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN' })
    }
    if (readJson(path.join(directory, 'receipt.json')).fingerprint !== fingerprint) {
      throw Object.assign(new Error('IDEMPOTENCY_CONFLICT'), { code: 'IDEMPOTENCY_CONFLICT' })
    }
    return readVideoOperation(settings, key)
  }
  // Reserve the identity before any external work. A partial reservation is never replayed.
  mkdirSync(directory, { mode: 0o700 })
  atomicWrite(path.join(directory, 'receipt.json'), { fingerprint })
  const source = path.join(directory, 'execution-source')
  mkdirSync(source, { recursive: true, mode: 0o700 })
  copyFileSync(
    path.join(scriptDir, 'worker.py'),
    path.join(source, 'local-video-worker.py'),
    constants.COPYFILE_EXCL
  )
  copyFileSync(
    path.join(scriptDir, 'memory.py'),
    path.join(source, 'local_video_memory.py'),
    constants.COPYFILE_EXCL
  )
  const request = {
    ...payload,
    reference_images: payload.reference_images.map(dataUrl => saveReference(directory, dataUrl))
  }
  const model = registry.models[payload.model]
  const job = {
    id,
    model: payload.model,
    modelSettings: model,
    request,
    runtime: {
      gemmaDir: path.join(settings.modelsRoot, registry.gemma.directory),
      modelDir: path.join(settings.modelsRoot, model.directory),
      runtimeRevision: registry.runtimeRevision,
      software: registry.software
    }
  }
  atomicWrite(path.join(directory, 'job.json'), job)
  atomicWrite(path.join(directory, 'status.json'), {
    id, model: payload.model, phase: 'queued', pid: 0, status: 'queued'
  })
  const ignored = openSync('/dev/null', 'a')
  let child
  try {
    child = (settings.spawnProcess || spawn)(settings.pythonExecutable, [
      '-u', path.join(source, 'local-video-worker.py'),
      '--job', path.join(directory, 'job.json')
    ], {
      detached: true,
      env: {
        HOME: process.env.HOME,
        HF_HOME: process.env.HF_HOME,
        HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HUB_OFFLINE: '1',
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        TOKENIZERS_PARALLELISM: 'false',
        TRANSFORMERS_OFFLINE: '1'
      },
      stdio: ['ignore', ignored, ignored]
    })
    child.once('error', () => {}) // A failed spawn has no PID for this reserved operation.
    if (!child.pid) {
      const failed = { id, model: payload.model, phase: 'failed', status: 'failed', errorCode: 'WORKER_START_FAILED' }
      atomicWrite(path.join(directory, 'status.json'), failed)
      return publicStatus(failed)
    }
    atomicWrite(path.join(directory, 'status.json'), { id, model: payload.model, phase: 'queued', pid: child.pid, status: 'queued' })
    child.unref()
  } finally {
    closeSync(ignored)
  }
  return { id, model: payload.model, status: 'queued' }
}

export function createLocalVideoServer(settings) {
  mkdirSync(settings.jobsRoot, { recursive: true, mode: 0o700 })
  const availableModels = () => settings.modelIds.filter(id => modelReady(settings.modelsRoot, id))
  return http.createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${settings.port}`
    if (request.headers.host !== expectedHost || request.headers.origin) {
      failure(response, 'ORIGIN_FORBIDDEN', 403); return
    }
    if (!timingSafeEqual(request.headers.authorization, `Bearer ${settings.token}`)) {
      failure(response, 'AUTH_REQUIRED', 401); return
    }
    const url = new URL(request.url || '/', `http://${expectedHost}`)
    const operation = /^\/v1\/video\/operations\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname)
    if (request.method === 'GET' && operation) {
      try {
        const status = readVideoOperation(settings, operation[1])
        if (!status) failure(response, 'OPERATION_NOT_FOUND', 404)
        else json(response, 200, status)
      } catch (error) { failure(response, error.code || 'OUTCOME_UNKNOWN', 409) }
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/manifest') {
      const models = availableModels().map(id => ({
        durations: [4],
        generateAudio: false,
        id,
        label: registry.models[id].label || id,
        maxReferenceImages: 1,
        modes: ['text-to-video', 'image-to-video'],
        outputMimeTypes: ['video/mp4'],
        promptMaxLength: 4_000,
        ratios: ['16:9', '9:16'],
        resolutions: ['768x448', '512x320']
      }))
      json(response, models.length ? 200 : 503, {
        capabilities: [{ id: 'video.generate', models }],
        protocol: 'cursorblinking-provider',
        protocolVersion: 1,
        service: {
          id: 'local-ltx',
          name: '本地 LTX 视频生成',
          version: '1.0.0'
        }
      })
      return
    }
    if (request.method === 'GET' && ['/health', '/v1/models'].includes(url.pathname)) {
      const data = availableModels().map(id => ({
        id, modes: ['text-to-video', 'image-to-video'],
        revision: registry.models[id].revision, status: 'ready'
      }))
      json(response, data.length ? 200 : 503, {
        data,
        protocolVersion: registry.protocolVersion,
        provider: registry.provider,
        status: data.length ? 'ready' : 'unavailable',
        workspaceId: settings.workspaceId,
        pid: process.pid
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/video/generations') {
      if (String(request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
        failure(response, 'CONTENT_TYPE_INVALID', 415); return
      }
      let payload
      try { payload = validateVideoPayload(await readBody(request)) } catch (error) {
        failure(response, error.code === 'REQUEST_TOO_LARGE' ? error.code : 'REQUEST_INVALID',
          error.code === 'REQUEST_TOO_LARGE' ? 413 : 422)
        return
      }
      const idempotencyKey = request.headers['idempotency-key']
      if (idempotencyKey) {
        try {
          if (readVideoOperation(settings, idempotencyKey)) {
            json(response, 200, createJob(payload, settings, idempotencyKey))
            return
          }
        } catch (error) {
          failure(response, error.code || 'OUTCOME_UNKNOWN', 409)
          return
        }
      }
      if (!settings.modelIds.includes(payload.model) || !modelReady(settings.modelsRoot, payload.model)) {
        failure(response, 'MODEL_NOT_READY', 503); return
      }
      if (activeJobCount(settings.jobsRoot) >= 4) {
        failure(response, 'BUSY', 429); return
      }
      try { json(response, 202, createJob(payload, settings, idempotencyKey)) } catch (error) {
        failure(response, error.code || 'WORKER_START_FAILED', error.code ? 409 : 503)
      }
      return
    }
    const match = url.pathname.match(/^\/v1\/video\/generations\/(ltx-[0-9a-f-]{36})(\/content)?$/)
    if (!match) { failure(response, 'NOT_FOUND', 404); return }
    const directory = jobDirectory(settings.jobsRoot, match[1])
    if (!directory || !existsSync(path.join(directory, 'status.json'))) {
      failure(response, 'TASK_NOT_FOUND', 404); return
    }
    if (request.method === 'GET' && match[2] === '/content') {
      const status = currentStatus(directory)
      const result = path.join(directory, 'result.mp4')
      if (status.status !== 'succeeded' || !existsSync(result)) {
        failure(response, 'RESULT_NOT_READY', 409); return
      }
      const stat = statSync(result)
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': String(stat.size),
        'content-type': 'video/mp4'
      })
      createReadStream(result).pipe(response)
      return
    }
    if (request.method === 'GET' && !match[2]) {
      json(response, 200, publicStatus(currentStatus(directory)))
      return
    }
    if (request.method === 'DELETE' && !match[2]) {
      try { json(response, 200, publicStatus(await cancelVideoJob(directory))) }
      catch { failure(response, 'CANCELLATION_UNCONFIRMED', 503) }
      return
    }
    failure(response, 'METHOD_NOT_ALLOWED', 405)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, portValue, workspaceId] = process.argv.slice(2)
    const port = Number(portValue)
    if (!root || !path.isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535 || !workspaceId) {
      throw new Error('Invalid LTX runtime configuration.')
    }
    const registration = readLtxRegistration(path.join(root, 'installation.json'))
    createLocalVideoServer({ ...registration, jobsRoot: path.join(root, 'jobs'), port, token: serviceToken(root), workspaceId })
      .listen(port, '127.0.0.1')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
