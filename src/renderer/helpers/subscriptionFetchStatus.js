import i18n from '../i18n/index'

import { copyToClipboard, showToast } from './utils'

/**
 * Outcomes of fetching one channel's feed.
 *
 * Before these existed, nearly every failure path returned an empty array,
 * which is also what a channel with no videos returns. That made "YouTube
 * blocked us" indistinguishable from "nothing posted here", so nothing could
 * decide whether a refresh was worth retrying.
 */

/** Got an answer. The entries are trustworthy, even if there are none. */
export const FETCH_OK = 'ok'

/** Blocked, HTTP 403 or 429. Retryable, and must never overwrite the cache. */
export const FETCH_RATE_LIMITED = 'rateLimited'

/**
 * The channel is gone: its playlist feed and its channel feed both 404.
 * Not retryable, and caching emptiness for it is correct.
 */
export const FETCH_UNAVAILABLE = 'unavailable'

/**
 * Threw, or returned something unparseable, and every fallback was exhausted.
 * Retryable, and must never overwrite the cache.
 */
export const FETCH_FAILED = 'failed'

/** @param {string} status */
export function isRetryableFetchStatus(status) {
  return status === FETCH_RATE_LIMITED || status === FETCH_FAILED
}

/**
 * @typedef {object} FetchErrorCollector
 * @property {number} total
 * @property {{ channelId: string, channelName: string, api: string, error: unknown }[]} errors
 * @property {number} rateLimited
 */

/** @type {Map<string, FetchErrorCollector>} */
const collectors = new Map()

/** How many individual failures reach the console during one refresh. */
const MAX_LOGGED_ERRORS_PER_RUN = 5

/** How many entries each list in the copied report carries before it is cut short. */
const MAX_REPORTED_ITEMS = 40

/**
 * Start collecting fetch errors for a feed instead of showing them one by one.
 *
 * Each failed channel used to raise its own ten second click-to-copy toast, and
 * the retry ladder could raise three per channel. A few hundred blocked
 * channels therefore produced the better part of a thousand toasts, which is
 * how a mass failure announced itself. One summary is more use than that.
 *
 * @param {string} feed
 * @param {number} total how many channels this refresh will attempt
 */
export function beginFetchErrorCollection(feed, total) {
  collectors.set(feed, { total, errors: [], rateLimited: 0 })
}

/**
 * Record a channel that could not be fetched. Falls back to a toast when no
 * collection is open, so single-channel callers keep their existing behaviour.
 *
 * @param {string} feed
 * @param {object} details
 * @param {{ id: string, name?: string }} details.channel
 * @param {unknown} details.error
 * @param {'local' | 'invidious'} details.api
 */
export function reportFetchError(feed, { channel, error, api }) {
  const collector = collectors.get(feed)

  if (collector == null) {
    console.error(error)
    const message = api === 'invidious'
      ? i18n.global.t('Invidious API Error (Click to copy)')
      : i18n.global.t('Local API Error (Click to copy)')

    showToast(`${message}: ${error}`, 10000, () => {
      copyToClipboard(error)
    })

    return
  }

  // Only the first few go to the console. A mass failure produces one of these
  // per channel per rung of its retry ladder, so several hundred subscriptions
  // can mean well over a thousand in the space of a few seconds, each one
  // serialised and forwarded to the main process when logging is enabled. That
  // is a lot of work to pile onto a renderer at the exact moment it is already
  // struggling, and a run that did so ended with the renderer dying. Every
  // error is still kept, and the summary can copy the lot.
  if (collector.errors.length < MAX_LOGGED_ERRORS_PER_RUN) {
    console.error(error)
  } else if (collector.errors.length === MAX_LOGGED_ERRORS_PER_RUN) {
    console.error(`[subscriptions] further ${feed} fetch errors suppressed, see the summary`)
  }

  collector.errors.push({
    channelId: channel.id,
    channelName: channel.name ?? channel.id,
    api,
    error
  })
}

