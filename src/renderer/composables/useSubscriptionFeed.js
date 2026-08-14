import { computed, onMounted, ref, shallowRef, watch } from 'vue'

import store from '../store/index'

import { subscriptionFeedDescriptor } from '../helpers/subscriptionFeeds'
import {
  cancelSubscriptionRefresh,
  refreshAllSubscriptionFeeds,
  refreshSubscriptionFeeds,
  subscriptionFeedState
} from '../helpers/subscriptionRefresh'
import { unavailableChannels } from '../helpers/subscriptionFetchStatus'
import { detailBackfillRevision } from '../helpers/subscriptionDetailBackfill'
import { getRelativeTimeFromDate } from '../helpers/utils'

/**
 * One subscription feed, as the tab showing it sees it.
 *
 * This used to own the refresh as well, which was the trouble: the refresh
 * outlives the tab, and a composable instance does not. It now only subscribes
 * and renders. The cache is the record of what has been fetched, the feed's
 * revision says when that record changed, and this rebuilds the list from the
 * cache whenever it does — so a refresh that finishes while its tab is unmounted
 * is picked up whenever the tab comes back, instead of being written into a ref
 * nobody is holding.
 *
 * @param {string} feed 'videos' | 'shorts' | 'live' | 'posts'
 */
export function useSubscriptionFeed(feed) {
  const { cacheGetter, entriesKey, postProcess, followsDetailBackfill } = subscriptionFeedDescriptor(feed)
  const state = subscriptionFeedState(feed)

  /** There is nothing to look at yet. A refresh behind an existing feed is not this. */
  const isLoading = ref(true)

  const entryList = shallowRef([])

  /** Channels that are gone rather than unreachable, so they can be unsubscribed from. */
  const errorChannels = computed(() => unavailableChannels(feed))

  let alreadyLoadedRemotely = false

  /** @type {import('vue').ComputedRef<boolean>} */
  const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

  /** @type {import('vue').ComputedRef<boolean>} */
  const fetchSubscriptionsAutomatically = computed(() => store.getters.getFetchSubscriptionsAutomatically)

  const activeSubscriptionList = computed(() => store.getters.getActiveProfile.subscriptions)

  const cacheEntriesForAllActiveProfileChannels = computed(() => {
    const cache = store.getters[cacheGetter]
    const entries = []

    activeSubscriptionList.value.forEach((channel) => {
      const cacheEntry = cache[channel.id]

      if (cacheEntry != null) {
        entries.push(cacheEntry)
      }
    })

    return entries
  })

  const cacheForAllActiveProfileChannelsPresent = computed(() => {
    if (
      cacheEntriesForAllActiveProfileChannels.value.length === 0 ||
      cacheEntriesForAllActiveProfileChannels.value.length < activeSubscriptionList.value.length
    ) {
      return false
    }

    return cacheEntriesForAllActiveProfileChannels.value.every((cacheEntry) => {
      return cacheEntry[entriesKey] != null
    })
  })

  const lastRefreshTimestamp = computed(() => {
    // Cache is not ready when data is just loaded from remote
    if (state.lastSuccessAt.value) {
      return getRelativeTimeFromDate(state.lastSuccessAt.value, true)
    }

    if (
      !cacheForAllActiveProfileChannelsPresent.value ||
      cacheEntriesForAllActiveProfileChannels.value.length === 0
    ) {
      return ''
    }

    let minTimestamp = null

    cacheEntriesForAllActiveProfileChannels.value.forEach((cacheEntry) => {
      if (!minTimestamp || cacheEntry.timestamp.getTime() < minTimestamp.getTime()) {
        minTimestamp = cacheEntry.timestamp
      }
    })

    return getRelativeTimeFromDate(minTimestamp.getTime(), true)
  })

  /**
   * Put what the cache holds on screen.
   *
   * This is the only thing that ever fills the list. A refresh commits by
   * writing the cache and bumping the revision, which lands here; so does the
   * recovery, and so does anything else that changes what is known.
   */
  function rebuildFromCache() {
    const entries = cacheEntriesForAllActiveProfileChannels.value.flatMap((cacheEntry) => {
      return cacheEntry[entriesKey] ?? []
    })

    entryList.value = postProcess(entries)
    isLoading.value = false
  }

  /** @returns {boolean} whether there was anything worth showing */
  function showCacheIfPresent() {
    if (!subscriptionCacheReady.value) { return false }
    if (!cacheForAllActiveProfileChannelsPresent.value) { return false }

    rebuildFromCache()

    return true
  }

  function loadFromCacheSometimes() {
    // Can only load reliably when cache ready
    if (!subscriptionCacheReady.value) { return }

    if (showCacheIfPresent()) { return }

    if (state.isRefreshing.value) {
      // A refresh started by another tab, or before this one was mounted, is
      // already fetching this feed. Wait for it rather than asking again.
      isLoading.value = true
      return
    }

    if (fetchSubscriptionsAutomatically.value) {
      // Deliberately not keeping what is on screen, unlike a refresh or the
      // first load. Getting here means the cache cannot supply this profile, so
      // whatever is displayed belongs to a different set of channels and leaving
      // it up would be showing the wrong feed.
      entryList.value = []
      isLoading.value = true
      refreshAllSubscriptionFeeds({ preferredFeed: feed })
      return
    }

    // Auto fetch disabled, not enough cache for profile = show nothing
    entryList.value = []
    state.attemptedFetch.value = false
    isLoading.value = false
  }

  function loadFromRemoteFirstPerWindowSometimes() {
    if (
      !fetchSubscriptionsAutomatically.value ||
      // Only auto fetch once per window, for every feed at once
      store.getters.getSubscriptionsFirstAutoFetchRun
    ) {
      loadFromCacheSometimes()
      return
    }

    alreadyLoadedRemotely = true

    // Put the cached feed up first if there is one. It is a few seconds old at
    // worst and entirely readable, where the alternative is half a minute of
    // empty page before anything appears at all. The refresh then runs behind it
    // and replaces it in one go, rather than growing the list underneath whoever
    // is reading it.
    if (!showCacheIfPresent()) {
      isLoading.value = true
    }

    store.commit('setSubscriptionsFirstAutoFetchRun')
    refreshAllSubscriptionFeeds({ preferredFeed: feed })
  }

  /**
   * Refresh because someone asked for one.
   *
   * With automatic fetching on, that means every feed: they are all going to be
   * fetched this window anyway, and the one being looked at is fetched first so
   * it lands at the speed it always did. With automatic fetching off, the user
   * is deliberately economising on requests, so a refresh buys exactly the feed
   * that was asked for.
   *
   * The feed already on screen is for this same profile and is still perfectly
   * readable, so it stays up while the refresh runs behind it, exactly as it
   * does on startup. Replacing it with a spinner for the half minute that six
   * hundred channels take hides the thing being read in order to announce that
   * it is being brought up to date. Only when there is nothing on screen does
   * the spinner make sense.
   *
   * Takes no arguments deliberately: it is bound to a template event, and a
   * payload arriving as an options object would quietly change what it does.
   */
  function refresh() {
    if (entryList.value.length === 0) {
      isLoading.value = true
    }

    if (fetchSubscriptionsAutomatically.value) {
      return refreshAllSubscriptionFeeds({ preferredFeed: feed })
    }

    return refreshSubscriptionFeeds([feed])
  }

  watch(state.revision, rebuildFromCache)

  watch(state.isRefreshing, (refreshing) => {
    // A refresh that ends without committing — cancelled, or superseded by a
    // profile switch — still has to take the spinner down with it
    if (!refreshing && isLoading.value) {
      isLoading.value = false
    }
  })

  /**
   * Which channels this profile holds, as one string.
   *
   * Deliberately not the list itself, deeply watched, as it used to be. A
   * refresh writes back the channel names and avatars it learned, which replaces
   * the profile object; watching the list therefore meant every finishing feed
   * announced itself as a profile change, and a profile change cancels the
   * refresh. The first feed to finish would have cancelled the other two.
   *
   * What is actually being watched for is the set of channels changing:
   * switching profile, subscribing, unsubscribing.
   */
  const activeProfileChannelIds = computed(() => {
    return activeSubscriptionList.value.map(channel => channel.id).join()
  })

  watch(activeProfileChannelIds, () => {
    // Everything queued is for channels nobody is looking at any more
    cancelSubscriptionRefresh()

    isLoading.value = true
    loadFromCacheSometimes()
  })

  if (followsDetailBackfill) {
    // The back-fill writes straight into the entry objects this list already
    // holds, and a shallowRef says nothing about that. Rebuilding the array is
    // what makes the new details appear: it triggers the ref, and the entries
    // that changed now carry a different key, so those items are rebuilt and
    // read their props again. Order does not change, because the merge leaves
    // the publish time alone.
    watch(detailBackfillRevision, () => {
      if (entryList.value.length === 0) { return }

      entryList.value = postProcess(entryList.value.slice())
    })
  }

  if (!subscriptionCacheReady.value) {
    watch(subscriptionCacheReady, () => {
      if (!alreadyLoadedRemotely) {
        loadFromCacheSometimes()
        return
      }

      // The cache finishes loading after this view is mounted, so the automatic
      // refresh on startup begins before there is anything to show. As soon as
      // there is, put it up: waiting for the refresh means half a minute of
      // empty page while holding a perfectly readable copy.
      if (entryList.value.length === 0) {
        showCacheIfPresent()
      }
    })
  }

  onMounted(() => {
    loadFromRemoteFirstPerWindowSometimes()
  })

  return {
    isLoading,
    isRefreshing: state.isRefreshing,
    entryList,
    errorChannels,
    attemptedFetch: state.attemptedFetch,
    lastRefreshTimestamp,
    refresh
  }
}
