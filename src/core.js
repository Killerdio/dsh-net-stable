/**
 * Resilient fetch engine.
 *
 * Deliberately free of DSH imports: the caller injects the Harness `WebError`
 * class and (optionally) the `undici` module, so this file also runs under a
 * plain Node process in tests.
 *
 * The ladder is:
 *   1. the requested URL, N times — alternating the host's proxy-aware
 *      dispatcher with a direct agent, because a half-broken proxy and a
 *      half-blocked direct path fail in different ways;
 *   2. mirror routes for the hosts that are routinely reset on the wire
 *      (raw.githubusercontent.com, cdn.jsdelivr.net, github.com/.../raw/...);
 *   3. a clear failure that lists every attempt instead of a bare
 *      "fetch failed".
 *
 * @module dsh-net-stable/core
 */

import { setTimeout as delay } from 'node:timers/promises'

export const PROVIDER_ID = 'resilient'
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Transport failures worth a second attempt. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
])

/** Defaults, all overridable through the plugin row's `config`. */
export const DEFAULTS = {
  retries: 2,
  retryDelayMs: 450,
  perAttemptTimeoutMs: 20_000,
  totalBudgetMs: 45_000,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  maxRedirects: 5,
  useDirectFallback: true,
  useMirrors: true,
}

/**
 * Resolve a plugin-row config into complete settings. Unknown keys are ignored
 * and every numeric field is clamped, so a typo degrades rather than throws.
 *
 * @param {unknown} config - the row config.
 * @returns settings object.
 */
export function normalizeSettings(config) {
  const c = config && typeof config === 'object' ? config : {}
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
  }
  const mirrors = { ghproxy: true, jsdelivr: true, contentsApi: true, ...(c.mirrors && typeof c.mirrors === 'object' ? c.mirrors : {}) }
  const extraMirrors = Array.isArray(c.extraMirrors)
    ? c.extraMirrors
      .filter(rule => rule && typeof rule.match === 'string' && typeof rule.to === 'string')
      .slice(0, 16)
    : []

  return {
    retries: int(c.retries, DEFAULTS.retries, 0, 6),
    retryDelayMs: int(c.retryDelayMs, DEFAULTS.retryDelayMs, 0, 10_000),
    perAttemptTimeoutMs: int(c.perAttemptTimeoutMs, DEFAULTS.perAttemptTimeoutMs, 1_000, 120_000),
    totalBudgetMs: int(c.totalBudgetMs, DEFAULTS.totalBudgetMs, 2_000, 300_000),
    maxResponseBytes: int(c.maxResponseBytes, DEFAULTS.maxResponseBytes, 4_096, 50_000_000),
    maxBodyChars: int(c.maxBodyChars, DEFAULTS.maxBodyChars, 1_000, 2_000_000),
    maxRedirects: int(c.maxRedirects, DEFAULTS.maxRedirects, 0, 10),
    useDirectFallback: c.useDirectFallback !== false,
    useMirrors: c.useMirrors !== false,
    mirrors,
    extraMirrors,
    userAgent: typeof c.userAgent === 'string' && c.userAgent.trim() !== '' ? c.userAgent.trim() : DEFAULT_USER_AGENT,
  }
}

/**
 * Classify a thrown fetch/stream error by walking its `cause` chain.
 *
 * @param {unknown} error - the thrown value.
 * @returns {{ code: string, retryable: boolean }}
 */
export function classifyFailure(error) {
  const chain = []
  let cursor = error
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    chain.push(cursor)
    cursor = cursor.cause
  }
  for (const entry of chain) {
    const code = entry && typeof entry === 'object' ? entry.code ?? entry.errno : undefined
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return { code, retryable: true }
  }
  const text = chain.map(entry => `${entry && entry.code ? entry.code : ''} ${entry && entry.message ? entry.message : String(entry ?? '')}`).join(' | ')
  if (/ECONNRESET|socket hang up|other side closed|premature close|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_|fetch failed/i.test(text)) {
    return { code: 'WEB_PROVIDER_ERROR', retryable: true }
  }
  return { code: 'WEB_PROVIDER_ERROR', retryable: false }
}

