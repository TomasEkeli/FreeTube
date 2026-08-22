import store from '../../store/index'

import { invidiousFetch } from '../api/invidious'
import { parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../subscriptions'
import { getChannelPlaylistId } from '../utils'
import { probeChannelLiveness } from '../subscriptionChannelLiveness'
import { traceFetchStatus } from '../subscriptionTrace'
import {
  reportFetchError,
  resolveGoneVerdict,
  FETCH_FAILED,
  FETCH_OK,
  FETCH_RATE_LIMITED
} from '../subscriptionFetchStatus'

/** How the shorts feed is fetched. See `videos.js` for why this is here. */

const FEED = 'shorts'

function backendFallback() {
  return store.getters.getBackendFallback
}

function invidiousInstanceUrl() {
  return store.getters.getCurrentInvidiousInstanceUrl
}

export const shortsFeed = {
  feed: FEED,
  cacheGetter: 'getShortsCache',
  updateAction: 'updateSubscriptionShortsCacheByChannel',
  entriesKey: 'videos',
  // There is no scraper path for shorts: the channel shorts tab carries no
  // publish dates, so a feed cannot be built from it.
  rssMode: 'always',
  // Shorts have no duration from any source, so there is nothing to fill in
  followsDetailBackfill: false,
  isEnabled: () => !store.getters.getHideSubscriptionsShorts,
  fetchChannel: (channel, { failedAttempts = 0 }) => {
    if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
      return getChannelShortsInvidious(channel, failedAttempts)
    }

    return getChannelShortsLocal(channel, failedAttempts)
  },
  postProcess: updateVideoListAfterProcessing
}

async function getChannelShortsLocal(channel, failedAttempts = 0) {
  const playlistId = getChannelPlaylistId(channel.id, 'shorts', 'newest')
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

  try {
    const response = await fetch(feedUrl)

    traceFetchStatus(FEED, channel.id, { rung: 'local-rss', status: response.status, attempt: failedAttempts })

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

      traceFetchStatus(FEED, channel.id, {
        rung: 'local-rss-channel-probe',
        status: response2.status,
        attempt: failedAttempts
      })

      if (response2.status === 404) {
        // This feed has no path off RSS at all, so it is the one that suffers
        // most when the RSS service misbehaves: on 2026-08-22 it condemned
        // every channel in the profile. One service asked twice is one opinion.
        return await resolveGoneVerdict(FEED, channel, {
          source: 'local-rss',
          corroborate: () => probeChannelLiveness(channel)
        })
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
    reportFetchError(FEED, { channel, error, api: 'local' })

    switch (failedAttempts) {
      case 0:
        if (backendFallback()) {
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
  const feedUrl = `${invidiousInstanceUrl()}/feed/playlist/${playlistId}`

  try {
    const response = await invidiousFetch(feedUrl)

    traceFetchStatus(FEED, channel.id, { rung: 'invidious-rss', status: response.status, attempt: failedAttempts })

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

      traceFetchStatus(FEED, channel.id, {
        rung: 'invidious-rss-channel-probe',
        status: response2.status,
        attempt: failedAttempts
      })

      if (response2.status === 404) {
        // One instance, asked twice, is still one opinion. See `videos.js`.
        return await resolveGoneVerdict(FEED, channel, {
          source: 'invidious-rss',
          corroborate: () => probeChannelLiveness(channel)
        })
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
        if (process.env.SUPPORTS_LOCAL_API && backendFallback()) {
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
