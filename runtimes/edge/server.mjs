import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { serviceToken } from '../service-settings.mjs'

const execute = promisify(execFile)
const worker = join(import.meta.dirname, 'speech.py')

function runEdgeTts(python, args, signal) {
  return execute(python, [worker, ...args], { signal, timeout: 180_000, maxBuffer: 16 * 1024 })
}

function safeEdgeFailure(stderr) {
  const prefix = 'EDGE_TTS_ERROR:'
  const frames = String(stderr || '').split(/\r?\n/).filter(line => line.startsWith(prefix))
  if (frames.length !== 1) return null
  try {
    const { kind, providerOutcomeKnown, status } = JSON.parse(frames[0].slice(prefix.length))
    return providerOutcomeKnown === true && ['runtime-outdated', 'connection-failed', 'handshake-rejected'].includes(kind) &&
      (status === null || Number.isInteger(status)) ? { kind, providerOutcomeKnown, status } : null
  } catch { return null }
}

export function createEdgeService({ python, token, workspaceId, run = runEdgeTts }) {
  const knownToken = Buffer.from('Bearer ' + token)
  let running = 0
  return http.createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    const presented = Buffer.from(request.headers.authorization || '')
    if (presented.length !== knownToken.length || !timingSafeEqual(presented, knownToken)) {
      return send(401, { error: { code: 'unauthorized' } })
    }
    const check = request.method === 'GET' && request.url === '/health'
    if (!check && (request.method !== 'POST' || request.url !== '/v1/audio/speech-with-timestamps')) {
      return send(404, { error: { code: 'not_found' } })
    }
    if (running >= 2) return send(429, { error: { code: 'connection_busy' } })
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    let directory
    running++
    try {
      if (check) {
        await run(python, ['check'], controller.signal)
        return send(200, { ready: true, provider: 'edge-tts', model: 'edge-tts', workspaceId, pid: process.pid })
      }
      const chunks = []
      let size = 0
      for await (const part of request.iterator({ destroyOnReturn: false })) {
        size += part.length
        if (size > 32 * 1024) return send(413, { error: { code: 'request_too_large' } })
        chunks.push(part)
      }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { input = null }
      if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
          !['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'].includes(input.voice) ||
          !Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) {
        return send(422, { error: { code: 'invalid_request' } })
      }
      directory = await mkdtemp(join(tmpdir(), 'model-dock-edge-'))
      const source = join(directory, 'input.json'), destination = join(directory, 'speech.mp3'), timing = join(directory, 'timing.json')
      await writeFile(source, JSON.stringify({ text: input.text, voice: input.voice, speed: input.speed }), { mode: 0o600 })
      await run(python, [source, destination, timing], controller.signal)
      const result = await stat(destination)
      if (result.size <= 0 || result.size > 12 * 1024 * 1024) throw new Error('Invalid speech output')
      const words = JSON.parse(await readFile(timing, 'utf8')).words
      return send(200, { audio: (await readFile(destination)).toString('base64'), words })
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = safeEdgeFailure(error.stderr)
        send(502, { error: { code: 'edge_tts_failed', ...(detail && { detail }) } })
      }
    } finally {
      running--
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, portValue, workspaceId] = process.argv.slice(2)
  const port = Number(portValue)
  try {
    if (!root || !isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535 || !workspaceId) {
      throw new Error('Invalid Edge TTS runtime configuration.')
    }
    createEdgeService({ python: join(root, 'venv', 'bin', 'python'), token: serviceToken(root), workspaceId })
      .listen(port, '127.0.0.1')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
