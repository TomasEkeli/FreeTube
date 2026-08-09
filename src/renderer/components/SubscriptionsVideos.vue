<template>
  <SubscriptionsTabUi
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :video-list="entryList"
    :error-channels="errorChannels"
    :last-refresh-timestamp="lastRefreshTimestamp"
    :attempted-fetch="attemptedFetch"
    :backfill-feed="'videos'"
    :title="t('Global.Videos')"
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
import { getInvidiousChannelVideos, invidiousFetch } from '../helpers/api/invidious'
import { getLocalChannelVideos } from '../helpers/api/local'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../helpers/subscriptions'
import {
  reportFetchError,
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
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  refresh
} = useSubscriptionFeed({
  feed: 'videos',
  cacheGetter: 'getVideoCache',
  updateAction: 'updateSubscriptionVideosCacheByChannel',
  entriesKey: 'videos',
  autoFetchGetter: 'getSubscriptionForVideosFirstAutoFetchRun',
  autoFetchMutation: 'setSubscriptionForVideosFirstAutoFetchRun',
  rssMode: 'setting',
  fetchChannel: (channel, { useRss, failedAttempts = 0 }) => {
    if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
      return useRss
        ? getChannelVideosInvidiousRSS(channel, failedAttempts)
        : getChannelVideosInvidiousScraper(channel, failedAttempts)
    }

    return useRss
      ? getChannelVideosLocalRSS(channel, failedAttempts)
      : getChannelVideosLocalScraper(channel, failedAttempts)
  },
  postProcess: updateVideoListAfterProcessing,
  followsDetailBackfill: true
})

async function getChannelVideosLocalScraper(channel, failedAttempts = 0) {
  try {
    const result = await getLocalChannelVideos(channel.id)

    if (result === null) {
      // ChannelError, so the channel is gone rather than the request having failed
      errorChannels.value.push(channel)
      return {
        status: FETCH_UNAVAILABLE,
        entries: []
      }
    }

    return {
      status: FETCH_OK,
      entries: result.videos,
      name: result.name,
      thumbnailUrl: result.thumbnailUrl
    }
  } catch (err) {
    reportFetchError('videos', { channel, error: err, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
      case 1:
        if (backendFallback.value) {
          return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosLocalRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'videos', 'newest')
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

  try {
    const response = await fetch(feedUrl)

    if (response.status === 403 || response.status === 429) {
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

      // the channel is alive, it just has no videos tab
      return {
        status: FETCH_OK,
        entries: []
      }
    }

    const parsed = await parseYouTubeRSSFeed(await response.text(), channel.id)

    if (parsed.parseFailed) {
      // A 200 carrying something that is not a feed, which is one of the ways
      // YouTube says no. Deliberately not escalating the ladder here: firing
      // more requests at a host that just refused one is the wrong instinct,
      // and the channel stays retryable for later.
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
    reportFetchError('videos', { channel, error, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
      case 1:
        if (backendFallback.value) {
          return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosInvidiousScraper(channel, failedAttempts = 0) {
  try {
    const result = await getInvidiousChannelVideos(channel.id)

    let name

    if (result.videos.length > 0) {
      name = result.videos.find(video => video.type === 'video' && video.author).author
    }

    return {
      status: FETCH_OK,
      entries: result.videos,
      name
    }
  } catch (err) {
    reportFetchError('videos', { channel, error: err, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback.value) {
          return await getChannelVideosLocalScraper(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosInvidiousRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelVideosInvidiousRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'videos', 'newest')
  const feedUrl = `${currentInvidiousInstanceUrl.value}/feed/playlist/${playlistId}`

  try {
    const response = await invidiousFetch(feedUrl)

    if (response.status === 403 || response.status === 429) {
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
    reportFetchError('videos', { channel, error, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback.value) {
          return await getChannelVideosLocalRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}
</script>
