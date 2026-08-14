import store from '../../store/index'

import { getInvidiousChannelLive, invidiousFetch } from '../api/invidious'
import { getLocalChannelLiveStreams } from '../api/local'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../subscriptions'
import { getChannelPlaylistId } from '../utils'
import {
  reportChannelUnavailable,
  reportFetchError,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED,
  FETCH_UNAVAILABLE
} from '../subscriptionFetchStatus'

/** How the live streams feed is fetched. See `videos.js` for why this is here. */

const FEED = 'live'

function backendFallback() {
  return store.getters.getBackendFallback
}

function invidiousInstanceUrl() {
  return store.getters.getCurrentInvidiousInstanceUrl
}

export const liveFeed = {
  feed: FEED,
  cacheGetter: 'getLiveCache',
  updateAction: 'updateSubscriptionLiveCacheByChannel',
  entriesKey: 'videos',
  rssMode: 'setting',
  followsDetailBackfill: true,
  isEnabled: () => !store.getters.getHideLiveStreams && !store.getters.getHideSubscriptionsLive,
  fetchChannel: (channel, { useRss, failedAttempts = 0 }) => {
    if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
      return useRss
        ? getChannelLiveInvidiousRSS(channel, failedAttempts)
        : getChannelLiveInvidious(channel, failedAttempts)
    }

    return useRss
      ? getChannelLiveLocalRSS(channel, failedAttempts)
      : getChannelLiveLocal(channel, failedAttempts)
  },
  postProcess: updateVideoListAfterProcessing
}

async function getChannelLiveLocal(channel, failedAttempts = 0) {
  try {
    const result = await getLocalChannelLiveStreams(channel.id)

    if (result === null) {
      // ChannelError, so the channel is gone rather than the request having failed
      reportChannelUnavailable(FEED, channel)
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
    reportFetchError(FEED, { channel, error: err, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelLiveLocalRSS(channel, failedAttempts + 1)
      case 1:
        if (backendFallback()) {
          return await getChannelLiveInvidious(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelLiveLocalRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelLiveLocalRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'live', 'newest')
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
        reportChannelUnavailable(FEED, channel)

        return {
          status: FETCH_UNAVAILABLE,
          entries: []
        }
      }

      // the channel is alive, it just has no live tab
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
    reportFetchError(FEED, { channel, error, api: 'local' })

    switch (failedAttempts) {
      case 0:
        return await getChannelLiveLocal(channel, failedAttempts + 1)
      case 1:
        if (backendFallback()) {
          return await getChannelLiveInvidiousRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelLiveLocal(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelLiveInvidious(channel, failedAttempts = 0) {
  try {
    const result = await getInvidiousChannelLive(channel.id)

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
    reportFetchError(FEED, { channel, error: err, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelLiveInvidiousRSS(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback()) {
          return await getChannelLiveLocal(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelLiveInvidiousRSS(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}

async function getChannelLiveInvidiousRSS(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'live', 'newest')
  const feedUrl = `${invidiousInstanceUrl()}/feed/playlist/${playlistId}`

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

      const response2 = await fetch(`${invidiousInstanceUrl()}/feed/channel/${channel.id}`, {
        method: 'GET'
      })

      if (response2.status === 404) {
        reportChannelUnavailable(FEED, channel)

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
    reportFetchError(FEED, { channel, error, api: 'invidious' })

    switch (failedAttempts) {
      case 0:
        return await getChannelLiveInvidious(channel, failedAttempts + 1)
      case 1:
        if (process.env.SUPPORTS_LOCAL_API && backendFallback()) {
          return await getChannelLiveLocalRSS(channel, failedAttempts + 1)
        } else {
          return {
            status: FETCH_FAILED,
            entries: null
          }
        }
      case 2:
        return await getChannelLiveInvidious(channel, failedAttempts + 1)
      default:
        return {
          status: FETCH_FAILED,
          entries: null
        }
    }
  }
}
