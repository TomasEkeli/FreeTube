/* eslint-disable no-console -- writing to the console is this module's entire purpose */

/**
 * Opt-in instrumentation for the subscription refresh.
 *
 * Enabled by launching with `FT_SUBS_TRACE=1` (summary only) or
 * `FT_SUBS_TRACE=verbose` (a line per channel as well). The renderer is built
 * with `target: 'web'` and runs without node integration, so there is no
 * runtime `process.env` to read: the flag is baked in by DefinePlugin in
 * `_scripts/webpack.renderer.config.js`, which means it is fixed for the
 * lifetime of the dev-runner and has to be set on the launch command.
 *
 * Output goes to the console, which reaches stdout because `dev-runner.js`
 * passes `--enable-logging` and `stdio: 'inherit'`. Every line is prefixed
 * `[subs-trace]` so it can be grepped out of the log.
 *
 * The point of this is peak concurrency. The RSS refresh currently starts
 * every channel in one `Promise.all`, and there is no way to see that from
 * outside: devtools crash the renderer under WSLg, so measurement has to be
 * a feature of the code.
 *
 * This traces the per-channel funnel, not individual HTTP requests, so
 * `requests` counts channels rather than round trips: a channel whose retry
 * ladder falls back RSS -> scraper -> Invidious makes several requests and is
 * counted once. Per-request statuses arrive in the commit that introduces
 * failure classification, which edits those code paths anyway.
 */

/** @type {false | 'summary' | 'verbose'} */
const TRACE_LEVEL = (() => {
  const raw = process.env.FT_SUBS_TRACE

  if (!raw || raw === '0' || raw === 'false') {
    return false
  }

  return (raw === 'verbose' || raw === '2') ? 'verbose' : 'summary'
})()

export const subscriptionTraceEnabled = TRACE_LEVEL !== false

/**
 * @typedef {object} TraceSession
 * @property {string} feed
 * @property {number} startedAt
 * @property {number} inFlight
 * @property {number} peakConcurrency
 * @property {number} started
 * @property {number} finished
 * @property {number[]} durations
 * @property {number} entries
 * @property {Map<string, number>} outcomes
 */

/** @type {Map<string, TraceSession>} */
const sessions = new Map()

/** A no-op returned everywhere when tracing is off, so call sites stay branch-free. */
const NOOP = () => {}

function percentile(sorted, fraction) {
  if (sorted.length === 0) { return 0 }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))

  return sorted[index]
}

/**
 * Start a trace for one refresh of one feed. Replaces any session already open
 * for that feed, since a new refresh supersedes the old one.
 * @param {string} feed 'videos' | 'live' | 'shorts' | 'posts'
 * @param {object} meta
 * @param {number} meta.channelCount
 * @param {boolean} [meta.useRss]
 * @param {string} [meta.backend]
 */
export function beginSubscriptionTrace(feed, { channelCount, useRss, backend }) {
  if (!subscriptionTraceEnabled) { return }

  sessions.set(feed, {
    feed,
    startedAt: Date.now(),
    inFlight: 0,
    peakConcurrency: 0,
    started: 0,
    finished: 0,
    durations: [],
    entries: 0,
    outcomes: new Map()
  })

  console.log(
    `[subs-trace] begin ${feed} channels=${channelCount} rss=${useRss ?? 'n/a'} backend=${backend ?? 'n/a'}`
  )
}

/**
 * Mark the start of one channel's fetch. Returns the function to call when it
 * settles; call it in a `finally` so a throw cannot leak the in-flight count.
 * @param {string} feed
 * @param {string} channelId
 * @returns {(result?: { entries?: number | null, outcome?: string }) => void}
 */
export function traceChannelFetch(feed, channelId) {
  if (!subscriptionTraceEnabled) { return NOOP }

  const session = sessions.get(feed)

  if (session == null) { return NOOP }

  const startedAt = Date.now()

  session.started++
  session.inFlight++

  if (session.inFlight > session.peakConcurrency) {
    session.peakConcurrency = session.inFlight
  }

  let settled = false

  return ({ entries = null, outcome = 'ok' } = {}) => {
    // Guard against a double call, which would corrupt the concurrency count
    if (settled) { return }
    settled = true

    const duration = Date.now() - startedAt

    session.inFlight--
    session.finished++
    session.durations.push(duration)
    session.outcomes.set(outcome, (session.outcomes.get(outcome) ?? 0) + 1)

    if (entries != null) {
      session.entries += entries
    }

    if (TRACE_LEVEL === 'verbose') {
      console.log(
        `[subs-trace] ch ${feed} ${channelId} ${duration}ms entries=${entries ?? '-'} outcome=${outcome} inFlight=${session.inFlight}`
      )
    }
  }
}

/**
 * Report a step of the recovery that follows a failed refresh.
 *
 * Without this the recovery is invisible: it changes no loading state by
 * design, and the only evidence it ran at all was reverse engineered from
 * timestamps in the database.
 *
 * @param {string} feed
 * @param {string} stage
 * @param {object} detail
 * @param {number} [detail.groups]
 * @param {number} [detail.channels]
 * @param {number} [detail.recovered]
 * @param {number} [detail.remaining]
 * @param {string} [detail.label]
 */
export function traceRecovery(feed, stage, detail = {}) {
  if (!subscriptionTraceEnabled) { return }

  const parts = Object.entries(detail)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}=${value}`)

  console.log(`[subs-trace] recovery ${feed} ${stage} ${parts.join(' ')}`.trimEnd())
}

/**
 * Report the end of a whole refresh cycle, once every feed in it has finished.
 *
 * The peak is the number the shared budget exists to hold down, and it is only
 * meaningful across the lot: each feed's own peak says nothing about what the
 * host saw while three of them were running at once.
 *
 * @param {object} detail
 * @param {number} detail.peakInFlight
 * @param {number} detail.channels
 */
export function traceRefreshCycleEnd({ peakInFlight, channels }) {
  if (!subscriptionTraceEnabled) { return }

  console.log(`[subs-trace] cycle end channels=${channels} peakInFlight=${peakInFlight}`)
}

/**
 * Close the trace for a feed and print the summary.
 * @param {string} feed
 */
export function endSubscriptionTrace(feed) {
  if (!subscriptionTraceEnabled) { return }

  const session = sessions.get(feed)

  if (session == null) { return }

  sessions.delete(feed)

  const wallMs = Date.now() - session.startedAt
  const sorted = session.durations.slice().sort((a, b) => a - b)

  const outcomes = Array.from(session.outcomes.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(' ')

  console.log(
    [
      `[subs-trace] end ${feed}`,
      `wall=${(wallMs / 1000).toFixed(1)}s`,
      `channels=${session.finished}/${session.started}`,
      `peakConcurrency=${session.peakConcurrency}`,
      `entries=${session.entries}`,
      `perChannelMs=min:${sorted[0] ?? 0}`,
      `p50:${percentile(sorted, 0.5)}`,
      `p95:${percentile(sorted, 0.95)}`,
      `max:${sorted[sorted.length - 1] ?? 0}`,
      outcomes.length > 0 ? `outcomes=${outcomes}` : ''
    ].filter(part => part !== '').join(' ')
  )
}
