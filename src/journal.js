/**
 * In-memory fetch journal.
 *
 * The provider records every attempt here; `net_doctor` prints the tail when
 * called without a URL. This is what turns "it failed yesterday" into
 * "it failed at 19:41 via ghproxy with ECONNRESET after 3 attempts".
 *
 * Nothing is written to disk and nothing leaves the process.
 *
 * @module dsh-net-stable/journal
 */

/** @param {number} limit - how many entries to keep. */
export function createJournal(limit = 60) {
  const entries = []
  let sequence = 0

  return {
    /**
     * Append one outcome.
     *
     * @param {object} entry - `{ url, finalUrl, via, status, ms, attempts, error }`.
     */
    record(entry) {
      sequence += 1
      entries.push({
        id: sequence,
        at: Date.now(),
        url: typeof entry.url === 'string' ? entry.url : '',
        finalUrl: typeof entry.finalUrl === 'string' ? entry.finalUrl : undefined,
        via: typeof entry.via === 'string' ? entry.via : 'origin',
        status: Number.isFinite(entry.status) ? entry.status : undefined,
        ms: Number.isFinite(entry.ms) ? entry.ms : undefined,
        attempts: Number.isFinite(entry.attempts) ? entry.attempts : undefined,
        error: typeof entry.error === 'string' ? entry.error.slice(0, 300) : undefined,
      })
      if (entries.length > limit) entries.shift()
    },

    /** @param {number} count - newest first. */
    recent(count = 10) {
      return entries.slice(-count).reverse()
    },

    /** Aggregate counters for the status report. */
    stats() {
      let ok = 0
      let httpError = 0
      let transportError = 0
      let mirrored = 0
      for (const entry of entries) {
        if (entry.error !== undefined) transportError += 1
        else if (entry.status !== undefined && entry.status >= 200 && entry.status < 400) ok += 1
        else httpError += 1
        if (entry.via !== 'origin' && entry.via !== 'none') mirrored += 1
      }
      return { total: entries.length, ok, httpError, transportError, mirrored }
    },

    /** Test/seam helper. */
    clear() {
      entries.length = 0
    },
  }
}

/** Format a timestamp the way the report shows it. */
function clock(at) {
  const date = new Date(at)
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Render the journal as the `net_doctor` status report (no URL argument).
 *
 * @param {object} options
 * @param {object} options.journal - journal instance.
 * @param {number} [options.count] - entries to show.
 * @param {object} [options.engine] - `{ undici, reason }`.
 * @param {object} options.settings - normalized settings.
 * @param {string[]} options.proxy - proxy environment entries.
 * @returns {string}
 */
export function formatJournal({ journal, count = 10, engine, settings, proxy }) {
  const lines = []
  lines.push('net_doctor (no URL: recent fetches + engine status)')
  if (engine) {
    lines.push(`0. engine   undici=${engine.undici ? 'ok' : 'missing'}${engine.undici ? '' : ` (${engine.reason ?? 'direct path disabled'})`}`)
  }
  lines.push(`1. config   retries=${settings.retries} budget=${settings.totalBudgetMs} ms per-attempt=${settings.perAttemptTimeoutMs} ms mirrors=${settings.useMirrors ? 'on' : 'off'} direct-fallback=${settings.useDirectFallback ? 'on' : 'off'}`)
  lines.push(proxy.length > 0 ? `2. proxy    ${proxy.join('  ')}` : '2. proxy    no HTTP(S)_PROXY / ALL_PROXY in this process environment')

  const stats = journal.stats()
  lines.push(`3. totals   ${stats.total} recorded, ${stats.ok} ok, ${stats.httpError} http-error (4xx/5xx), ${stats.transportError} transport-failure, ${stats.mirrored} via mirror`)

  const recent = journal.recent(count)
  if (recent.length === 0) {
    lines.push('4. recent   no fetch has run in this process yet')
    return lines.join('\n')
  }

  lines.push('4. recent   newest first')
  for (const entry of recent) {
    const outcome = entry.error !== undefined
      ? `FAIL ${entry.error}`
      : `HTTP ${entry.status ?? '?'}`
    const route = entry.via === 'origin' ? 'origin' : entry.via
    const duration = entry.ms === undefined ? '?' : `${entry.ms} ms`
    const tries = entry.attempts === undefined ? '' : ` (${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'})`
    lines.push(`   - ${clock(entry.at)} ${outcome} ${route} ${duration}${tries} ${shortUrl(entry.url)}`)
    if (entry.finalUrl !== undefined && entry.finalUrl !== entry.url) lines.push(`     ↳ answered by ${shortUrl(entry.finalUrl)}`)
  }
  return lines.join('\n')
}

/** Keep report lines readable for long URLs. */
function shortUrl(url) {
  if (typeof url !== 'string') return ''
  return url.length > 110 ? `${url.slice(0, 107)}…` : url
}
