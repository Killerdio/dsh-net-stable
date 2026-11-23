/**
 * `net_doctor` diagnostics: run the same stages a curl user would — DNS, TCP,
 * TLS, HTTP — and say which stage fails, whether the proxy path or the direct
 * path is responsible, and which mirror routes exist for the URL.
 *
 * Uses only Node built-ins plus the fetch implementations the caller injects,
 * so it runs unchanged in tests.
 *
 * @module dsh-net-stable/doctor
 */

import { lookup } from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { planCandidates } from './core.js'

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    }),
  ])
}

/** Mask credentials embedded in a proxy URL. */
function maskProxy(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = url.username ? '***' : ''
      url.password = url.password ? '***' : ''
    }
    return url.toString()
  } catch {
    return value
  }
}

/** Collect the proxy environment this process actually inherits. */
export function proxyEnvironment(env = process.env) {
  const found = []
  for (const name of PROXY_VARS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') found.push(`${name}=${maskProxy(value.trim())}`)
  }
  return found
}

/** DNS answers with families, bounded by a timeout. */
export async function dnsStage(host, timeoutMs) {
  const started = Date.now()
  try {
    const addresses = await withTimeout(lookup(host, { all: true, verbatim: true }), timeoutMs, 'DNS lookup')
    return { ok: true, ms: Date.now() - started, addresses }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.code ?? error.message }
  }
}

/** Raw TCP connect to one address. */
export function tcpStage(address, port, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now()
    const socket = net.connect({ host: address, port })
    let settled = false
    const finish = entry => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ...entry, ms: Date.now() - started, address, port })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }))
    socket.once('error', error => finish({ ok: false, error: error.code ?? error.message }))
  })
}

/** TLS handshake details; a reset here means the wire, not the site, refused. */
export function tlsStage(host, address, port, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now()
    let settled = false
    const finish = entry => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve({ ...entry, ms: Date.now() - started })
    }
    const socket = tls.connect({ host: address, port, servername: host, rejectUnauthorized: false })
    socket.setTimeout(timeoutMs)
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() || {}
      finish({
        ok: true,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher() ? socket.getCipher().name : undefined,
        authorized: socket.authorized,
        subject: cert.subject ? cert.subject.CN : undefined,
        issuer: cert.issuer ? cert.issuer.O ?? cert.issuer.CN : undefined,
        validTo: cert.valid_to,
      })
    })
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }))
    socket.once('error', error => finish({ ok: false, error: error.code ?? error.message }))
  })
}

/** One HTTP probe with the given fetch implementation/dispatcher. */
export async function httpStage(url, { fetchImpl, dispatcher, userAgent, timeoutMs, maxBytes = 65_536 }) {
  const started = Date.now()
  let ttfb
  let status
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  try {
    // Without a dispatcher this is the proxy-aware path: the npm `undici` fetch
    // honors the dispatcher the harness proxy policy installed.
    const fetchFn = fetchImpl.undici ? fetchImpl.undici.fetch : fetchImpl.fetch
    const response = await fetchFn(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': userAgent, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: timeoutSignal,
      ...(dispatcher ? { dispatcher } : {}),
    })
    ttfb = Date.now() - started
    status = response.status
    const contentType = response.headers.get('content-type') ?? 'unknown'
    const declared = response.headers.get('content-length')
    let bytes = 0
    if (response.body !== null) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes >= maxBytes || timeoutSignal.aborted) { await reader.cancel().catch(() => {}); break }
      }
    } else if (declared !== null) {
      bytes = Number(declared) || 0
    }
    return { ok: true, status, contentType, bytes, ttfb, total: Date.now() - started }
  } catch (error) {
    if (timeoutSignal.aborted) {
      return { ok: false, error: 'ETIMEDOUT', ttfb, total: Date.now() - started }
    }
    const cause = error.cause && error.cause.code ? ` (${error.cause.code})` : ''
    return { ok: false, error: `${error.code ?? error.message}${cause}`, ttfb, total: Date.now() - started }
  }
}

/**
 * Run the full diagnostic.
 *
 * @param {string} href - URL to diagnose.
 * @param {object} options
 * @param {object} options.settings - normalized plugin settings.
 * @param {object} options.deps - `{ fetch, undici, directDispatcher }`.
 * @param {number} [options.timeoutMs] - per-stage ceiling.
 * @returns {Promise<object>} structured report.
 */