/** Split a raw.githubusercontent.com path into owner/repo/ref/path. */
function splitRawRepo(url) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 4) return null
  const [owner, repo, ref, ...rest] = parts
  return { owner, repo, ref, path: rest.join('/') }
}

/** Build the candidate ladder for one URL: origin first, then mirrors. */
export function planCandidates(href, settings) {
  const origin = new URL(href)
  const out = [{ url: origin.toString(), via: 'origin', decode: 'raw' }]
  if (!settings.useMirrors) return out

  const seen = new Set([origin.toString()])
  const add = (url, via, decode = 'raw') => {
    if (!url) return
    let parsed
    try { parsed = new URL(url) } catch { return }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    const text = parsed.toString()
    if (seen.has(text)) return
    seen.add(text)
    out.push({ url: text, via, decode })
  }

  /** Mirrors that serve a GitHub file by owner/repo/ref/path. */
  const githubFile = (owner, repo, ref, path) => {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
    if (settings.mirrors.ghproxy) add(`https://ghproxy.net/${raw}`, 'ghproxy')
    if (settings.mirrors.jsdelivr) add(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`, 'jsdelivr')
    if (settings.mirrors.contentsApi) add(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, 'contents-api', 'contents')
  }

  const host = origin.hostname.toLowerCase()

  if (host === 'raw.githubusercontent.com') {
    const parts = splitRawRepo(origin)
    if (parts) githubFile(parts.owner, parts.repo, parts.ref, parts.path)
  } else if (host === 'github.com') {
    // /<owner>/<repo>/raw/<ref>/<path> is a file download; /blob/ stays HTML.
    const m = /^\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(origin.pathname)
    if (m) githubFile(m[1], m[2], m[3], m[4])
  } else if (host === 'cdn.jsdelivr.net') {
    const m = /^\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/.exec(origin.pathname)
    if (m && settings.mirrors.ghproxy) add(`https://ghproxy.net/https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`, 'ghproxy')
  }

  for (const rule of settings.extraMirrors) {
    try {
      add(origin.toString().replace(new RegExp(rule.match), rule.to), 'custom', rule.decode === 'contents' ? 'contents' : 'raw')
    } catch { /* an invalid rule must not break the request */ }
  }

  return out
}

/** Same-origin test used by redirect handling. */
function isSameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function classifyContentType(contentType) {
  const mime = String(contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

function parseCharset(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(String(contentType ?? ''))
  return match ? match[1].trim().toLowerCase() : undefined
}

function decoderForCharset(charset) {
  const declared = charset ?? 'utf-8'
  try {
    return new TextDecoder(declared)
  } catch {
    return new TextDecoder('utf-8', { fatal: true })
  }
}

/**
 * Build the fetch engine.
 *
 * @param {object} deps
 * @param {Function} deps.WebError - Harness error class `(message, code, options)`.
 * @param {object} [deps.undici] - the `undici` module when it resolves; enables
 *   the direct (proxy-bypassing) agent. Without it only the host dispatcher is used.
 * @param {Function} [deps.fetchGlobal] - fallback fetch, defaults to globalThis.fetch.
 */
export function createFetcher(deps) {
  const WebError = deps.WebError
  const undici = deps.undici ?? null
  const fetchGlobal = deps.fetchGlobal ?? globalThis.fetch
  let directAgent
  let attemptsClosed = false

  const fail = (message, code, options) => new WebError(message, code, options)

  function directDispatcher() {
    if (!undici || typeof undici.Agent !== 'function') return undefined
    if (directAgent === undefined) {
      directAgent = new undici.Agent({
        connect: { timeout: 8_000 },
        keepAliveTimeout: 15_000,
        allowH2: false,
        autoSelectFamily: true,
      })
    }
    return directAgent
  }

  /** One HTTP request/response exchange with a bounded deadline. */
  async function requestOnce(url, { settings, signal, timeoutMs, dispatcher }) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const init = {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': settings.userAgent,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      },
      signal: combined,
    }
    if (dispatcher) init.dispatcher = dispatcher
    try {
      // The npm `undici` fetch carries the process-wide dispatcher, i.e. the
      // harness proxy policy; globalThis.fetch is the last-resort fallback.
      const fetchFn = undici ? undici.fetch : fetchGlobal
      return await fetchFn(url, init)
    } catch (error) {
      if (signal?.aborted) throw fail('web fetch aborted', 'WEB_ABORTED', { cause: error })
      if (timeoutSignal.aborted) throw fail(`web fetch timed out after ${timeoutMs} ms`, 'WEB_FETCH_TIMEOUT', { cause: error })
      throw fail(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** Read at most maxResponseBytes, then decode by declared charset. */
  async function readCapped(response, settings, signal) {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > settings.maxResponseBytes) {
        await response.body?.cancel().catch(() => {})
        throw fail(`response exceeds the maximum of ${settings.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        if (signal?.aborted) throw fail('web fetch aborted', 'WEB_ABORTED')
        const { done, value } = await reader.read()
        if (done) break
        const remaining = settings.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error) {
      if (error && error.name === 'WebError') throw error
      const classified = classifyFailure(error)
      throw fail(`web fetch failed while reading the body: ${String(error)}`, classified.retryable ? 'WEB_PROVIDER_ERROR' : 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      await reader.cancel().catch(() => {})
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }

  /** Decode a read body into the seam's closed union. */
  function decodeBody(bytes, { truncatedByBytes, contentType, settings, decode }) {
    const kind = classifyContentType(contentType)
    const decoder = decoderForCharset(parseCharset(contentType))

    if (decode === 'contents') {
      const text = decoder.decode(bytes, { stream: decoder.fatal && truncatedByBytes })
      let parsed
      try { parsed = JSON.parse(text) } catch (error) {
        throw fail('contents API returned invalid JSON', 'WEB_PROVIDER_ERROR', { cause: error })
      }
      if (!parsed || parsed.encoding !== 'base64' || typeof parsed.content !== 'string') {
        throw fail('contents API response carried no base64 content', 'WEB_PROVIDER_ERROR')
      }
      const fileBytes = Buffer.from(parsed.content.replace(/\s+/g, ''), 'base64')
      let content = new TextDecoder('utf-8').decode(fileBytes)
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
      const truncatedByChars = content.length > settings.maxBodyChars
      return {
        body: { kind: 'text', content: truncatedByChars ? content.slice(0, settings.maxBodyChars) : content },
        truncated: truncatedByChars || fileBytes.byteLength > settings.maxResponseBytes,
      }
    }

    if (kind === undefined) {
      throw fail(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const text = decoder.decode(bytes, { stream: decoder.fatal && truncatedByBytes })
    const truncatedByChars = text.length > settings.maxBodyChars
    const content = truncatedByChars ? text.slice(0, settings.maxBodyChars) : text
    return {
      body: kind === 'html' ? { kind: 'html', content } : { kind: 'text', content },
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /** Fetch one candidate, following same-origin redirects, and return a seam result. */
  async function fetchCandidate(candidate, { settings, signal, timeoutMs, dispatcher }) {
    const deadlineSignal = signal
    let current = new URL(candidate.url)
    let redirects = 0
    for (;;) {
      const response = await requestOnce(current.toString(), { settings, signal: deadlineSignal, timeoutMs, dispatcher })
      if (isRedirect(response.status)) {
        if (redirects >= settings.maxRedirects) {
          await response.body?.cancel().catch(() => {})
          throw fail(`exceeded the maximum of ${settings.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          await response.body?.cancel().catch(() => {})
          throw fail(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        let target
        try { target = new URL(location, current) } catch (error) {
          await response.body?.cancel().catch(() => {})
          throw fail(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
        }
        await response.body?.cancel().catch(() => {})
        if (!isSameOrigin(target, current)) {
          throw fail(`cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`, 'WEB_REDIRECT_BLOCKED')
        }
        current = target
        redirects += 1
        continue
      }

      const { bytes, truncatedByBytes } = await readCapped(response, settings, deadlineSignal)
      const decoded = decodeBody(bytes, {
        truncatedByBytes,
        contentType: response.headers.get('content-type'),
        settings,
        decode: candidate.decode,
      })
      const statusCode = candidate.decode === 'contents' ? 200 : response.status
      return {
        url: candidate.decode === 'contents' ? candidate.url : current.toString(),
        statusCode,
        body: decoded.body,
        truncated: decoded.truncated,
      }
    }
  }

  /**
   * Run the ladder for one URL.
   *
   * @param {string} href - requested URL.
   * @param {object} settings - normalized settings.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {(message: string) => void} [log] - diagnostics sink.
   * @returns {Promise<{ result: object, attempts: object[] }>} the seam result and what was tried.
   */
  async function fetchWithFallback(href, settings, signal, log = () => {}) {
    const startedAt = Date.now()
    const deadline = startedAt + settings.totalBudgetMs
    const candidates = planCandidates(href, settings)
    const attempts = []
    let lastHttpResult

    const record = entry => { attempts.push(entry); log(`${entry.via} ${entry.status ?? entry.error} ${entry.ms}ms ${entry.url}`) }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const isOrigin = candidate.via === 'origin'
      const rounds = isOrigin ? settings.retries + 1 : 1

      for (let round = 0; round < rounds; round += 1) {
        if (signal?.aborted) throw fail('web fetch aborted', 'WEB_ABORTED')
        const remaining = deadline - Date.now()
        if (remaining <= 300) break
        const timeoutMs = Math.max(300, Math.min(settings.perAttemptTimeoutMs, remaining))
        const useDirect = isOrigin && settings.useDirectFallback && round % 2 === 1
        const dispatcher = useDirect ? directDispatcher() : undefined
        const startedOnce = Date.now()
        try {
          const result = await fetchCandidate(candidate, { settings, signal, timeoutMs, dispatcher })
          record({ via: candidate.via, url: candidate.url, ms: Date.now() - startedOnce, status: result.statusCode, ok: true })

          if (result.statusCode >= 500 || result.statusCode === 429) {
            lastHttpResult = result
            log(`${candidate.via} answered HTTP ${result.statusCode}; trying the next route`)
            break
          }
          return { result, attempts }
        } catch (error) {
          const classified = classifyFailure(error)
          record({ via: candidate.via, url: candidate.url, ms: Date.now() - startedOnce, error: error.code ?? classified.code, ok: false })
          const fatal = error.code === 'WEB_ABORTED'
            || error.code === 'WEB_FETCH_TOO_LARGE'
            || error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE'
            || error.code === 'WEB_INVALID_URL'
            || error.code === 'WEB_REDIRECT_BLOCKED'
          if (fatal) throw error
          if (!classified.retryable && isOrigin) break
          if (round + 1 < rounds) {
            const backoff = Math.min(settings.retryDelayMs * 2 ** round, 4_000)
            await delay(backoff + Math.floor(Math.random() * 150))
          }
        }
      }
    }

    if (lastHttpResult !== undefined) return { result: lastHttpResult, attempts }

    const summary = attempts.map(entry => `- ${entry.via} ${entry.url} → ${entry.error ?? entry.status} (${entry.ms} ms)`).join('\n')
    const failure = fail(
      `web fetch failed after ${attempts.length} attempt(s); no route worked.\n${summary}`,
      'WEB_PROVIDER_ERROR',
    )
    failure.attempts = attempts
    throw failure
  }

  /** Close the direct agent on plugin disposal. */
  async function close() {
    if (attemptsClosed) return
    attemptsClosed = true
    if (directAgent) await directAgent.close().catch(() => {})
    directAgent = undefined
  }

  return { fetchWithFallback, close, directDispatcher, classifyFailure }
}
