/**
 * Real-network smoke test (not part of the offline suite).
 *
 *   node scripts/smoke.mjs
 *
 * Reads one raw.githubusercontent.com file through the ladder and prints the
 * route that answered, then prints a net_doctor report for the same URL.
 */

import { createFetcher, normalizeSettings } from '../src/core.js'
import { diagnose, formatReport } from '../src/doctor.js'

class WebError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

async function main() {
  const undici = await import('undici').catch(() => null)
  const settings = normalizeSettings({})
  const fetcher = createFetcher({ WebError, undici })

  const target = 'https://raw.githubusercontent.com/Ebony-Vinyl/dsh-our-free-model/main/package.json'
  const started = Date.now()
  const { result, attempts } = await fetcher.fetchWithFallback(target, settings, undefined, message => console.log(`  · ${message}`))
  console.log(`\nresult: HTTP ${result.statusCode} ${result.body.content.length} chars in ${Date.now() - started} ms`)
  console.log(`url:    ${result.url}`)
  console.log(`body:   ${result.body.content.slice(0, 120).replace(/\n/g, ' ')}…`)
  console.log(`attempts:`)
  for (const attempt of attempts) console.log(`  - ${attempt.via.padEnd(12)} ${attempt.ok ? 'ok' : 'fail'} ${String(attempt.status ?? attempt.error).padEnd(20)} ${attempt.url}`)

  const report = await diagnose(target, {
    settings,
    deps: { fetch: globalThis.fetch, undici, directDispatcher: fetcher.directDispatcher },
    timeoutMs: 8_000,
  })
  console.log(`\n${formatReport(report)}`)
  await fetcher.close()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
