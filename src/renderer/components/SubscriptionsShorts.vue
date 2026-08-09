<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :video-list="entryList"
    :error-channels="errorChannels"
    :last-refresh-timestamp="lastRefreshTimestamp"
    :attempted-fetch="attemptedFetch"
    :title="t('Global.Shorts')"
    @refresh="refresh"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../store/index'

import { useSubscriptionFeed } from '../composables/useSubscriptionFeed'

import { getChannelPlaylistId } from '../helpers/utils'
import { invidiousFetch } from '../helpers/api/invidious'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../helpers/subscriptions'
import {
  reportFetchError,
  reportRateLimited,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE
} from '../helpers/subscriptionFetchStatus'

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => store.getters.getBackendFallback)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

const {
  isLoading,
  entryList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  refresh
} = useSubscriptionFeed({
  feed: 'shorts',
  cacheGetter: 'getShortsCache',
  updateAction: 'updateSubscriptionShortsCacheByChannel',
  entriesKey: 'videos',
  autoFetchGetter: 'getSubscriptionForShortsFirstAutoFetchRun',
  autoFetchMutation: 'setSubscriptionForShortsFirstAutoFetchRun',
  // There is no scraper path for shorts: the channel shorts tab carries no
  // publish dates, so a feed cannot be built from it.
  rssMode: 'always',
  fetchChannel: (channel) => {
    if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
      return getChannelShortsInvidious(channel)
    }

    return getChannelShortsLocal(channel)
  },
  postProcess: updateVideoListAfterProcessing
})

async function getChannelShortsLocal(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'shorts', 'newest')
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

  try {
    const response = await fetch(feedUrl)

    if (response.status === 403 || response.status === 429) {
      reportRateLimited('shorts')

      return {
        status: FETCH_RATE_LIMITED,
        entries: null
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
          entries: []
        }
      }

      // the channel is alive, it just has no shorts tab
      return {
        status: FETCH_OK,
        entries: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }

    return {
      status: FETCH_OK,
      entries: parsed.videos,
      name: parsed.name
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
            entries: null
          }
        }
      default:
        return {
          status: FETCH_FAILED,
          entries: null
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
        entries: null
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
          entries: []
        }
      }

      return {
        status: FETCH_OK,
        entries: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }

    return {
      status: FETCH_OK,
      entries: parsed.videos,
      name: parsed.name
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
            entries: null
          }
        }
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}
</script>