/**
 * Note that a channel ended up rate limited. Counted separately from errors
 * because being blocked says something different from a channel being broken,
 * and it is the number that says to back off rather than investigate.
 *
 * Called once per channel, from whatever settles that channel's outcome, rather
 * than at each place an HTTP 403 is read.
 *
 * @param {string} feed
 */
export function reportRateLimited(feed) {
  const collector = collectors.get(feed)

  if (collector != null) {
    collector.rateLimited++
  }
}

/**
 * Stop collecting and hand back what was collected. Says nothing on its own:
 * whether anything is worth telling anyone depends on what happens next, which
 * the caller knows and this does not.
 *
 * @param {string} feed
 * @returns {FetchErrorCollector | undefined}
 */
export function endFetchErrorCollection(feed) {
  const collector = collectors.get(feed)

  collectors.delete(feed)

  return collector
}

/**
 * Report channels that could not be fetched, once, when nothing further is
 * going to be done about them.
 *
 * Two things decide whether this is worth saying. The count is channels left
 * unresolved rather than errors seen, because one channel can error at every
 * rung of its retry ladder and usually gets recovered by a fallback anyway, so
 * a run that logged forty two errors and resolved all but eight should say
 * eight. And it must not be said while the recovery is still working: a refresh
 * that loses three hundred and eighty channels and quietly gets every one of
 * them back is a success, and announcing the failure in the middle of it is
 * alarming about a problem that is already being solved.
 *
 * @param {string} feed
 * @param {FetchErrorCollector | undefined} collector
 * @param {{ id: string, name?: string }[]} unresolvedChannels
 */
export function showFetchErrorSummary(feed, collector, unresolvedChannels) {
  if (collector == null || unresolvedChannels.length === 0) { return }

  const message = collector.rateLimited > 0
    ? i18n.global.t('Subscriptions.Fetch Errors Rate Limited', {
        failed: unresolvedChannels.length,
        total: collector.total,
        rateLimited: collector.rateLimited
      })
    : i18n.global.t('Subscriptions.Fetch Errors', {
        failed: unresolvedChannels.length,
        total: collector.total
      })

  showToast(message, 10000, () => {
    copyToClipboard(formatErrorReport(feed, collector, unresolvedChannels))
  })
}

/**
 * @param {string} feed
 * @param {FetchErrorCollector} collector
 * @param {{ id: string, name?: string }[]} unresolvedChannels
 */
function formatErrorReport(feed, collector, unresolvedChannels) {
  const lines = [
    `Subscription fetch (${feed})`,
    `${unresolvedChannels.length} of ${collector.total} channels could not be fetched`,
    `${collector.rateLimited} rate limited, ${collector.errors.length} failed attempt(s) across all retries`,
    ''
  ]

  appendCapped(lines, 'Channels left unresolved', unresolvedChannels,
    channel => `  ${channel.name ?? channel.id} (${channel.id})`)

  // Every attempt, including ones a fallback went on to recover, because which
  // rung failed is the useful part when working out what is wrong
  appendCapped(lines, 'Failed attempts', collector.errors,
    ({ channelId, channelName, api, error }) => `  ${channelName} (${channelId}) via ${api}: ${error}`)

  return lines.join('\n')
}

/**
 * A mass failure can leave hundreds of channels unresolved, and a report that
 * long stops being something anyone reads or can paste anywhere useful. The
 * first few dozen say what is going on; the rest only say it again.
 *
 * @template T
 * @param {string[]} lines
 * @param {string} heading
 * @param {T[]} items
 * @param {(item: T) => string} format
 */
function appendCapped(lines, heading, items, format) {
  if (items.length === 0) { return }

  lines.push(`${heading} (${items.length}):`)

  for (const item of items.slice(0, MAX_REPORTED_ITEMS)) {
    lines.push(format(item))
  }

  if (items.length > MAX_REPORTED_ITEMS) {
    lines.push(`  ... and ${items.length - MAX_REPORTED_ITEMS} more`)
  }

  lines.push('')
}
