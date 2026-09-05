import store from '../../store/index'

import { videosFeed } from './videos'
import { shortsFeed } from './shorts'
import { liveFeed } from './live'
import { postsFeed } from './posts'

/**
 * Every subscription feed, and what each one needs to be fetched and shown.
 *
 * The four tab components were copies of each other: the same state, the same
 * cache-or-remote decision, the same batching, the same progress bar handling,
 * differing only in which store keys and fetch functions they named. The
 * composable took the shared behaviour; this takes what genuinely differs.
 *
 * The tabs are gone now — one stream shows every kind at once — and what is
 * left of a feed is exactly this: where its entries are cached, how they are
 * fetched, and how they are filtered before assembly.
 *
 * @typedef {object} SubscriptionFeedDescriptor
 * @property {string} feed identifier used for tracing, caching and error collection
 * @property {string} cacheGetter store getter holding this feed's cache
 * @property {string} updateAction store action that writes one channel's entries
 * @property {'videos' | 'posts'} entriesKey field name inside a cache entry
 * @property {'setting' | 'always' | 'never'} rssMode where RSS use is decided.
 *   `never` is not a preference but a fact about what YouTube publishes: with
 *   no RSS to read there is nothing lighter to read, whatever the setting says.
 * @property {boolean} followsDetailBackfill whether this feed's entries can be
 *   filled in in the background, and so needs rebuilding when they are
 * @property {() => boolean} isEnabled whether the user has this feed switched
 *   on, which decides whether it is shown and nothing else. What is fetched is
 *   a separate question with a separate answer: every feed, every time.
 * @property {(channel: object, context: { useRss: boolean, failedAttempts?: number }) => Promise<{
 *   status: string, entries: any[] | null, name?: string, thumbnailUrl?: string
 * }>} fetchChannel
 * @property {(entries: any[]) => any[]} postProcess filter and sort for display
 */

/** @type {Record<string, SubscriptionFeedDescriptor>} */
const DESCRIPTORS = {
  videos: videosFeed,
  shorts: shortsFeed,
  live: liveFeed,
  posts: postsFeed
}

/**
 * The order feeds are refreshed in, and the order they are assembled into the
 * stream in — which decides only which kind an entry two feeds both claim is
 * counted as, since the stream itself is sorted by date.
 */
export const SUBSCRIPTION_FEEDS = ['videos', 'shorts', 'live', 'posts']

/**
 * @param {string} feed
 * @returns {SubscriptionFeedDescriptor}
 */
export function subscriptionFeedDescriptor(feed) {
  const descriptor = DESCRIPTORS[feed]

  if (descriptor == null) {
    throw new Error(`unknown subscription feed: ${feed}`)
  }

  return descriptor
}

/**
 * The feeds the user has switched on. What the stream is assembled from, and
 * the answer to that question only.
 *
 * @returns {string[]}
 */
export function enabledSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.filter(feed => DESCRIPTORS[feed].isEnabled())
}

/**
 * The feeds a refresh fetches: every one of them, whatever is switched on.
 *
 * Deliberately not `enabledSubscriptionFeeds()` filtered down, and deliberately
 * a function of its own rather than a list read off the one above. What is
 * shown and what is fetched were the same list once, and the cost of that was a
 * kind switched off going stale: switching it back on showed yesterday, and
 * then a spinner. Switching a kind on is meant to be instant, and it can only
 * be instant if what it was hiding had been fetched anyway.
 *
 * Fetching four kinds where one was fetched costs roughly double, mostly posts,
 * which are the one kind RSS cannot serve. That was weighed and accepted: the
 * request manager's budget and lanes pace it, and nothing here throttles.
 *
 * @returns {string[]}
 */
export function fetchedSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.slice()
}

/**
 * Whether this feed is fetched over RSS. Read once per refresh, so that
 * changing the setting midway cannot split one refresh across both strategies.
 *
 * @param {string} feed
 */
export function subscriptionFeedUsesRss(feed) {
  switch (subscriptionFeedDescriptor(feed).rssMode) {
    case 'always':
      return true
    case 'never':
      return false
    default:
      return store.getters.getUseRssFeeds
  }
}
