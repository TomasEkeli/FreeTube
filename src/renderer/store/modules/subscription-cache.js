import {
  DBSubscriptionCacheHandlers,
} from '../../../datastores/handlers/index'

import {
  carryOverKnownVideoDetails,
  mergeChannelPageVideoDetails
} from '../../../subscriptionVideoDetails'
import { channelTagsChanged } from '../../helpers/profileSuggestions'

const state = {
  videoCache: {},
  liveCache: {},
  shortsCache: {},
  postsCache: {},

  /**
   * What each subscribed channel's page said about it, by channel id: see
   * `ChannelTags` in helpers/profileSuggestions. Picked up from channel pages
   * fetched for other reasons, so it fills in as the app is used.
   */
  channelTagsCache: {},

  subscriptionCacheReady: false,
}

const getters = {
  getSubscriptionCacheReady: (state) => state.subscriptionCacheReady,

  getVideoCache: (state) => state.videoCache,

  getShortsCache: (state) => state.shortsCache,

  getLiveCache: (state) => state.liveCache,

  getPostsCache: (state) => state.postsCache,

  getChannelTagsCache: (state) => state.channelTagsCache,
}

const actions = {
  async grabAllSubscriptions({ commit, dispatch, rootGetters, state }) {
    try {
      const payload = await DBSubscriptionCacheHandlers.find()

      const videos = {}
      const liveStreams = {}
      const shorts = {}
      const communityPosts = {}
      const channelTags = {}

      const toBeRemovedChannelIds = []
      const subscribedChannelIdSet = rootGetters.getSubscribedChannelIdSet

      for (const dataEntry of payload) {
        const channelId = dataEntry._id
        if (!subscribedChannelIdSet.has(channelId)) {
          // Clean up cache data for unsubscribed channels
          toBeRemovedChannelIds.push(channelId)
          // No need to load data for unsubscribed channels
          continue
        }

        let hasData = false

        if (Array.isArray(dataEntry.videos)) {
          videos[channelId] = { videos: dataEntry.videos, timestamp: dataEntry.videosTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.liveStreams)) {
          liveStreams[channelId] = { videos: dataEntry.liveStreams, timestamp: dataEntry.liveStreamsTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.shorts)) {
          shorts[channelId] = { videos: dataEntry.shorts, timestamp: dataEntry.shortsTimestamp }
          hasData = true
        }
        if (Array.isArray(dataEntry.communityPosts)) {
          communityPosts[channelId] = { posts: dataEntry.communityPosts, timestamp: dataEntry.communityPostsTimestamp }
          hasData = true
        }
        if (dataEntry.channelTags != null && Array.isArray(dataEntry.channelTags.tags)) {
          channelTags[channelId] = dataEntry.channelTags
          hasData = true
        }

        if (!hasData) { toBeRemovedChannelIds.push(channelId) }
      }

      // A channel page seen while this was loading may have made a record for
      // its tags since, which is data after all
      const emptyChannelIds = toBeRemovedChannelIds.filter(channelId => {
        return subscribedChannelIdSet.has(channelId) ? state.channelTagsCache[channelId] == null : true
      })

      if (emptyChannelIds.length > 0) {
        // Delete channels with no data
        dispatch('clearSubscriptionsCacheForManyChannels', emptyChannelIds)
      }
      commit('setCaches', { videos, liveStreams, shorts, communityPosts, channelTags })
      commit('setSubscriptionCacheReady', true)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionVideosCacheByChannel({ commit, state }, { channelId, videos, timestamp = new Date() }) {
    try {
      // A refresh replaces a channel's videos outright, and RSS entries have no
      // duration, so without this every refresh discards what the back-fill
      // went and fetched and the whole feed has to be fetched again. Done here
      // rather than in the datastore so that the write stays a single write.
      const entries = carryOverKnownVideoDetails(state.videoCache[channelId]?.videos, videos)

      await DBSubscriptionCacheHandlers.updateVideosByChannelId(channelId, entries, timestamp)
      commit('updateVideoCacheByChannel', { channelId, entries, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Fill in details the RSS feeds do not carry, most importantly the duration,
   * from a channel's own videos page. Does not change the cache timestamp: the
   * feed is no fresher than it was, it is merely more complete.
   */
  async updateSubscriptionVideosCacheWithChannelPageVideos({ commit }, { channelId, videos }) {
    try {
      await DBSubscriptionCacheHandlers.updateVideosWithChannelPageVideosByChannelId(channelId, videos)
      commit('updateVideoCacheWithChannelPageVideos', { channelId, entries: videos })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionShortsCacheByChannel({ commit }, { channelId, videos, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateShortsByChannelId(channelId, videos, timestamp)
      commit('updateShortsCacheByChannel', { channelId, entries: videos, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionShortsCacheWithChannelPageShorts({ commit }, { channelId, videos }) {
    try {
      await DBSubscriptionCacheHandlers.updateShortsWithChannelPageShortsByChannelId(channelId, videos)
      commit('updateShortsCacheWithChannelPageShorts', { channelId, entries: videos })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionLiveCacheByChannel({ commit, state }, { channelId, videos, timestamp = new Date() }) {
    try {
      // Same reason as videos: a refresh replaces the channel's streams outright
      // and RSS carries neither a duration nor the live flag, so without this
      // every refresh throws away what was filled in and it is all fetched again
      const entries = carryOverKnownVideoDetails(state.liveCache[channelId]?.videos, videos)

      await DBSubscriptionCacheHandlers.updateLiveStreamsByChannelId(channelId, entries, timestamp)
      commit('updateLiveCacheByChannel', { channelId, entries, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Fill in what the live RSS feeds do not carry: the duration of a stream that
   * has ended, and the live and upcoming flags. Missing those flags matters more
   * here than a missing duration does on the videos tab, since a stream that is
   * live right now otherwise looks like an ordinary video.
   */
  async updateSubscriptionLiveCacheWithChannelPageVideos({ commit }, { channelId, videos }) {
    try {
      await DBSubscriptionCacheHandlers.updateLiveStreamsWithChannelPageVideosByChannelId(channelId, videos)
      commit('updateLiveCacheWithChannelPageVideos', { channelId, entries: videos })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async updateSubscriptionPostsCacheByChannel({ commit }, { channelId, posts, timestamp = new Date() }) {
    try {
      await DBSubscriptionCacheHandlers.updateCommunityPostsByChannelId(channelId, posts, timestamp)
      commit('updatePostsCacheByChannel', { channelId, entries: posts, timestamp })
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  /**
   * Keeps a channel's tags, as seen on a channel page the app fetched anyway.
   * Only for subscribed channels, and only when they differ from what is kept
   * already: a refresh passes through every channel page, and writing each
   * one's unchanged tags back would be a write per channel per refresh.
   * @param {any} context
   * @param {{ channelId: string, tags: string[], musicArtist: boolean | null }} payload
   * `musicArtist` null when the page could not say, which keeps what is known
   */
  async updateChannelTags({ commit, state, rootGetters }, { channelId, tags, musicArtist }) {
    if (!rootGetters.getSubscribedChannelIdSet.has(channelId)) { return }

    const stored = state.channelTagsCache[channelId]
    const next = { tags, musicArtist: musicArtist ?? Boolean(stored?.musicArtist) }

    if (!channelTagsChanged(stored, next)) { return }

    const channelTags = { ...next, seenAt: Date.now() }

    try {
      // Shown at once, so that a second page fetched meanwhile compares with
      // this and does not write the same again
      commit('updateChannelTagsByChannel', { channelId, channelTags })
      await DBSubscriptionCacheHandlers.updateChannelTagsByChannelId(channelId, channelTags)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async clearSubscriptionsCacheForManyChannels({ commit }, channelIds) {
    try {
      await DBSubscriptionCacheHandlers.deleteMultipleChannels(channelIds)
      commit('clearCachesForManyChannels', channelIds)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },

  async clearSubscriptionsCache({ commit }) {
    try {
      await DBSubscriptionCacheHandlers.deleteAll()
      commit('clearCaches')
    } catch (errMessage) {
      console.error(errMessage)
    }
  },
}

const mutations = {
  updateVideoCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.videoCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.videoCache[channelId] = newObject
  },
  updateShortsCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.shortsCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.shortsCache[channelId] = newObject
  },
  updateVideoCacheWithChannelPageVideos(state, { channelId, entries }) {
    const cachedObject = state.videoCache[channelId]

    if (cachedObject != null && Array.isArray(cachedObject.videos)) {
      mergeChannelPageVideoDetails(cachedObject.videos, entries)
    }
  },
  updateLiveCacheWithChannelPageVideos(state, { channelId, entries }) {
    const cachedObject = state.liveCache[channelId]

    if (cachedObject != null && Array.isArray(cachedObject.videos)) {
      mergeChannelPageVideoDetails(cachedObject.videos, entries)
    }
  },
  updateShortsCacheWithChannelPageShorts(state, { channelId, entries }) {
    const cachedObject = state.shortsCache[channelId]

    if (cachedObject && cachedObject.videos.length > 0) {
      cachedObject.videos.forEach(cachedVideo => {
        const channelVideo = entries.find(short => cachedVideo.videoId === short.videoId)

        if (channelVideo) {
          // authorId probably never changes, so we don't need to update that

          cachedVideo.title = channelVideo.title
          cachedVideo.author = channelVideo.author

          // as the channel shorts page only has compact view counts for numbers above 1000 e.g. 12k
          // and the RSS feeds include an exact value, we only want to overwrite it when the number is larger than the cached value
          // 12345 vs 12000 => 12345
          // 12345 vs 15000 => 15000

          if (channelVideo.viewCount > cachedVideo.viewCount) {
            cachedVideo.viewCount = channelVideo.viewCount
          }
        }
      })
    }
  },
  updateLiveCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.liveCache[channelId]
    const newObject = existingObject ?? { videos: null }
    if (entries != null) { newObject.videos = entries }
    newObject.timestamp = timestamp
    state.liveCache[channelId] = newObject
  },
  updatePostsCacheByChannel(state, { channelId, entries, timestamp = new Date() }) {
    const existingObject = state.postsCache[channelId]
    const newObject = existingObject ?? { posts: null }
    if (entries != null) { newObject.posts = entries }
    newObject.timestamp = timestamp
    state.postsCache[channelId] = newObject
  },

  updateChannelTagsByChannel(state, { channelId, channelTags }) {
    state.channelTagsCache[channelId] = channelTags
  },

  clearCaches(state) {
    state.videoCache = {}
    state.shortsCache = {}
    state.liveCache = {}
    state.postsCache = {}
    state.channelTagsCache = {}
  },

  clearCachesForManyChannels(state, channelIds) {
    channelIds.forEach((channelId) => {
      state.videoCache[channelId] = null
      state.liveCache[channelId] = null
      state.shortsCache[channelId] = null
      state.postsCache[channelId] = null
      delete state.channelTagsCache[channelId]
    })
  },

  setCaches(state, { videos, liveStreams, shorts, communityPosts, channelTags }) {
    state.videoCache = videos
    state.liveCache = liveStreams
    state.shortsCache = shorts
    state.postsCache = communityPosts
    // Any seen while the cache was loading are newer than what was on disk
    state.channelTagsCache = { ...channelTags, ...state.channelTagsCache }
  },

  setSubscriptionCacheReady(state, payload) {
    state.subscriptionCacheReady = payload
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
