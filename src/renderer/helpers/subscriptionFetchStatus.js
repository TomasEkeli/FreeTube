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
 * Note that a channel was rate limited. Counted separately from errors because
 * being blocked says something different from a channel being broken, and it is
 * the number that tells you to back off rather than investigate.
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
 * Close collection and, if any channel was left unresolved, show one summary.
 *
 * The count that matters is channels the refresh could not get, which is not the
 * number of errors: one channel can error at every rung of its retry ladder, and
 * the ladder usually recovers it by falling back to another source. A run that
 * logged forty-two errors but resolved all but eight of them should say eight,
 * and a run whose ladder recovered everything should say nothing at all. So the
 * caller passes in the channels actually left unresolved, being the only party
 * that knows.
 *
 * @param {string} feed
 * @param {{ id: string, name?: string }[]} [unresolvedChannels]
 * @returns {FetchErrorCollector | undefined}
 */
export function endFetchErrorCollection(feed, unresolvedChannels = []) {
  const collector = collectors.get(feed)

  if (collector == null) { return }

  collectors.delete(feed)

  if (unresolvedChannels.length === 0) { return collector }

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

  return collector
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
    `${collector.errors.length} failed attempt(s) in total, ${collector.rateLimited} rate limited`,
    '',
    'Channels left unresolved:'
  ]

  for (const channel of unresolvedChannels) {
    lines.push(`  ${channel.name ?? channel.id} (${channel.id})`)
  }

  // Every attempt, including the ones a fallback went on to recover, because
  // which rung failed is the useful part when working out what is wrong
  lines.push('', 'All failed attempts:')

  for (const { channelId, channelName, api, error } of collector.errors) {
    lines.push(`  ${channelName} (${channelId}) via ${api}: ${error}`)
  }

  return lines.join('\n')
}
