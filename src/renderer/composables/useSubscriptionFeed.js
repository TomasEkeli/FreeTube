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
  isRetryableFetchStatus
} from '../helpers/subscriptionFetchStatus'

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
    postProcess
  } = descriptor

  const isLoading = ref(true)
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
      // `isLoading.value = false` is called inside `loadFromRemote` when needed
      loadFromRemote()
      return
    }

    // Auto fetch disabled, not enough cache for profile = show nothing
    entryList.value = []
    attemptedFetch.value = false
    isLoading.value = false
  }

  async function loadFromRemote() {
    if (activeSubscriptionList.value.length === 0) {
      isLoading.value = false
      entryList.value = []
      return
    }

    const channelsToLoadFromRemote = activeSubscriptionList.value
    let channelCount = 0
    isLoading.value = true

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
        result = await fetchChannel(channel, { useRss })
      } finally {
        traceDone({
          entries: result?.entries?.length ?? null,
          outcome: result?.status ?? 'threw'
        })
      }

      const { status, entries, name, thumbnailUrl } = result

      if (isRetryableFetchStatus(status)) {
        unresolvedChannels.value.push(channel)
      }

      channelCount++
      store.commit('setProgressBarPercentage', (channelCount / channelsToLoadFromRemote.length) * 100)

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

      return entries ?? []
    }

    const results = await processInChunks(channelsToLoadFromRemote, processChannel, {
      chunkSize: useRss ? SUBSCRIPTION_RSS_CHUNK_SIZE : SUBSCRIPTION_SCRAPER_CHUNK_SIZE,
      delayMs: SUBSCRIPTION_CHUNK_DELAY_MS
    })

    endSubscriptionTrace(feed)
    endFetchErrorCollection(feed, unresolvedChannels.value)

    entryList.value = postProcess(results.flat())
    isLoading.value = false
    store.commit('setShowProgressBar', false)
    lastRemoteRefreshSuccessTimestamp.value = Date.now()

    store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates)
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
    loadFromRemote()
    store.commit(autoFetchMutation)
  }

  watch(activeSubscriptionList, () => {
    lastRemoteRefreshSuccessTimestamp.value = null
    isLoading.value = true
    loadFromCacheSometimes()
  }, { deep: true })

  if (!subscriptionCacheReady.value) {
    watch(subscriptionCacheReady, () => {
      if (!alreadyLoadedRemotely) {
        loadFromCacheSometimes()
      }
    })
  }

  onMounted(() => {
    loadFromRemoteFirstPerWindowSometimes()
  })

  return {
    isLoading,
    entryList,
    errorChannels,
    unresolvedChannels,
    attemptedFetch,
    lastRefreshTimestamp,
    refresh: loadFromRemote
  }
}
