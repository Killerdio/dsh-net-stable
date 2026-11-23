/**
 * dsh-net-stable — a Host-only bundle that makes `web_fetch` survivable on a
 * flaky or partially blocked network, and adds a `net_doctor` tool for the
 * cases where it still fails.
 *
 * Registers:
 *   - a fetch provider `resilient` for `ctx.web`;
 *   - the model-facing `net_doctor` tool, when the composition has `tools`.
 *
 * No build step and no dependencies: a profile-installed bundle cannot resolve
 * the shipped `@deepseek-ai/*` packages, so this file touches only the public
 * service objects (`ctx.web`, `ctx.tools`) and Node built-ins.
 *
 * @module dsh-net-stable
 */

import { createFetcher, normalizeSettings, PROVIDER_ID } from './src/core.js'
import { diagnose, formatReport, proxyEnvironment } from './src/doctor.js'
import { WebError } from './src/errors.js'
import { createJournal, formatJournal } from './src/journal.js'
import { loadUndici, undiciFailureReason } from './src/undici.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'net-stable'

/** Only the web seam is required; the tool is registered when `tools` exists. */
export const inject = ['web']

/** Localized provider blurb shown under the Fetch provider menu. */
const PROVIDER_DESCRIPTION = {
  en: 'Retries failed fetches, falls back to a direct connection when the proxy path breaks, and routes GitHub file URLs through mirrors. Free, and adds a net_doctor tool for diagnosis.',
  zh: '抓取失败时自动重试，代理链路异常时回退直连，GitHub 文件地址走镜像；免费，并附带 net_doctor 诊断工具。',
  ja: '取得失敗時に再試行し、プロキシ経路が壊れている場合は直接接続へ切り替え、GitHub のファイル URL はミラー経由で取得します。無料。',
}

/** Model-facing parameter schema for `net_doctor`, in wire-level JSON Schema. */
const DOCTOR_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description: 'Absolute http(s) URL to diagnose. Omit it to read the recent-fetch journal and engine status instead.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Per-stage timeout in milliseconds (default 8000, capped at 20000).',
    },
  },
}

/**
 * Register the provider and the tool.
 *
 * @param {object} ctx - the plugin context.
 * @param {unknown} config - the row config, normalized by {@link normalizeSettings}.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('net-stable') : undefined
  const debug = message => logger?.debug?.(message)
  const journal = createJournal()

  /** Lazily build the engine once: the `undici` import may not resolve outside DSH. */
  let enginePromise
  function engine() {
    if (enginePromise === undefined) {
      enginePromise = (async () => {
        const undici = await loadUndici()
        const fetcher = createFetcher({ WebError, undici, fetchGlobal: globalThis.fetch })
        return { fetcher, undici, reason: undici ? undefined : undiciFailureReason() }
      })()
    }
    return enginePromise
  }

  const provider = {
    id: PROVIDER_ID,
    title: 'Stable fetch',
    description: PROVIDER_DESCRIPTION,
    available: () => true,
    ready: () => true,
    async fetch(request, signal) {
      const { fetcher } = await engine()
      const started = Date.now()
      try {
        const { result, attempts } = await fetcher.fetchWithFallback(request.url, settings, signal, debug)
        const answering = [...attempts].reverse().find(entry => entry.ok)
        const via = answering?.via ?? 'origin'
        journal.record({
          url: request.url,
          finalUrl: result.url,
          via,
          status: result.statusCode,
          ms: Date.now() - started,
          attempts: attempts.length,
        })
        if (via !== 'origin') logger?.info?.(`web_fetch fell back to ${via}: ${request.url} → ${result.url}`)
        return result
      } catch (error) {
        journal.record({
          url: request.url,
          via: 'none',
          ms: Date.now() - started,
          attempts: Array.isArray(error.attempts) ? error.attempts.length : undefined,
          error: String(error.code ?? error.message ?? error),
        })
        logger?.warn?.(`web_fetch failed: ${request.url} — ${String(error.code ?? error.message ?? error)}`)
        throw error
      }
    },
  }

  ctx.web.registerFetchProvider(provider)

  ctx.effect(() => () => {
    if (enginePromise === undefined) return
    enginePromise.then(({ fetcher }) => fetcher.close()).catch(() => {})
  })

  ctx.inject(['tools'], toolCtx => {
    toolCtx.tools.register({
      name: 'net_doctor',
      description: 'Diagnose why a URL fails to load: run DNS, TCP, TLS and HTTP checks, compare the proxy path with a direct connection, and list the mirror routes the stable fetch provider would fall back to.',
      parameters: DOCTOR_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 45_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { fetcher, undici, reason } = await engine()
        const requested = Number(args?.timeoutMs)
        const timeoutMs = Number.isFinite(requested) ? Math.min(20_000, Math.max(1_000, Math.round(requested))) : 8_000
        const rawUrl = typeof args?.url === 'string' ? args.url.trim() : ''

        if (rawUrl === '') {
          return formatJournal({
            journal,
            engine: { undici: Boolean(undici), reason },
            settings,
            proxy: proxyEnvironment(),
          })
        }

        let parsed
        try { parsed = new URL(rawUrl) } catch { throw new Error(`net_doctor received an invalid URL: ${rawUrl}`) }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`net_doctor only checks http(s) URLs, got "${parsed.protocol}"`)

        const report = await diagnose(rawUrl, {
          settings,
          deps: { fetch: globalThis.fetch, undici, undiciReason: reason, directDispatcher: fetcher.directDispatcher },
          timeoutMs,
        })
        if (exec?.signal?.aborted) throw new Error('net_doctor aborted')
        return formatReport(report)
      },
    })
  })
}
