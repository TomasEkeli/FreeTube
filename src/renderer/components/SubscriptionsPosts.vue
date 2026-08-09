<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :video-list="postList"
    :error-channels="errorChannels"
    :attempted-fetch="attemptedFetch"
    :is-community="true"
    :initial-data-limit="20"
    :last-refresh-timestamp="lastPostsRefreshTimestamp"
    :title="t('Global.Posts')"
    @refresh="loadPostsForSubscriptionsFromRemote"
  />
</template>

<script setup>
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../store/index'

import { getRelativeTimeFromDate } from '../helpers/utils'
import { getLocalChannelCommunity } from '../helpers/api/local'
import { invidiousGetCommunityPosts } from '../helpers/api/invidious'
import {
  processInChunks,
  SUBSCRIPTION_CHUNK_DELAY_MS,
  SUBSCRIPTION_SCRAPER_CHUNK_SIZE
} from '../helpers/subscriptions'
import { beginSubscriptionTrace, endSubscriptionTrace, traceChannelFetch } from '../helpers/subscriptionTrace'
import {
  beginFetchErrorCollection,
  endFetchErrorCollection,
  isRetryableFetchStatus,
  reportFetchError,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_UNAVAILABLE
} from '../helpers/subscriptionFetchStatus'

const { t } = useI18n()

const isLoading = ref(true)
const postList = shallowRef([])
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

/** @type {import('vue').ComputedRef<boolean>} */
const subscriptionCacheReady = computed(() => store.getters.getSubscriptionCacheReady)

/** @type {import('vue').ComputedRef<boolean>} */
const fetchSubscriptionsAutomatically = computed(() => store.getters.getFetchSubscriptionsAutomatically)

const activeSubscriptionList = computed(() => store.getters.getActiveProfile.subscriptions)

const cacheEntriesForAllActiveProfileChannels = computed(() => {
  const postsCache = store.getters.getPostsCache
  const entries = []

  activeSubscriptionList.value.forEach((channel) => {
    const cacheEntry = postsCache[channel.id]

    if (cacheEntry != null) {
      entries.push(cacheEntry)
    }
  })

  return entries
})

const postCacheForAllActiveProfileChannelsPresent = computed(() => {
  if (
    cacheEntriesForAllActiveProfileChannels.value.length === 0 ||
    cacheEntriesForAllActiveProfileChannels.value.length < activeSubscriptionList.value.length
  ) {
    return false
  }

  return cacheEntriesForAllActiveProfileChannels.value.every((cacheEntry) => {
    return cacheEntry.posts != null
  })
})

