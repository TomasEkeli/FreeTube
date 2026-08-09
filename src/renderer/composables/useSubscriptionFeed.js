import { computed, onMounted, ref, shallowRef, watch } from 'vue'

import store from '../store/index'

import {
  processInChunks,
  SUBSCRIPTION_CHUNK_DELAY_MS,
  SUBSCRIPTION_RSS_CHUNK_SIZE,
  SUBSCRIPTION_SCRAPER_CHUNK_SIZE
} from '../helpers/subscriptions'
import { getRelativeTimeFromDate } from '../helpers/utils'
import {
  beginSubscriptionTrace,
  endSubscriptionTrace,
  traceChannelFetch
} from '../helpers/subscriptionTrace'
import {
  beginFetchErrorCollection,
  endFetchErrorCollection,
  isRetryableFetchStatus,
  reportRateLimited,
  showFetchErrorSummary,
  FETCH_RATE_LIMITED
} from '../helpers/subscriptionFetchStatus'
import { detailBackfillRevision } from '../helpers/subscriptionDetailBackfill'
import { injectedFetchFailure } from '../helpers/subscriptionFailureInjection'
import {
  cancelSubscriptionRecovery,
  recoverUnresolvedChannels,
  NO_RETRY_ATTEMPTS
} from '../helpers/subscriptionRecovery'

/**
 * The parts of a subscription feed that are the same for videos, live streams,
 * shorts and community posts.
 *
 * The four tab components were copies of each other: the same state, the same
 * cache-or-remote decision, the same batching, the same progress bar handling,
 * differing only in which store keys and fetch functions they named. Keeping
 * four copies meant every change to the shared behaviour had to be made four
 * times and agree four times, which it did not always do. Shorts never got the
 * batching the others had, and Posts never got the null guard on its cache
 * write.
 *
 * What genuinely differs stays with the caller, in the descriptor: the fetch
 * functions and their retry ladders, whether RSS applies, and how a finished
 * list is filtered and sorted.
 *
 * @typedef {object} SubscriptionFeedDescriptor
 * @property {string} feed identifier used for tracing and error collection
 * @property {string} cacheGetter store getter holding this feed's cache
 * @property {string} updateAction store action that writes one channel's entries
 * @property {'videos' | 'posts'} entriesKey field name inside a cache entry
 * @property {string} autoFetchGetter getter for the once-per-window fetch flag
 * @property {string} autoFetchMutation mutation that sets it
 * @property {'setting' | 'always' | 'never'} rssMode where RSS use is decided
 * @property {(channel: object, context: { useRss: boolean }) => Promise<{
 *   status: string, entries: any[] | null, name?: string, thumbnailUrl?: string
 * }>} fetchChannel
 * @property {(entries: any[]) => any[]} postProcess filter and sort for display
 * @property {boolean} [followsDetailBackfill] whether this feed's entries can be
 *   filled in in the background, and so needs rebuilding when they are
 */

/**
 * @param {SubscriptionFeedDescriptor} descriptor
 */
