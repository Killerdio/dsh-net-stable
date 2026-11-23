/**
 * Twenty-fetch real-world benchmark: 10 sites, two rounds each.
 *
 *   node scripts/bench.mjs
 *
 * Exercises the same engine the provider uses (retries, caps, mirror routes)
 * and writes bench-results.json next to this script. Not part of the offline
 * suite: it needs the public network and records whatever the network answers,
 * including 403/429 pages served to non-browser clients.
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFetcher, normalizeSettings } from '../src/core.js'
import { WebError } from '../src/errors.js'
import { loadUndici, undiciFailureReason } from '../src/undici.js'

const SITES = [
  { name: 'bilibili', url: 'https://www.bilibili.com' },
  { name: 'zhihu', url: 'https://www.zhihu.com' },
  { name: 'tieba', url: 'https://tieba.baidu.com' },
  { name: 'baidu', url: 'https://www.baidu.com' },
  { name: 'github repo', url: 'https://github.com/Ebony-Vinyl/dsh-our-free-model' },
  { name: 'github raw', url: 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/README.md' },
  { name: 'netease', url: 'https://www.163.com' },
  { name: 'douban', url: 'https://www.douban.com' },
  { name: 'taobao', url: 'https://www.taobao.com' },
  { name: 'qq', url: 'https://www.qq.com' },
]

const ROUNDS = 2

const settings = normalizeSettings({
  retries: 1,
  retryDelayMs: 300,
  perAttemptTimeoutMs: 8_000,
  totalBudgetMs: 16_000,
  maxBodyChars: 20_000,
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function percentile(values, p) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

async function main() {
  const undici = await loadUndici()
  const fetcher = createFetcher({ WebError, undici })
  const rows = []

  console.log(`engine: undici=${undici ? 'ok' : `missing (${undiciFailureReason()})`}`)
  console.log(`plan: ${SITES.length} sites × ${ROUNDS} rounds = ${SITES.length * ROUNDS} fetches\n`)

  for (let round = 1; round <= ROUNDS; round += 1) {
    console.log(`--- round ${round} ---`)
    for (const site of SITES) {
      const started = Date.now()
      const attempts = []
      let row
      try {
        const { result, attempts: tried } = await fetcher.fetchWithFallback(site.url, settings, undefined, () => {})
        attempts.push(...tried)
        const answering = [...tried].reverse().find(entry => entry.ok)
        row = {
          round,
          site: site.name,
          url: site.url,
          ok: result.statusCode >= 200 && result.statusCode < 400,
          status: result.statusCode,
          via: answering?.via ?? 'origin',
          bytes: Buffer.byteLength(result.body.content, 'utf8'),
          truncated: result.truncated,
          ms: Date.now() - started,
          attemptCount: tried.length,
        }
      } catch (error) {
        row = {
          round,
          site: site.name,
          url: site.url,
          ok: false,
          status: undefined,
          via: 'none',
          bytes: 0,
          truncated: false,
          ms: Date.now() - started,
          attemptCount: attempts.length,
          error: String(error.code ?? error.message ?? error).slice(0, 160),
        }
      }
      rows.push(row)
      const outcome = row.error ? `FAIL ${row.error}` : `HTTP ${row.status}`
      console.log(`${String(site.name).padEnd(12)} ${outcome.padEnd(34)} ${String(row.ms).padStart(6)} ms  ${String(row.via).padEnd(10)} ${row.bytes} chars`)
      await sleep(400)
    }
    console.log('')
  }

  const successful = rows.filter(row => row.ok)
  const okLatencies = successful.map(row => row.ms)
  const allLatencies = rows.map(row => row.ms)
  const byHost = new Map()
  for (const row of rows) {
    const entry = byHost.get(row.site) ?? { ok: 0, total: 0, statuses: [] }
    entry.total += 1
    if (row.ok) entry.ok += 1
    entry.statuses.push(row.error ? 'ERR' : row.status)
    byHost.set(row.site, entry)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    engine: { undici: Boolean(undici), reason: undici ? undefined : undiciFailureReason() },
    fetches: rows.length,
    ok: successful.length,
    failed: rows.length - successful.length,
    successRate: `${Math.round((successful.length / rows.length) * 100)}%`,
    latency: {
      okAvg: Math.round(okLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, okLatencies.length)),
      okP50: percentile(okLatencies, 50),
      okP95: percentile(okLatencies, 95),
      allP95: percentile(allLatencies, 95),
      max: Math.max(...allLatencies),
    },
    mirrorFetches: rows.filter(row => row.via !== 'origin' && row.via !== 'none').length,
    perSite: [...byHost.entries()].map(([site, entry]) => ({ site, ...entry })),
    rows,
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), 'bench-results.json')
  await writeFile(out, `${JSON.stringify(summary, undefined, 2)}\n`, 'utf8')

  console.log('--- summary ---')
  console.log(`success ${summary.ok}/${summary.fetches} (${summary.successRate})  mirror routes ${summary.mirrorFetches}`)
  console.log(`latency ok: avg ${summary.latency.okAvg} ms  p50 ${summary.latency.okP50}  p95 ${summary.latency.okP95}  max ${summary.latency.max}`)
  for (const entry of summary.perSite) {
    console.log(`${entry.site.padEnd(12)} ${entry.ok}/${entry.total} ok  statuses=${entry.statuses.join(',')}`)
  }
  console.log(`\nwrote ${out}`)
  await fetcher.close()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