const lastPostsRefreshTimestamp = computed(() => {
  // Cache is not ready when data is just loaded from remote
  if (lastRemoteRefreshSuccessTimestamp.value) {
    return getRelativeTimeFromDate(lastRemoteRefreshSuccessTimestamp.value, true)
  }

  if (
    !postCacheForAllActiveProfileChannelsPresent.value ||
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
  loadPostsFromCacheSometimes()
}, { deep: true })

if (!subscriptionCacheReady.value) {
  watch(subscriptionCacheReady, () => {
    if (!alreadyLoadedRemotely) {
      loadPostsFromCacheSometimes()
    }
  })
}

onMounted(() => {
  loadPostsFromRemoteFirstPerWindowSometimes()
})

function loadPostsFromRemoteFirstPerWindowSometimes() {
  if (
    !fetchSubscriptionsAutomatically.value ||
    // Only auto fetch once per window
    store.getters.getSubscriptionForPostsFirstAutoFetchRun
  ) {
    loadPostsFromCacheSometimes()
    return
  }

  alreadyLoadedRemotely = true
  loadPostsForSubscriptionsFromRemote()
  store.commit('setSubscriptionForPostsFirstAutoFetchRun')
}

function loadPostsFromCacheSometimes() {
  // Can only load reliably when cache ready
  if (!subscriptionCacheReady.value) { return }

  // This method is called on view visible
  if (postCacheForAllActiveProfileChannelsPresent.value) {
    loadPostsFromCacheForAllActiveProfileChannels()
    return
  }

  if (fetchSubscriptionsAutomatically.value) {
    // `isLoading.value = false` is called inside `loadPostsForSubscriptionsFromRemote` when needed
    loadPostsForSubscriptionsFromRemote()
    return
  }

  // Auto fetch disabled, not enough cache for profile = show nothing
  postList.value = []
  attemptedFetch.value = false
  isLoading.value = false
}

/** @type {import('vue').ComputedRef<string[]>} */
const forbiddenTitles = computed(() => {
  return JSON.parse(store.getters.getForbiddenTitles.toLowerCase())
})

function loadPostsFromCacheForAllActiveProfileChannels() {
  const postList_ = cacheEntriesForAllActiveProfileChannels.value.flatMap((cacheEntry) => {
    return cacheEntry.posts
  })

  postList_.sort((a, b) => {
    return b.publishedTime - a.publishedTime
  })

  postList.value = postList_.filter(post => !forbiddenTitles.value.some(text => post.author.toLowerCase().includes(text)))
  isLoading.value = false
}

async function loadPostsForSubscriptionsFromRemote() {
  if (activeSubscriptionList.value.length === 0) {
    isLoading.value = false
    postList.value = []
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
  const postListFromRemote = []

  beginSubscriptionTrace('posts', {
    channelCount: channelsToLoadFromRemote.length,
    // posts have no RSS path at all
    useRss: false,
    backend: backendPreference.value
  })
  beginFetchErrorCollection('posts', channelsToLoadFromRemote.length)

  const processChannel = async (channel) => {
    let posts, status

    const traceDone = traceChannelFetch('posts', channel.id)

    try {
      if (!process.env.SUPPORTS_LOCAL_API || backendPreference.value === 'invidious') {
        ({ status, posts } = await getChannelPostsInvidious(channel))
      } else {
        ({ status, posts } = await getChannelPostsLocal(channel))
      }
    } finally {
      traceDone({ entries: posts?.length ?? null, outcome: status ?? 'threw' })
    }

    if (isRetryableFetchStatus(status)) {
      unresolvedChannels.value.push(channel)
    }

    channelCount++
    const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
    store.commit('setProgressBarPercentage', percentageComplete)

    // A failed fetch must not overwrite what we already had. This write used to
    // be unconditional, so one failed refresh emptied the cached posts for
    // every channel it could not reach.
    if (posts != null) {
      store.dispatch('updateSubscriptionPostsCacheByChannel', {
        channelId: channel.id,
        posts
      })
    }

    if (posts != null && posts.length > 0) {
      const post = posts.find(post => post.authorId === channel.id)

      if (post) {
        const name = post.author
        let thumbnailUrl = post.authorThumbnails?.[0]?.url

        if (name || thumbnailUrl) {
          if (thumbnailUrl?.startsWith('//')) {
            thumbnailUrl = 'https:' + thumbnailUrl
          }

          subscriptionUpdates.push({
            channelId: channel.id,
            channelName: name,
            channelThumbnailUrl: thumbnailUrl
          })
        }
      }
    }

    if (posts == null) { return [] }

    return posts.filter(post => !forbiddenTitles.value.some(text => post.author.toLowerCase().includes(text)))
  }

  const results = await processInChunks(channelsToLoadFromRemote, processChannel, {
    // posts have no RSS path, this is always the scraper
    chunkSize: SUBSCRIPTION_SCRAPER_CHUNK_SIZE,
    delayMs: SUBSCRIPTION_CHUNK_DELAY_MS
  })

  postListFromRemote.push(...results.flat())

  endSubscriptionTrace('posts')
  endFetchErrorCollection('posts')

  postListFromRemote.sort((a, b) => {
    return b.publishedTime - a.publishedTime
  })

  postList.value = postListFromRemote
  isLoading.value = false
  store.commit('setShowProgressBar', false)
  lastRemoteRefreshSuccessTimestamp.value = Date.now()

  store.dispatch('batchUpdateSubscriptionDetails', subscriptionUpdates)
}

async function getChannelPostsLocal(channel) {
  try {
    const entries = await getLocalChannelCommunity(channel.id)

    if (entries === null) {
      // ChannelError, so the channel is gone rather than the request having failed
      errorChannels.value.push(channel)
      return {
        status: FETCH_UNAVAILABLE,
        posts: []
      }
    }

    return {
      status: FETCH_OK,
      posts: entries
    }
  } catch (err) {
    reportFetchError('posts', { channel, error: err, api: 'local' })

    if (backendPreference.value === 'local' && backendFallback.value) {
      return await getChannelPostsInvidious(channel)
    }

    return {
      status: FETCH_FAILED,
      posts: null
    }
  }
}

async function getChannelPostsInvidious(channel) {
  try {
    const result = await invidiousGetCommunityPosts(channel.id)

    return {
      status: FETCH_OK,
      posts: result.posts
    }
  } catch (err) {
    reportFetchError('posts', { channel, error: err, api: 'invidious' })

    if (process.env.SUPPORTS_LOCAL_API && backendPreference.value === 'invidious' && backendFallback.value) {
      return await getChannelPostsLocal(channel)
    } else {
      return {
        status: FETCH_FAILED,
        posts: null
      }
    }
  }
}
</script>
