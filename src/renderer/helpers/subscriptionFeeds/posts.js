import store from '../../store/index'

import { invidiousGetCommunityPosts } from '../api/invidious'
import { getLocalChannelCommunity } from '../api/local'
import {
  reportFetchError,
  resolveGoneVerdict,
  FETCH_FAILED,
  FETCH_OK
} from '../subscriptionFetchStatus'

/** How the community posts feed is fetched. See `videos.js` for why this is here. */

const FEED = 'posts'

function backendFallback() {
  return store.getters.getBackendFallback
}

function forbiddenTitles() {
  return JSON.parse(store.getters.getForbiddenTitles.toLowerCase())
}

export const postsFeed = {
  feed: FEED,
  cacheGetter: 'getPostsCache',
  updateAction: 'updateSubscriptionPostsCacheByChannel',
  entriesKey: 'posts',
  // Community posts are not published as RSS at all, so the scraper is the only
  // way to fetch them and the RSS setting has nothing to say about this feed.
  // That is what "RSS where possible" means: videos, shorts and live streams
  // take the lighter path when it is asked for, and posts are fetched as they
  // always were.
  //
  // Posts were held out of an RSS refresh entirely once, on the reasoning that
  // the setting asks for fewer requests. What that produced was a kind that
  // vanished when an unrelated-looking setting was turned on, and then a
  // paragraph explaining two settings where a list of posts should have been.
  rssMode: 'never',
  followsDetailBackfill: false,
  shownGetter: 'getShowSubscriptionsPosts',
  shownAction: 'updateShowSubscriptionsPosts',
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
    const forbidden = forbiddenTitles()

    return posts
      .filter(post => !forbidden.some(text => post.author.toLowerCase().includes(text)))
      .sort((a, b) => b.publishedTime - a.publishedTime)
  }
}

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
      // ChannelError, so the channel is gone rather than the request having
      // failed. Explicit, so it needs no corroboration, but still counted
      // against the run's anomaly limit. See `videos.js`.
      return await resolveGoneVerdict(FEED, channel, {
        source: 'local-scraper',
        authoritative: true
      })
    }

    return {
      status: FETCH_OK,
      entries
    }
  } catch (err) {
    reportFetchError(FEED, { channel, error: err, api: 'local' })

    if (store.getters.getBackendPreference === 'local' && backendFallback()) {
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
    reportFetchError(FEED, { channel, error: err, api: 'invidious' })

    if (process.env.SUPPORTS_LOCAL_API && store.getters.getBackendPreference === 'invidious' && backendFallback()) {
      return await getChannelPostsLocal(channel)
    } else {
      return {
        status: FETCH_FAILED,
        entries: null
      }
    }
  }
}
