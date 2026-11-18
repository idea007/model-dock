import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setup } from './helpers.mjs'

const directory = fileURLToPath(new URL('../runtimes/greyscope/', import.meta.url))

test('Greyscope CLI accepts lifecycle commands for its pinned engine', () => {
  const cli = fileURLToPath(new URL('../apps/gateway/cli.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'greyscope', 'health', '--engine', 'aigc-zh-v3'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^model-dock greyscope <setup\|start\|stop\|restart\|health>/)
  assert.doesNotMatch(result.stderr, /aigc-zh-v3|\bat .*\.mjs/)
})

test('分段器完整覆盖 Unicode 原文，每段满足分词上限，超长和损坏输入被拒绝', () => {
  const script = String.raw`
import sys
sys.path.insert(0, sys.argv[1])
from text_processing import split_text, validate_text
class Tokenizer:
    def encode(self, text, add_special_tokens=True):
        return list(text) + [0] * 64
for text in ['段落。\n' * 600, '字' * 2200, '🙂日本語' * 1000, 'plain text ' * 600]:
    ranges = list(split_text(text, Tokenizer(), 2048))
    assert ''.join(text[start:end] for start, end in ranges) == text
    assert all(len(Tokenizer().encode(text[start:end])) <= 2048 for start, end in ranges)
    assert all(right[0] == left[1] for left, right in zip(ranges, ranges[1:]))
for invalid in ['', ' ', '字' * 60001, '\ud800']:
    try:
        validate_text(invalid)
        raise AssertionError('accepted invalid text')
    except ValueError:
        pass
`
  const result = spawnSync('python3', ['-c', script, directory], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('独立服务验证授权、输入和执行容量，繁忙与执行失败均释放名额', async t => {
  const script = String.raw`
import sys,time
sys.path.insert(0, sys.argv[1])
from server import create_server
class FixtureDetector:
    engine = 'greyscope-v2-mlx-q4'
    revision = 'fixture-revision'
    def detect(self, text, cancelled):
        time.sleep(0.15)
        if text == 'fail':
            raise RuntimeError('private-error-fixture')
        return {'fixture': True, 'cancelled': cancelled()}
server = create_server(('127.0.0.1', 0), FixtureDetector(), 'detector-fixture-token-1234567890123456')
print(server.server_port, flush=True)
server.serve_forever()
`
  const child = spawn('python3', ['-u', '-c', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}) })
  const reader = createInterface({ input: child.stdout })
  const [line] = await once(reader, 'line')
  const origin = `http://127.0.0.1:${Number(line)}`
  const request = (text, token = 'detector-fixture-token-1234567890123456') => fetch(origin + '/v1/detect', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ text, engine: 'greyscope-v2-mlx-q4' }), signal: AbortSignal.timeout(3000)
  })
  assert.equal((await fetch(origin + '/health')).status, 401)
  assert.equal((await fetch(origin + '/health', { headers: { authorization: 'Bearer detector-fixture-token-1234567890123456' } })).status, 200)
  assert.equal((await request('fixture', 'wrong')).status, 401)
  assert.equal((await request('')).status, 422)
  const responses = await Promise.all([request('fixture'), request('fixture')])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429])
  for (const response of responses) await response.body.cancel()
  const failed = await request('fail')
  assert.equal(failed.status, 503)
  assert.doesNotMatch(await failed.text(), /private-error-fixture/)
  assert.equal((await request('fixture')).status, 200)
})

test('Greyscope is a loopback-only service scoped to authorized projects without draft capture', async t => {
  const input = { engine: 'greyscope-v2-mlx-q4', text: 'Private draft fixture' }
  const serviceToken = 'synthetic-detector-secret'
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const safe = request.headers.authorization === 'Bearer ' + serviceToken
    const detection = request.method === 'POST' && request.url === '/v1/detect'
    const result = detection ? { protocol: 'text-detection.result.v1', inputMatches: Buffer.concat(chunks).toString() === JSON.stringify(input) }
      : { ready: true }
    response.writeHead(safe ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const app = await setup(t, { developmentDetails: true })
  const settings = { name: 'Greyscope', type: 'service', service: 'greyscope', apiKey: serviceToken }
  assert.equal((await app.mutate('/admin/connections', 'POST', { ...settings, baseUrl: 'https://remote.example/v1' })).status, 400)
  const created = await app.mutate('/admin/connections', 'POST', { ...settings, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })
  assert.equal(created.status, 200)
  assert.equal((await app.mutate(`/admin/connections/${created.data.id}/discover`, 'POST')).status, 200)
  const deployment = `${created.data.id}/greyscope`
  await app.enable(deployment)
  const { data: project } = await app.mutate('/admin/keys', 'POST', { name: 'Writer', models: [deployment] })
  const endpoint = `/v1/services/${encodeURIComponent(deployment)}`
  assert.equal((await app.request(endpoint + '/detect', 'POST', input, '')).status, 401)
  assert.equal((await app.request(endpoint + '/health', 'GET', undefined, project.token)).status, 200)
  assert.equal((await app.request(endpoint + '/chat/completions', 'POST', input, project.token)).status, 404)
  const result = await app.request(endpoint + '/detect', 'POST', input, project.token)
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { protocol: 'text-detection.result.v1', inputMatches: true })
  const { data: catalog } = await app.request('/v1/project/models', 'GET', undefined, project.token)
  assert.ok(catalog.data.some(model => model.deployment_id === deployment && model.native_model === input.engine && model.task === 'text_detection'))
  const requestId = result.response.headers.get('x-model-dock-request-id')
  const development = await app.request(`/admin/usage/development/${requestId}`)
  assert.equal(development.status, 404)
  assert.equal(development.data.error.code, 'usage_development_missing')
})