export function useSubscriptionFeed(descriptor) {
  const {
    feed,
    cacheGetter,
    updateAction,
    entriesKey,
    autoFetchGetter,
    autoFetchMutation,
    rssMode,
    fetchChannel,
    postProcess,
    followsDetailBackfill = false
  } = descriptor

  const isLoading = ref(true)

  /**
   * A remote refresh is in flight. Distinct from isLoading, which means "there
   * is nothing to look at yet": a refresh behind an existing feed is running
   * without being loading.
   */
  const isRefreshing = ref(false)

  const entryList = shallowRef([])

  /**
   * Channels that are gone rather than unreachable: shown to the user so they
   * can unsubscribe.
   * @type {import('vue').Ref<object[]>}
   */
  const errorChannels = ref([])

  /**
   * Channels whose last fetch failed in a way worth retrying. Distinct from
   * `errorChannels`: these are expected to come back.
   * @type {import('vue').Ref<object[]>}
   */
  const unresolvedChannels = ref([])

  const attemptedFetch = ref(false)

  /** @type {import('vue').Ref<number | null>} */
  const lastRemoteRefreshSuccessTimestamp = ref(null)

  let alreadyLoadedRemotely = false

  /** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
  const backendPreference = computed(() => store.getters.getBackendPreference)

  /** @type {import('vue').ComputedRef<boolean>} */
  const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

  /** @type {import('vue').ComputedRef<boolean>} */
  const fetchSubscriptionsAutomatically = computed(() => store.getters.getFetchSubscriptionsAutomatically)

  /** @type {import('vue').ComputedRef<boolean>} */
  const useRssFeeds = computed(() => {
    switch (rssMode) {
      case 'always':
        return true
      case 'never':
        return false
      default:
        return store.getters.getUseRssFeeds
    }
  })

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
    if (lastRemoteRefreshSuccessTimestamp.value) {
      return getRelativeTimeFromDate(lastRemoteRefreshSuccessTimestamp.value, true)
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

  function loadFromCacheForAllActiveProfileChannels() {
    const entries = cacheEntriesForAllActiveProfileChannels.value.flatMap((cacheEntry) => {
      return cacheEntry[entriesKey]
    })

    entryList.value = postProcess(entries)
    isLoading.value = false
  }

  function loadFromCacheSometimes() {
    // Can only load reliably when cache ready
    if (!subscriptionCacheReady.value) { return }

    // This method is called on view visible
    if (cacheForAllActiveProfileChannelsPresent.value) {
      loadFromCacheForAllActiveProfileChannels()
      return
    }

    if (fetchSubscriptionsAutomatically.value) {
      // Deliberately not keeping what is on screen, unlike a refresh or the
      // first load. Getting here means the cache cannot supply this profile, so
      // whatever is displayed belongs to a different set of channels and
      // leaving it up would be showing the wrong feed.
      // `isLoading.value = false` is called inside `loadFromRemote` when needed
      loadFromRemote()
      return
    }

    // Auto fetch disabled, not enough cache for profile = show nothing
    entryList.value = []
    attemptedFetch.value = false
    isLoading.value = false
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.keepShowingCurrentEntries] refresh without
   *   emptying the feed first, for when there is already something worth reading
   */
  async function loadFromRemote({ keepShowingCurrentEntries = false } = {}) {
    if (activeSubscriptionList.value.length === 0) {
      isLoading.value = false
      entryList.value = []
      return
    }

    // A refresh supersedes any recovery still working through the last one
    cancelSubscriptionRecovery()

    const channelsToLoadFromRemote = activeSubscriptionList.value
    let channelCount = 0

    // The spinner replaces the feed with a hole, so it is only right when there
    // is nothing to replace. Six hundred channels take half a minute, which is
    // a long time to look at a hole while holding a perfectly good cached copy.
    if (!keepShowingCurrentEntries) {
      isLoading.value = true
    }

    isRefreshing.value = true

    // Read once, so that changing the setting midway cannot split one refresh
    // across both strategies
    const useRss = useRssFeeds.value

    store.commit('setShowProgressBar', true)
    store.commit('setProgressBarPercentage', 0)
    attemptedFetch.value = true

    errorChannels.value = []
    unresolvedChannels.value = []

    const subscriptionUpdates = []

    beginSubscriptionTrace(feed, {
      channelCount: channelsToLoadFromRemote.length,
      useRss,
      backend: backendPreference.value
    })
    beginFetchErrorCollection(feed, channelsToLoadFromRemote.length)

    const processChannel = async (channel) => {
      let result

      const traceDone = traceChannelFetch(feed, channel.id)

      try {
        // Only ever returns anything when FT_SUBS_FAIL is set, and the whole
        // branch is removed from a build that does not set it
        result = injectedFetchFailure() ?? await fetchChannel(channel, { useRss })
      } finally {
        traceDone({
          entries: result?.entries?.length ?? null,
          outcome: result?.status ?? 'threw'
        })
      }

      const { status, entries } = result

      // Counted here rather than where the 403 is read, so that the tally
      // follows from the outcome itself. Anything that produces a rate limited
      // channel is counted, without each fetch path having to remember to say
      // so, which is how injected failures came to report none at all.
      if (status === FETCH_RATE_LIMITED) {
        reportRateLimited(feed)
      }

      if (isRetryableFetchStatus(status)) {
        unresolvedChannels.value.push(channel)
      }

      channelCount++
      store.commit('setProgressBarPercentage', (channelCount / channelsToLoadFromRemote.length) * 100)

      cacheChannelResult(channel, result, subscriptionUpdates)

      return entries ?? []
    }

    const results = await processInChunks(channelsToLoadFromRemote, processChannel, {
      chunkSize: useRss ? SUBSCRIPTION_RSS_CHUNK_SIZE : SUBSCRIPTION_SCRAPER_CHUNK_SIZE,
      delayMs: SUBSCRIPTION_CHUNK_DELAY_MS
    })

    endSubscriptionTrace(feed)

    const collector = endFetchErrorCollection(feed)

    entryList.value = postProcess(results.flat())
    isLoading.value = false
    isRefreshing.value = false
    store.commit('setShowProgressBar', false)
    lastRemoteRefreshSuccessTimestamp.value = Date.now()

    store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates)

    if (!startRecoveryIfNeeded(useRss, collector)) {
      // Nothing more is going to be attempted, so now it is worth saying
      showFetchErrorSummary(feed, collector, unresolvedChannels.value)
    }
  }

  /**
   * Write one channel's result to the cache and note any change to its name or
   * avatar. Shared by the refresh and by the recovery, so that a channel
   * recovered later is stored exactly as one fetched first time would have been.
   *
   * @param {object} channel
   * @param {{ entries: any[] | null, name?: string, thumbnailUrl?: string }} result
   * @param {object[]} subscriptionUpdates collected, to be dispatched in one go
   */
  function cacheChannelResult(channel, { entries, name, thumbnailUrl }, subscriptionUpdates) {
    // null means the fetch failed, so leave whatever we already had alone.
    // An empty array is a real answer and is worth caching.
    if (entries != null) {
      store.dispatch(updateAction, {
        channelId: channel.id,
        [entriesKey]: entries
      })
    }

    if (name || thumbnailUrl) {
      subscriptionUpdates.push({
        channelId: channel.id,
        channelName: name,
        channelThumbnailUrl: thumbnailUrl
      })
    }
  }

  /**
   * Go after the channels the refresh could not reach, in the background.
   *
   * Deliberately does not touch the loading state: the feed shows what the
   * refresh did manage and grows as the rest arrives, which is the difference
   * between this and simply refreshing again.
   *
   * @param {boolean} useRss
   * @param {object | undefined} collector the failures the refresh collected,
   *   held back so they can be reported only if recovery cannot resolve them
   * @returns {boolean} whether recovery took responsibility for them
   */
  function startRecoveryIfNeeded(useRss, collector) {
    if (!store.getters.getSubscriptionAutoRecovery) { return false }
    if (unresolvedChannels.value.length === 0) { return false }

    const subscriptionUpdates = []

    recoverUnresolvedChannels({
      feed,
      channels: unresolvedChannels.value.slice(),
      // Injected failures apply here too, or a simulated outage would clear the
      // moment recovery started and the later steps would never be reached.
      // Retries suppressed: sending more requests because requests are being
      // refused is exactly the wrong response to being refused.
      fetchChannel: channel => injectedFetchFailure() ??
        fetchChannel(channel, { useRss, failedAttempts: NO_RETRY_ATTEMPTS }),
      onRecovered: (results) => {
        const recoveredEntries = []

        for (const { channel, result } of results) {
          cacheChannelResult(channel, result, subscriptionUpdates)
          recoveredEntries.push(...(result.entries ?? []))

          const stillUnresolved = unresolvedChannels.value.filter(unresolved => unresolved.id !== channel.id)
          unresolvedChannels.value = stillUnresolved
        }

        if (recoveredEntries.length > 0) {
          entryList.value = postProcess(entryList.value.concat(recoveredEntries))
        }

        if (subscriptionUpdates.length > 0) {
          store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates.splice(0))
        }
      }
    }).then(() => {
      // Now that nothing further will be attempted, whatever is still missing
      // is worth mentioning. A recovery that got everything back says nothing.
      showFetchErrorSummary(feed, collector, unresolvedChannels.value)
    })

    return true
  }

  function loadFromRemoteFirstPerWindowSometimes() {
    if (
      !fetchSubscriptionsAutomatically.value ||
      // Only auto fetch once per window
      store.getters[autoFetchGetter]
    ) {
      loadFromCacheSometimes()
      return
    }

    alreadyLoadedRemotely = true

    // Put the cached feed up first if there is one. It is a few seconds old at
    // worst and entirely readable, where the alternative is half a minute of
    // empty page before anything appears at all. The refresh then runs behind
    // it and replaces it in one go, rather than growing the list underneath
    // whoever is reading it.
    const haveSomethingToShow = subscriptionCacheReady.value &&
      cacheForAllActiveProfileChannelsPresent.value

    if (haveSomethingToShow) {
      loadFromCacheForAllActiveProfileChannels()
    }

    loadFromRemote({ keepShowingCurrentEntries: haveSomethingToShow })
    store.commit(autoFetchMutation)
  }

  /**
   * Refresh because someone asked for one.
   *
   * The feed already on screen is for this same profile and is still perfectly
   * readable, so it stays up while the refresh runs behind it, exactly as it
   * does on startup. Replacing it with a spinner for the half minute that six
   * hundred channels take hides the thing being read in order to announce that
   * it is being brought up to date.
   *
   * Only when there is nothing on screen does the spinner make sense. Otherwise
   * the empty-feed message would sit there for the whole refresh insisting
   * there is nothing to show.
   *
   * Takes no arguments deliberately: it is bound to a template event, and a
   * payload arriving as an options object would quietly change what it does.
   */
  function refresh() {
    return loadFromRemote({ keepShowingCurrentEntries: entryList.value.length > 0 })
  }

  watch(activeSubscriptionList, () => {
    // Switching profile means the channels being recovered are for a feed
    // nobody is looking at any more
    cancelSubscriptionRecovery()

    lastRemoteRefreshSuccessTimestamp.value = null
    isLoading.value = true
    loadFromCacheSometimes()
  }, { deep: true })

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
      if (entryList.value.length === 0 && cacheForAllActiveProfileChannelsPresent.value) {
        loadFromCacheForAllActiveProfileChannels()
      }
    })
  }

  onMounted(() => {
    loadFromRemoteFirstPerWindowSometimes()
  })

  return {
    isLoading,
    isRefreshing,
    entryList,
    errorChannels,
    unresolvedChannels,
    attemptedFetch,
    lastRefreshTimestamp,
    refresh
  }
}
