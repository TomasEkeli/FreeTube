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
 * It is module scope rather than a prop of the tab because a refresh now
 * refreshes every feed, including the three whose tabs are not mounted. A
 * descriptor that only exists while its tab is on screen cannot be used to
 * fetch that feed, which is the flaw the whole manager is here to fix.
 *
 * @typedef {object} SubscriptionFeedDescriptor
 * @property {string} feed identifier used for tracing, caching and error collection
 * @property {string} cacheGetter store getter holding this feed's cache
 * @property {string} updateAction store action that writes one channel's entries
 * @property {'videos' | 'posts'} entriesKey field name inside a cache entry
 * @property {'setting' | 'always' | 'never'} rssMode where RSS use is decided
 * @property {boolean} followsDetailBackfill whether this feed's entries can be
 *   filled in in the background, and so needs rebuilding when they are
 * @property {() => boolean} isEnabled whether the user has this feed switched on
 * @property {boolean} [isCommunity] posts are rendered as a list, not a grid
 * @property {number} [initialDataLimit]
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

/** The order feeds are shown in, and refreshed in when nothing is preferred. */
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
 * The feeds the user has switched on. What a refresh covers, and what the tab
 * strip offers.
 *
 * @returns {string[]}
 */
export function enabledSubscriptionFeeds() {
  return SUBSCRIPTION_FEEDS.filter(feed => DESCRIPTORS[feed].isEnabled())
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