export async function diagnose(href, { settings, deps, timeoutMs = 8_000 }) {
  const url = new URL(href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported URL scheme "${url.protocol}"`)
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const host = url.hostname

  const dns = await dnsStage(host, Math.min(timeoutMs, 6_000))

  const tcpResults = []
  if (dns.ok) {
    for (const entry of dns.addresses.slice(0, 3)) {
      tcpResults.push(await tcpStage(entry.address, port, Math.min(timeoutMs, 5_000)))
      if (tcpResults[tcpResults.length - 1].ok) break
    }
  }
  const reachable = tcpResults.find(entry => entry.ok)

  const tlsResult = reachable && url.protocol === 'https:'
    ? await tlsStage(host, reachable.address, port, Math.min(timeoutMs, 6_000))
    : undefined

  const proxy = proxyEnvironment()
  const direct = deps.directDispatcher ? deps.directDispatcher() : undefined

  const viaProxyPath = await httpStage(url.toString(), {
    fetchImpl: deps,
    userAgent: settings.userAgent,
    timeoutMs: Math.min(timeoutMs + 4_000, 15_000),
  })
  const viaDirect = direct
    ? await httpStage(url.toString(), {
      fetchImpl: deps,
      dispatcher: direct,
      userAgent: settings.userAgent,
      timeoutMs: Math.min(timeoutMs + 4_000, 15_000),
    })
    : undefined

  const mirrors = planCandidates(url.toString(), settings).slice(1)

  return {
    url: url.toString(),
    host,
    port,
    dns,
    tcp: tcpResults,
    tls: tlsResult,
    proxy,
    viaProxyPath,
    viaDirect,
    mirrors,
    engine: { undici: Boolean(deps.undici), reason: deps.undiciReason },
  }
}

/** Turn a report into the compact text the tool returns. */
export function formatReport(report) {
  const lines = []
  lines.push(`net_doctor ${report.url}`)
  if (report.engine) {
    lines.push(`0. engine   undici=${report.engine.undici ? 'ok' : 'missing'} (${report.engine.undici ? 'proxy-aware dispatcher available' : report.engine.reason ?? 'direct path disabled'})`)
  }

  if (report.dns.ok) {
    const list = report.dns.addresses.map(entry => `${entry.address} (${entry.family === 6 ? 'v6' : 'v4'})`).join(', ')
    lines.push(`1. DNS      ok ${report.dns.ms} ms → ${list || 'no address'}`)
  } else {
    lines.push(`1. DNS      FAILED ${report.dns.ms} ms → ${report.dns.error}`)
  }

  if (report.tcp.length === 0) {
    lines.push('2. TCP      skipped (no address to dial)')
  } else {
    for (const entry of report.tcp) {
      lines.push(`2. TCP      ${entry.ok ? 'ok' : 'FAILED'} ${entry.address}:${entry.port} ${entry.ms} ms${entry.ok ? '' : ` → ${entry.error}`}`)
    }
  }

  if (report.tls) {
    lines.push(report.tls.ok
      ? `3. TLS      ok ${report.tls.protocol} ${report.tls.cipher} cert=${report.tls.subject ?? '?'} issuer=${report.tls.issuer ?? '?'} until=${report.tls.validTo ?? '?'} authorized=${report.tls.authorized}`
      : `3. TLS      FAILED ${report.tls.ms} ms → ${report.tls.error}`)
  } else {
    lines.push('3. TLS      skipped')
  }

  const describe = (label, probe) => {
    if (probe === undefined) return lines.push(`${label} skipped (no direct agent available)`)
    return lines.push(probe.ok
      ? `${label} HTTP ${probe.status} ${probe.contentType} ${probe.bytes} B ttfb=${probe.ttfb} ms total=${probe.total} ms`
      : `${label} FAILED ${probe.total} ms → ${probe.error}`)
  }
  describe('4. HTTP(proxy path)', report.viaProxyPath)
  describe('5. HTTP(direct)    ', report.viaDirect)

  lines.push(report.proxy.length > 0
    ? `6. proxy    ${report.proxy.join('  ')}`
    : '6. proxy    no HTTP(S)_PROXY / ALL_PROXY in this process environment')

  const verdict = decideVerdict(report)
  lines.push(`7. verdict  ${verdict}`)

  if (report.mirrors.length > 0) {
    lines.push('8. mirrors  fallback routes this plugin will try when the origin fails:')
    for (const mirror of report.mirrors) lines.push(`   - ${mirror.via}: ${mirror.url}`)
  } else {
    lines.push('8. mirrors  none for this host (retries only)')
  }

  return lines.join('\n')
}

/** Map the stage results to one actionable sentence. */
export function decideVerdict(report) {
  if (!report.dns.ok) return 'DNS 解析失败：本机解析不到该域名（hosts/DNS 或网络不可用）'
  if (report.tcp.length === 0 || !report.tcp.some(entry => entry.ok)) return 'TCP 连不上：地址或端口在链路上被丢弃'
  if (report.tls && !report.tls.ok) {
    return `TLS 握手被打断（${report.tls.error}）：这是链路层阻断/SNI 干扰的典型形态，不是站点风控`
  }
  const proxyProbe = report.viaProxyPath
  const directProbe = report.viaDirect
  if (proxyProbe && proxyProbe.ok && directProbe && !directProbe.ok) {
    return '只有代理链路可用：直连被阻断，保留当前代理设置'
  }
  if (proxyProbe && !proxyProbe.ok && directProbe && directProbe.ok) {
    return '只有直连可用：本机的代理链路在干扰这个域名，可考虑 NO_PROXY 或关闭代理'
  }
  if (proxyProbe && proxyProbe.ok) {
    return proxyProbe.status === 403 || proxyProbe.status === 429
      ? `站点返回 HTTP ${proxyProbe.status}：这是站点侧的限流/机器人校验，不是链路问题`
      : `可达（HTTP ${proxyProbe.status}）；此前的失败属于瞬时中断，重试即可`
  }
  if (directProbe && directProbe.ok) return `直连可达（HTTP ${directProbe.status}），代理路径失败`
  return '全部路径均失败：链路阻断或无出口，可用镜像路由或更换出口'
}
