import { computed, onMounted, ref, shallowRef, watch } from 'vue'

import store from '../store/index'

import { subscriptionFeedDescriptor, subscriptionFeedIsAvailable } from '../helpers/subscriptionFeeds'
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

  /**
   * Whether the cache can supply this feed for the whole active profile.
   *
   * False for a feed nobody has fetched, and false again when a fetch left any
   * channel out, so it answers whether this feed is complete rather than
   * whether anyone has tried.
   */
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

  /**
   * Whether the cache holds this feed for any of the active profile's channels.
   *
   * What the tab asks before offering to fetch a feed that nothing fetches on
   * its own. `cacheForAllActiveProfileChannelsPresent` is the stricter
   * neighbour and answers whether the feed is complete, which is the wrong
   * question here: a fetch that reached 597 of 600 channels leaves the feed
   * incomplete for good, and covering those 597 channels' posts with an
   * explanation of a setting would be a strange answer to the button that
   * fetched them.
   *
   * An empty array is a real answer and counts, which is how a profile whose
   * channels have posted nothing is told from one nobody has fetched.
   */
  const cacheHasAnyEntriesForActiveProfile = computed(() => {
    return cacheEntriesForAllActiveProfileChannels.value.some((cacheEntry) => {
      return cacheEntry[entriesKey] != null
    })
  })

  /**
   * Whether an automatic refresh started now would fetch this feed. A request
   * naming the feed is exempt, and is how this one is ever fetched at all while
   * the setting behind it is on.
   *
   * Computed so that every reader gets the setting as it stands, rather than as
   * it stood when the tab was mounted.
   *
   * @type {import('vue').ComputedRef<boolean>}
   */
  const refreshWouldFetchThisFeed = computed(() => subscriptionFeedIsAvailable(feed))

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

  /**
   * Show what the cache holds and stop waiting, because nothing is coming.
   *
   * The loader starts up and comes down when `isRefreshing` falls. For a feed
   * every refresh skips, that fall never happens, because it never rose: the
   * refresh drops the feed inside `refreshSubscriptionFeeds`, and nothing of
   * this feed's state changes at all. Whatever the cache holds, including
   * nothing, is the whole answer until someone asks for a fetch by name.
   */
  function settleWithoutRefresh() {
    rebuildFromCache()
  }

  /**
   * @param {object} options
   * @param {'profile' | 'cache-miss'} options.reason why this is being asked,
   *   which decides how much gets fetched if anything must be
   */
  function loadFromCacheSometimes({ reason }) {
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
      if (!refreshWouldFetchThisFeed.value) {
        // The refresh below would drop this feed, and a refresh that never
        // starts never takes the loader down again. The branch underneath, for
        // automatic fetching off, settles by itself and is left alone.
        settleWithoutRefresh()

        // The other feeds still want the refresh a profile switch calls for.
        // This tab is the only one mounted, so if it says nothing on their
        // behalf nobody does, and they are each left to discover the new
        // profile whenever they are next looked at.
        if (reason === 'profile') {
          refreshAllSubscriptionFeeds({ preferredFeed: feed, reason })
        }

        return
      }

      // Deliberately not keeping what is on screen, unlike a refresh or the
      // first load. Getting here means the cache cannot supply this profile, so
      // whatever is displayed belongs to a different set of channels and leaving
      // it up would be showing the wrong feed.
      entryList.value = []
      isLoading.value = true

      // A profile switch invalidates every feed, so every feed is fetched. A
      // cache that merely cannot supply this one feed is about this one feed:
      // starting a whole cycle for it would mean navigating back to the
      // subscriptions page could re-fetch six hundred channels three times over.
      if (reason === 'profile') {
        refreshAllSubscriptionFeeds({ preferredFeed: feed, reason })
      } else {
        refreshSubscriptionFeeds([feed], { reason })
      }

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
      loadFromCacheSometimes({ reason: 'cache-miss' })
      return
    }

    alreadyLoadedRemotely = true

    // Put the cached feed up first if there is one. It is a few seconds old at
    // worst and entirely readable, where the alternative is half a minute of
    // empty page before anything appears at all. The refresh then runs behind it
    // and replaces it in one go, rather than growing the list underneath whoever
    // is reading it.
    if (!showCacheIfPresent()) {
      if (refreshWouldFetchThisFeed.value) {
        isLoading.value = true
      } else if (subscriptionCacheReady.value) {
        // The refresh below covers the other feeds and not this one. `isLoading`
        // starts true, so saying nothing here leaves the loader up for good.
        settleWithoutRefresh()
      }

      // A cache that is merely still loading is the other reason
      // `showCacheIfPresent` says no, and then the loader is honest: the watch
      // on `subscriptionCacheReady` settles it once there is something to
      // settle with.
    }

    store.commit('setSubscriptionsFirstAutoFetchRun')
    refreshAllSubscriptionFeeds({ preferredFeed: feed, reason: 'auto' })
  }

  /**
   * Put the spinner up before a fetch, but only when there is nothing behind
   * it.
   *
   * The feed already on screen is for this same profile and is still perfectly
   * readable, so it stays up while the refresh runs behind it, exactly as it
   * does on startup. Replacing it with a spinner for the half minute that six
   * hundred channels take hides the thing being read in order to announce that
   * it is being brought up to date.
   */
  function showLoaderIfEmpty() {
    if (entryList.value.length === 0) {
      isLoading.value = true
    }
  }

  /**
   * Refresh because someone asked for one, from the widget over the feed.
   *
   * With automatic fetching on, that means every feed: they are all going to be
   * fetched this window anyway, and the one being looked at is fetched first so
   * it lands at the speed it always did. With automatic fetching off, the user
   * is deliberately economising on requests, so a refresh buys exactly the feed
   * that was asked for.
   *
   * `requestedFeed` says the feed was named by hand, which is what refetches
   * posts while RSS is on. Every automatic path omits it, and so goes on
   * skipping the feeds a setting says to skip.
   *
   * Takes no arguments deliberately: it is bound to a template event, and a
   * payload arriving as an options object would quietly change what it does.
   */
  function refresh() {
    showLoaderIfEmpty()

    if (fetchSubscriptionsAutomatically.value) {
      return refreshAllSubscriptionFeeds({ preferredFeed: feed, reason: 'button', requestedFeed: feed })
    }

    return refreshSubscriptionFeeds([feed], { reason: 'button', requestedFeed: feed })
  }

  /**
   * Fetch this feed, and only this feed, because this feed is what was asked
   * for.
   *
   * The sister of `refresh()`, and narrower on purpose. A refresh widget sits
   * over a feed that automatic refreshes keep up to date, so with automatic
   * fetching on it may as well bring the other three along. The button this is
   * for appears when a setting is holding one feed back, and the user who set
   * that setting asked for fewer requests: fetching the other three because
   * they pressed the one that says posts would be the opposite of what they
   * asked for.
   *
   * What it cannot keep to itself is the recovery: `startFeedRefresh` treats
   * any refresh as superseding the one global recovery escalation, so pressing
   * this while another feed is retrying its unreachable channels abandons that
   * retry. One feed's worth of channels is still the smaller cost.
   *
   * Takes no arguments, for the same reason `refresh()` does not: it is bound
   * to a template event, and a payload arriving as an options object would
   * quietly change what it does.
   */
  function refreshThisFeed() {
    showLoaderIfEmpty()

    return refreshSubscriptionFeeds([feed], { reason: 'load', requestedFeed: feed })
  }

  watch(state.revision, rebuildFromCache)

  /**
   * A cache write from an other window arrives here as a store mutation, with
   * none of the revision bump that the same write in this window would have
   * carried, so nothing rebuilds. The tab reads the cache to decide whether to
   * explain itself and reads the list to fill itself in, and those two coming
   * apart is what leaves a window saying the channels have no posts while the
   * cache in front of it holds some.
   *
   * Rebuilding when the cache stops being empty puts them back together, which
   * is exactly the condition the explanation is keyed to. It does not follow
   * every later write: one window's feed lagging another's is how this has
   * always worked, and rebuilding on each of six hundred channels would be a
   * poor way to fix it.
   *
   * Not while this window is refreshing, because then the revision bump is
   * already coming, and it is what replaces the feed in one go rather than
   * growing it underneath whoever is reading.
   */
  watch(cacheHasAnyEntriesForActiveProfile, (present) => {
    if (!present || state.isRefreshing.value) { return }

    rebuildFromCache()
  })

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
    loadFromCacheSometimes({ reason: 'profile' })
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
        loadFromCacheSometimes({ reason: 'cache-miss' })
        return
      }

      if (!refreshWouldFetchThisFeed.value) {
        // The cache arriving is the last thing that was going to happen to this
        // feed, so it is the whole answer, complete or not. A profile switched
        // while the cache was still loading gets here too, having left the
        // loader up on its way past.
        settleWithoutRefresh()
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
    // How the tab tells a feed with nothing behind it from one that was
    // fetched and found nothing. An empty list cannot: it would put the
    // explanation back up after a successful fetch of a profile whose channels
    // have posted nothing, and look like the button did nothing.
    cacheHasAnyEntriesForActiveProfile,
    lastRefreshTimestamp,
    refresh,
    refreshThisFeed
  }
}
