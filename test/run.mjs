/**
 * Offline suite for dsh-net-stable. Starts local HTTP servers and asserts the
 * retry/mirror/cap behaviour; never touches the public network.
 *
 *   node test/run.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { createFetcher, classifyFailure, normalizeSettings, planCandidates, DEFAULTS } from '../src/core.js'
import { diagnose, formatReport, proxyEnvironment } from '../src/doctor.js'
import { createJournal, formatJournal } from '../src/journal.js'
import { WebError } from '../src/errors.js'

const results = []
function test(name, fn) {
  results.push({ name, fn })
}

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

const settingsFor = overrides => normalizeSettings({ ...DEFAULTS, perAttemptTimeoutMs: 5_000, totalBudgetMs: 15_000, retryDelayMs: 10, ...overrides })

test('retries a connection reset and then succeeds', async () => {
  let hits = 0
  const server = await startServer((req, res) => {
    hits += 1
    if (hits === 1) { req.socket.destroy(); return }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('second try')
  })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    const { result, attempts } = await fetcher.fetchWithFallback(`${server.url}/x`, settingsFor({ retries: 2 }))
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.content, 'second try')
    assert.equal(result.body.kind, 'text')
    assert.ok(attempts.length >= 2, `expected >=2 attempts, got ${attempts.length}`)
  } finally { await server.close() }
})

test('falls through to a mirror route when the origin keeps failing', async () => {
  const origin = await startServer((_req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down') })
  const mirror = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('from mirror') })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    const settings = settingsFor({
      retries: 0,
      extraMirrors: [{ match: '^http://origin\\.test/(.*)$', to: `${mirror.url}/$1` }],
    })
    // The origin host resolves nowhere, so the resolver is exercised through a
    // real local origin instead: use a host that refuses instantly.
    const { result, attempts } = await fetcher.fetchWithFallback('http://origin.test/file.txt', settings)
    assert.equal(result.body.content, 'from mirror')
    assert.ok(attempts.some(entry => entry.via === 'custom' && entry.ok), 'custom mirror was not used')
  } finally { await origin.close(); await mirror.close() }
})

test('keeps the last HTTP response when no route succeeds', async () => {
  const origin = await startServer((_req, res) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('bad gateway') })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    const { result } = await fetcher.fetchWithFallback(`${origin.url}/y`, settingsFor({ retries: 1 }))
    assert.equal(result.statusCode, 502)
    assert.equal(result.body.content, 'bad gateway')
  } finally { await origin.close() }
})

test('plans mirror routes for a raw.githubusercontent.com URL', () => {
  const settings = normalizeSettings({})
  const candidates = planCandidates('https://raw.githubusercontent.com/owner/repo/main/docs/a.md', settings)
  const vias = candidates.map(entry => entry.via)
  assert.deepEqual(vias.slice(0, 2), ['origin', 'ghproxy'])
  assert.ok(candidates.some(entry => entry.url === 'https://cdn.jsdelivr.net/gh/owner/repo@main/docs/a.md'))
  const contents = candidates.find(entry => entry.via === 'contents-api')
  assert.equal(contents.decode, 'contents')
  assert.equal(contents.url, 'https://api.github.com/repos/owner/repo/contents/docs/a.md?ref=main')
})

test('plans a raw route for github.com/.../raw/... and reverses jsDelivr', () => {
  const settings = normalizeSettings({})
  const fromBlob = planCandidates('https://github.com/owner/repo/raw/main/a.txt', settings)
  assert.ok(fromBlob.some(entry => entry.via === 'ghproxy'
    && entry.url === 'https://ghproxy.net/https://raw.githubusercontent.com/owner/repo/main/a.txt'))
  const fromJsdelivr = planCandidates('https://cdn.jsdelivr.net/gh/owner/repo@v1/a.txt', settings)
  assert.ok(fromJsdelivr.some(entry => entry.via === 'ghproxy'))
})

test('honours the byte and character caps', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('x'.repeat(20_000))
  })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    const { result } = await fetcher.fetchWithFallback(`${server.url}/big`, settingsFor({ maxBodyChars: 1_000 }))
    assert.equal(result.truncated, true)
    assert.equal(result.body.content.length, 1_000)
  } finally { await server.close() }
})

test('rejects an undecodable content type', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.from([0, 1, 2, 3]))
  })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    await assert.rejects(
      () => fetcher.fetchWithFallback(`${server.url}/bin`, settingsFor({})),
      error => error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
    )
  } finally { await server.close() }
})

test('decodes a contents-API payload to text', async () => {
  const payload = JSON.stringify({ encoding: 'base64', content: Buffer.from('# hello\nworld\n').toString('base64') })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(payload)
  })
  try {
    const fetcher = createFetcher({ WebError, undici: null })
    const settings = settingsFor({
      retries: 0,
      extraMirrors: [{ match: '^http://contents\\.test/.*$', to: `${server.url}/api`, decode: 'contents' }],
    })
    const { result } = await fetcher.fetchWithFallback('http://contents.test/file', settings)
    assert.equal(result.body.content, '# hello\nworld\n')
    assert.equal(result.statusCode, 200)
  } finally { await server.close() }
})

test('reports the whole attempt ladder when every route fails', async () => {
  const fetcher = createFetcher({ WebError, undici: null })
  const settings = settingsFor({ retries: 1, perAttemptTimeoutMs: 1_000, totalBudgetMs: 3_000 })
  await assert.rejects(
    () => fetcher.fetchWithFallback('http://127.0.0.1:1/nope', settings),
    error => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /no route worked/)
      assert.match(error.message, /attempt\(s\)/)
      assert.ok(Array.isArray(error.attempts) && error.attempts.length >= 2, 'the thrown error must carry its attempt ladder')
      return true
    },
  )
})

test('classifies a reset buried in the cause chain as retryable', () => {
  const error = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
  assert.deepEqual(classifyFailure(error), { code: 'ECONNRESET', retryable: true })
  assert.equal(classifyFailure(new Error('nope')).retryable, false)
  assert.equal(classifyFailure(Object.assign(new Error('socket hang up'), { code: 'EPIPE' })).retryable, true)
  assert.equal(classifyFailure(Object.assign(new Error('x'), { code: 'EACCES' })).retryable, false)
})

test('net_doctor reports an HTTP 200 for a local page', async () => {
  const server = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>') })
  try {
    const report = await diagnose(`${server.url}/page`, {
      settings: normalizeSettings({ userAgent: 'dsh-net-stable-test/1.0' }),
      deps: { fetch: globalThis.fetch },
      timeoutMs: 3_000,
    })
    assert.equal(report.dns.ok, true)
    assert.equal(report.viaProxyPath.ok, true)
    assert.equal(report.viaProxyPath.status, 200)
    const text = formatReport(report)
    assert.match(text, /net_doctor http:\/\/127\.0\.0\.1:/)
    assert.match(text, /HTTP 200/)
    assert.match(text, /verdict/)
  } finally { await server.close() }
})

test('net_doctor explains a refused connection instead of throwing', async () => {
  const report = await diagnose('http://127.0.0.1:1/x', {
    settings: normalizeSettings({}),
    deps: { fetch: globalThis.fetch },
    timeoutMs: 1_500,
  })
  const text = formatReport(report)
  assert.equal(report.dns.ok, true)
  assert.equal(report.viaProxyPath.ok, false)
  assert.match(text, /FAILED/)
})

test('renames proxy credentials out of the report', () => {
  const masked = proxyEnvironment({ HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890', NO_PROXY: 'localhost' })
  assert.deepEqual(masked, ['HTTPS_PROXY=http://***:***@127.0.0.1:7890/', 'NO_PROXY=localhost'])
})

test('journal keeps the newest entries first and aggregates totals', () => {
  const journal = createJournal(3)
  journal.record({ url: 'https://a.test/1', status: 200, ms: 10, attempts: 1 })
  journal.record({ url: 'https://a.test/2', finalUrl: 'https://ghproxy.net/x', via: 'ghproxy', status: 200, ms: 20, attempts: 4 })
  journal.record({ url: 'https://a.test/3', error: 'WEB_PROVIDER_ERROR', ms: 30, attempts: 3 })
  journal.record({ url: 'https://a.test/4', status: 404, ms: 40, attempts: 1 })
  const recent = journal.recent(10)
  assert.equal(recent.length, 3, 'ring buffer must drop the oldest entry')
  assert.equal(recent[0].url, 'https://a.test/4')
  assert.equal(recent[2].url, 'https://a.test/2')
  assert.deepEqual(journal.stats(), { total: 3, ok: 1, httpError: 1, transportError: 1, mirrored: 1 })

  const text = formatJournal({
    journal,
    engine: { undici: true },
    settings: normalizeSettings({}),
    proxy: ['HTTPS_PROXY=http://127.0.0.1:7890'],
  })
  assert.match(text, /3\. totals\s+3 recorded, 1 ok, 1 http-error \(4xx\/5xx\), 1 transport-failure, 1 via mirror/)
  assert.match(text, /HTTP 404 origin/)
  assert.match(text, /answered by https:\/\/ghproxy\.net\/x/)
  assert.match(text, /FAIL WEB_PROVIDER_ERROR/)
})

test('journal report explains an empty run instead of printing nothing', () => {
  const text = formatJournal({
    journal: createJournal(),
    engine: { undici: false, reason: 'bare import: ERR_MODULE_NOT_FOUND' },
    settings: normalizeSettings({}),
    proxy: [],
  })
  assert.match(text, /undici=missing \(bare import/)
  assert.match(text, /no fetch has run in this process yet/)
})

const failures = []
for (const entry of results) {
  try {
    await entry.fn()
    console.log(`ok   ${entry.name}`)
  } catch (error) {
    failures.push(entry.name)
    console.log(`FAIL ${entry.name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`)
  }
}
console.log(`\n${results.length - failures.length}/${results.length} passed`)
if (failures.length > 0) process.exitCode = 1
