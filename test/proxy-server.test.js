import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { ProxyServer } from '../lib/proxy-server.js'

// Helper: create mock upstream API
function createMockUpstream(responseBody, statusCode = 200, extraHeaders = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        const headers = {
          'content-type': 'application/json',
          ...extraHeaders,
        }
        res.writeHead(statusCode, headers)
        res.end(JSON.stringify(responseBody))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: create SSE streaming mock upstream
function createMockStreamingUpstream() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const chunks = [
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ' World' } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]
        let i = 0
        const send = () => {
          if (i < chunks.length) {
            res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
            i++
            setTimeout(send, 10)
          } else {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        }
        send()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Helper: make request to proxy
function makeRequest(port, body, method = 'POST', path = '/v1/chat/completions') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let responseBody = ''
      res.on('data', chunk => responseBody += chunk)
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody })
      })
    })
    req.on('error', reject)
    if (method === 'POST') req.write(data)
    req.end()
  })
}

// Helper: make streaming request
function makeStreamRequest(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, stream: true })
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk.toString()))
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, chunks }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('ProxyServer', () => {
  const cleanups = []

  after(async () => {
    for (const fn of cleanups) await fn()
  })

  it('forwards JSON request and strips rate limit headers', async () => {
    const upstream = await createMockUpstream(
      { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      200,
      { 'x-ratelimit-remaining': '99', 'x-ratelimit-limit': '100' }
    )
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'test-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'test-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    assert.ok(!res.headers['x-ratelimit-remaining'], 'Rate limit headers should be stripped')
    const parsed = JSON.parse(res.body)
    assert.ok(parsed.choices)
  })

  it('streams SSE without buffering', async () => {
    const upstream = await createMockStreamingUpstream()
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'stream-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'stream-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeStreamRequest(port, { model: 'stream-model', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
    const allData = res.chunks.join('')
    assert.ok(allData.includes('Hello'), 'Should contain streamed content')
    assert.ok(allData.includes('[DONE]'), 'Should contain DONE marker')
  })

  it('rotates to next account on 429', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '60' })
    const good = await createMockUpstream({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    cleanups.push(() => bad.server.close(), () => good.server.close())

    const accounts = [
      { id: 'bad-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
      { id: 'good-acct', providerKey: 'p2', apiKey: 'k2', modelId: 'm2', url: good.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 200)
  })

  it('returns 503 when all accounts exhausted', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429)
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'only-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 1 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })

  it('serves GET /v1/models', async () => {
    const upstream = await createMockUpstream({})
    cleanups.push(() => upstream.server.close())

    const accounts = [{
      id: 'models-acct', providerKey: 'test', apiKey: 'key-1',
      modelId: 'cool-model', url: upstream.url + '/v1',
    }]
    const proxy = new ProxyServer({ port: 0, accounts })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    const res = await makeRequest(port, null, 'GET', '/v1/models')
    assert.strictEqual(res.statusCode, 200)
    const parsed = JSON.parse(res.body)
    assert.ok(Array.isArray(parsed.data), 'Should return models array')
  })

  it('respects retry-after', async () => {
    const bad = await createMockUpstream({ error: 'rate limited' }, 429, { 'retry-after': '3600' })
    cleanups.push(() => bad.server.close())

    const accounts = [
      { id: 'retry-acct', providerKey: 'p1', apiKey: 'k1', modelId: 'm1', url: bad.url + '/v1' },
    ]
    const proxy = new ProxyServer({ port: 0, accounts, retries: 2 })
    const { port } = await proxy.start()
    cleanups.push(() => proxy.stop())

    // First request triggers 429 and sets retry-after
    await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    // Second request should fail immediately (account in retry-after)
    const res = await makeRequest(port, { model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(res.statusCode, 503)
  })
})
