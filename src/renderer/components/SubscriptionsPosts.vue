<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :video-list="entryList"
    :error-channels="errorChannels"
    :attempted-fetch="attemptedFetch"
    :is-community="true"
    :initial-data-limit="20"
    :last-refresh-timestamp="lastRefreshTimestamp"
    :title="t('Global.Posts')"
    @refresh="refresh"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../store/index'

import { useSubscriptionFeed } from '../composables/useSubscriptionFeed'

import { getLocalChannelCommunity } from '../helpers/api/local'
import { invidiousGetCommunityPosts } from '../helpers/api/invidious'
import {
  reportFetchError,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_UNAVAILABLE
} from '../helpers/subscriptionFetchStatus'

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => store.getters.getBackendFallback)

/** @type {import('vue').ComputedRef<string[]>} */
const forbiddenTitles = computed(() => {
  return JSON.parse(store.getters.getForbiddenTitles.toLowerCase())
})

const {
  isLoading,
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  refresh
} = useSubscriptionFeed({
  feed: 'posts',
  cacheGetter: 'getPostsCache',
  updateAction: 'updateSubscriptionPostsCacheByChannel',
  entriesKey: 'posts',
  autoFetchGetter: 'getSubscriptionForPostsFirstAutoFetchRun',
  autoFetchMutation: 'setSubscriptionForPostsFirstAutoFetchRun',
  // Community posts are not published as RSS at all
  rssMode: 'never',
  fetchChannel: async (channel) => {
    const result = (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious')
      ? await getChannelPostsInvidious(channel)
      : await getChannelPostsLocal(channel)

    return {
      ...result,
      ...channelDetailsFromPosts(channel, result.entries)
    }
  },
  // The cache deliberately keeps posts the filter would hide, so that turning
  // the setting off shows them again without a refetch.
  postProcess: (posts) => {
    return posts
      .filter(post => !forbiddenTitles.value.some(text => post.author.toLowerCase().includes(text)))
      .sort((a, b) => b.publishedTime - a.publishedTime)
  }
})

/**
 * Posts carry their author's name and avatar, so unlike the other feeds there
 * is nothing separate to read them from.
 * @param {{ id: string }} channel
 * @param {any[] | null} posts
 */
function channelDetailsFromPosts(channel, posts) {
  if (posts == null || posts.length === 0) { return {} }

  const post = posts.find(post => post.authorId === channel.id)

  if (post == null) { return {} }

  let thumbnailUrl = post.authorThumbnails?.[0]?.url

  if (thumbnailUrl?.startsWith('//')) {
    thumbnailUrl = 'https:' + thumbnailUrl
  }

  return {
    name: post.author,
    thumbnailUrl
  }
}

async function getChannelPostsLocal(channel) {
  try {
    const entries = await getLocalChannelCommunity(channel.id)

    if (entries === null) {
      // ChannelError, so the channel is gone rather than the request having failed
      errorChannels.value.push(channel)

      return {
        status: FETCH_UNAVAILABLE,
        entries: []
      }
    }

    return {
      status: FETCH_OK,
      entries
    }
  } catch (err) {
    reportFetchError('posts', { channel, error: err, api: 'local' })

    if (store.getters.getBackendPreference === 'local' && backendFallback.value) {
      return await getChannelPostsInvidious(channel)
    }

    return {
      status: FETCH_FAILED,
      entries: null
    }
  }
}

async function getChannelPostsInvidious(channel) {
  try {
    const result = await invidiousGetCommunityPosts(channel.id)

    return {
      status: FETCH_OK,
      entries: result.posts
    }
  } catch (err) {
    reportFetchError('posts', { channel, error: err, api: 'invidious' })

    if (process.env.SUPPORTS_LOCAL_API && store.getters.getBackendPreference === 'invidious' && backendFallback.value) {
      return await getChannelPostsLocal(channel)
    } else {
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }
  }
}
</script>
