import { FETCH_FAILED, FETCH_RATE_LIMITED } from './subscriptionFetchStatus'

/**
 * Makes subscription fetches fail on purpose, so the recovery path can be
 * exercised.
 *
 * Being rate limited by YouTube is neither reproducible nor available on
 * demand: two full refreshes of six hundred and eleven channels came back
 * completely clean, so no real response has ever produced a rate limited
 * status. Recovery from mass failure cannot be built against a thing that
 * refuses to happen, so it is simulated instead.
 *
 * Set `FT_SUBS_FAIL` when launching:
 *
 *   FT_SUBS_FAIL=0.6              six in ten fetches come back rate limited
 *   FT_SUBS_FAIL=0.6:error        six in ten fail as errors instead
 *   FT_SUBS_FAIL=1                everything fails, the total blockage case
 *
 * The decision is made per fetch, so a channel that failed can succeed when it
 * is tried again. That is the behaviour worth simulating: real blocking clears,
 * and a recovery that only works against permanent failure is no use.
 *
 * The real fetch is skipped entirely when a failure is injected, so a test run
 * neither waits for the network nor hammers YouTube while pretending YouTube is
 * angry.
 *
 * Like the tracing, the flag is baked in by DefinePlugin because the renderer
 * has no runtime `process.env`, and the whole module disappears from a build
 * that does not set it.
 */

const CONFIG = (() => {
  const raw = process.env.FT_SUBS_FAIL

  if (!raw || raw === '0' || raw === 'false') { return null }

  const [rateText, mode = 'ratelimit'] = String(raw).split(':')
  const rate = Number.parseFloat(rateText)

  if (!Number.isFinite(rate) || rate <= 0) { return null }

  return {
    rate: Math.min(rate, 1),
    status: mode === 'error' ? FETCH_FAILED : FETCH_RATE_LIMITED
  }
})()

export const subscriptionFailureInjectionEnabled = CONFIG !== null

if (CONFIG !== null) {
  console.warn(
    `[subscriptions] FAILURE INJECTION ACTIVE: ${Math.round(CONFIG.rate * 100)}% of fetches will return ${CONFIG.status}. Unset FT_SUBS_FAIL to stop.`
  )
}

/**
 * A failure to return in place of really fetching, or null to go ahead.
 * @returns {{ status: string, entries: null } | null}
 */
export function injectedFetchFailure() {
  if (CONFIG === null) { return null }
  if (Math.random() >= CONFIG.rate) { return null }

  return {
    status: CONFIG.status,
    entries: null
  }
}
