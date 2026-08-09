<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :video-list="videoList"
    :error-channels="errorChannels"
    :attempted-fetch="attemptedFetch"
    :last-refresh-timestamp="lastShortRefreshTimestamp"
    :title="t('Global.Shorts')"
    @refresh="loadVideosForSubscriptionsFromRemote"
  />
</template>

<script setup>
import { computed, shallowRef, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../store/index'

import {
  parseYouTubeRSSFeed,
  processInChunks,
  updateVideoListAfterProcessing,
  SUBSCRIPTION_CHUNK_DELAY_MS,
  SUBSCRIPTION_RSS_CHUNK_SIZE
} from '../helpers/subscriptions'
import {
  getChannelPlaylistId,
  getRelativeTimeFromDate
} from '../helpers/utils'
import { invidiousFetch } from '../helpers/api/invidious'
import { beginSubscriptionTrace, endSubscriptionTrace, traceChannelFetch } from '../helpers/subscriptionTrace'
import {
  beginFetchErrorCollection,
  endFetchErrorCollection,
  isRetryableFetchStatus,
  reportFetchError,
  reportRateLimited,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE
} from '../helpers/subscriptionFetchStatus'

const { t } = useI18n()

const isLoading = ref(true)
const videoList = shallowRef([])
const errorChannels = ref([])
/**
 * Channels whose last fetch failed in a way worth retrying, as opposed to
 * `errorChannels`, which is for channels that are simply gone. Consumed by the
 * tiered recovery that retries them in smaller, slower batches.
 * @type {import('vue').Ref<{ id: string, name?: string }[]>}
 */
const unresolvedChannels = ref([])
const attemptedFetch = ref(false)
/** @type {import('vue').Ref<number | null>} */
const lastRemoteRefreshSuccessTimestamp = ref(null)

let alreadyLoadedRemotely = false

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendFallback = computed(() => store.getters.getBackendFallback)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

/** @type {import('vue').ComputedRef<boolean>} */
const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

/** @type {import('vue').ComputedRef<boolean>} */
const fetchSubscriptionsAutomatically = computed(() => store.getters.getFetchSubscriptionsAutomatically)

const activeSubscriptionList = computed(() => store.getters.getActiveProfile.subscriptions)

const cacheEntriesForAllActiveProfileChannels = computed(() => {
  const shortsCache = store.getters.getShortsCache
  const entries = []

  activeSubscriptionList.value.forEach((channel) => {
    const cacheEntry = shortsCache[channel.id]

    if (cacheEntry != null) {
      entries.push(cacheEntry)
    }
  })

  return entries
})

const videoCacheForAllActiveProfileChannelsPresent = computed(() => {
  if (
    cacheEntriesForAllActiveProfileChannels.value.length === 0 ||
    cacheEntriesForAllActiveProfileChannels.value.length < activeSubscriptionList.value.length
  ) {
    return false
  }

  return cacheEntriesForAllActiveProfileChannels.value.every((cacheEntry) => {
    return cacheEntry.videos != null
  })
})

const lastShortRefreshTimestamp = computed(() => {
  // Cache is not ready when data is just loaded from remote
  if (lastRemoteRefreshSuccessTimestamp.value) {
    return getRelativeTimeFromDate(lastRemoteRefreshSuccessTimestamp.value, true)
  }

  if (
    !videoCacheForAllActiveProfileChannelsPresent.value ||
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

watch(activeSubscriptionList, () => {
  lastRemoteRefreshSuccessTimestamp.value = null
  isLoading.value = true
  loadVideosFromCacheSometimes()
}, { deep: true })

if (!subscriptionCacheReady.value) {
  watch(subscriptionCacheReady, () => {
    if (!alreadyLoadedRemotely) {
      loadVideosFromCacheSometimes()
    }
  })
}

onMounted(() => {
  loadVideosFromRemoteFirstPerWindowSometimes()
})

function loadVideosFromRemoteFirstPerWindowSometimes() {
  if (
    !fetchSubscriptionsAutomatically.value ||
    // Only auto fetch once per window
    store.getters.getSubscriptionForShortsFirstAutoFetchRun
  ) {
    loadVideosFromCacheSometimes()
    return
  }

  alreadyLoadedRemotely = true
  loadVideosForSubscriptionsFromRemote()
  store.commit('setSubscriptionForShortsFirstAutoFetchRun')
}

function loadVideosFromCacheSometimes() {
  // Can only load reliably when cache ready
  if (!subscriptionCacheReady.value) { return }

  // This method is called on view visible
  if (videoCacheForAllActiveProfileChannelsPresent.value) {
    loadVideosFromCacheForAllActiveProfileChannels()
    return
  }

  if (fetchSubscriptionsAutomatically.value) {
    // `isLoading.value = false` is called inside `loadVideosForSubscriptionsFromRemote` when needed
    loadVideosForSubscriptionsFromRemote()
    return
  }

  // Auto fetch disabled, not enough cache for profile = show nothing
  videoList.value = []
  attemptedFetch.value = false
  isLoading.value = false
}

function loadVideosFromCacheForAllActiveProfileChannels() {
  const videoList_ = cacheEntriesForAllActiveProfileChannels.value.flatMap((cacheEntry) => {
    return cacheEntry.videos
  })

  videoList.value = updateVideoListAfterProcessing(videoList_)
  isLoading.value = false
}

async function loadVideosForSubscriptionsFromRemote() {
  if (activeSubscriptionList.value.length === 0) {
    isLoading.value = false
    videoList.value = []
    return
  }

  const channelsToLoadFromRemote = activeSubscriptionList.value
  let channelCount = 0
  isLoading.value = true
  store.commit('setShowProgressBar', true)
  store.commit('setProgressBarPercentage', 0)
  attemptedFetch.value = true

  errorChannels.value = []
  unresolvedChannels.value = []
  const subscriptionUpdates = []

  beginSubscriptionTrace('shorts', {
    channelCount: channelsToLoadFromRemote.length,
    // shorts have no scraper path, the shorts tab carries no publish dates
    useRss: true,
    backend: backendPreference.value
  })
  beginFetchErrorCollection('shorts', channelsToLoadFromRemote.length)

  const processChannel = async (channel) => {
    let videos, name, status

    const traceDone = traceChannelFetch('shorts', channel.id)

    try {
      if (!process.env.SUPPORTS_LOCAL_API || backendPreference.value === 'invidious') {
        ({ status, videos, name } = await getChannelShortsInvidious(channel))
      } else {
        ({ status, videos, name } = await getChannelShortsLocal(channel))
      }
    } finally {
      traceDone({
        entries: videos?.length ?? null,
        outcome: status ?? 'threw'
      })
    }

    if (isRetryableFetchStatus(status)) {
      unresolvedChannels.value.push(channel)
    }

    channelCount++
    const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
    store.commit('setProgressBarPercentage', percentageComplete)

    if (videos != null) {
      store.dispatch('updateSubscriptionShortsCacheByChannel', {
        channelId: channel.id,
        videos: videos
      })
    }

    if (name) {
      subscriptionUpdates.push({
        channelId: channel.id,
        channelName: name
      })
    }

    return videos ?? []
  }

  const results = await processInChunks(channelsToLoadFromRemote, processChannel, {
    // shorts are RSS only
    chunkSize: SUBSCRIPTION_RSS_CHUNK_SIZE,
    delayMs: SUBSCRIPTION_CHUNK_DELAY_MS
  })

  const videoListFromRemote = results.flat()

  endSubscriptionTrace('shorts')
  endFetchErrorCollection('shorts')

  videoList.value = updateVideoListAfterProcessing(videoListFromRemote)
  isLoading.value = false
  store.commit('setShowProgressBar', false)
  lastRemoteRefreshSuccessTimestamp.value = Date.now()

  store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates)
}

async function getChannelShortsLocal(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'shorts', 'newest')
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

  try {
    const response = await fetch(feedUrl)

    if (response.status === 403 || response.status === 429) {
      reportRateLimited('shorts')

      return {
        status: FETCH_RATE_LIMITED,
        videos: null
      }
    }

    if (response.status === 404) {
      // playlists don't exist if the channel was terminated but also if it doesn't have the tab,
      // so we need to check the channel feed too before deciding it errored, as that only 404s if the channel was terminated

      const response2 = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, {
        method: 'HEAD'
      })

      if (response2.status === 404) {
        errorChannels.value.push(channel)

        return {
          status: FETCH_UNAVAILABLE,
          videos: []
        }
      }

      // the channel is alive, it just has no shorts tab
      return {
        status: FETCH_OK,
        videos: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      return {
        status: FETCH_FAILED,
        videos: null
      }
    }

    return {
      status: FETCH_OK,
      ...parsed
    }
  } catch (error) {
    reportFetchError('shorts', { channel, error, api: 'local' })

    switch (failedAttempts) {
      case 0:
        if (backendFallback.value) {
          return await getChannelShortsInvidious(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            videos: null
          }
        }
      default:
        return {
          status: FETCH_FAILED,
          videos: null
        }
    }
  }
}

async function getChannelShortsInvidious(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'shorts', 'newest')
  const feedUrl = `${currentInvidiousInstanceUrl.value}/feed/playlist/${playlistId}`

  try {
    const response = await invidiousFetch(feedUrl)

    if (response.status === 403 || response.status === 429) {
      reportRateLimited('shorts')

      return {
        status: FETCH_RATE_LIMITED,
        videos: null
      }
    }

    if (response.status === 404) {
      // playlists don't exist if the channel was terminated but also if it doesn't have the tab,
      // so we need to check the channel feed too before deciding it errored, as that only 404s if the channel was terminated

      const response2 = await fetch(`${currentInvidiousInstanceUrl.value}/feed/channel/${channel.id}`, {
        method: 'GET'
      })

      if (response2.status === 404) {
        errorChannels.value.push(channel)

        return {
          status: FETCH_UNAVAILABLE,
          videos: []
        }
      }

      return {
        status: FETCH_OK,
        videos: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      return {
        status: FETCH_FAILED,
        videos: null
      }
    }

    return {
      status: FETCH_OK,
      ...parsed
    }
  } catch (error) {
    reportFetchError('shorts', { channel, error, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback.value) {
          return await getChannelShortsLocal(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            videos: null
          }
        }
      default:
        return {
          status: FETCH_FAILED,
          videos: null
        }
    }
  }
}
</script>
