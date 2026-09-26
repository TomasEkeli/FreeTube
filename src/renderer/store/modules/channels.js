import { DBChannelHandlers } from '../../../datastores/handlers/index'
import { channelTagsChanged } from '../../helpers/profileSuggestions'

/**
 * What the app has learned about channels as it went, kept in `channels.db`,
 * one record per channel id. Not a cache: clearing the subscription cache
 * leaves it alone, and so does unsubscribing, so a channel subscribed to
 * again is known at once. Only subscribed channels are added to it.
 */

const state = {
  /**
   * What each channel's page said about it, by channel id: see `ChannelTags`
   * in helpers/profileSuggestions. Picked up from channel pages fetched for
   * other reasons, so it fills in as the app is used.
   */
  channelTags: {},
}

const getters = {
  getChannelTags: (state) => state.channelTags,
}

const actions = {
  async grabChannels({ commit }) {
    try {
      const records = await DBChannelHandlers.find()
      const channelTags = {}

      for (const record of records) {
        if (record.channelTags != null && Array.isArray(record.channelTags.tags)) {
          channelTags[record._id] = record.channelTags
        }
      }

      commit('setChannelTags', channelTags)
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

    const stored = state.channelTags[channelId]
    const next = { tags, musicArtist: musicArtist ?? Boolean(stored?.musicArtist) }

    if (!channelTagsChanged(stored, next)) { return }

    const channelTags = { ...next, seenAt: Date.now() }

    try {
      // Shown at once, so that a second page fetched meanwhile compares with
      // this and does not write the same again
      commit('updateChannelTagsByChannel', { channelId, channelTags })
      await DBChannelHandlers.updateTags(channelId, channelTags)
    } catch (errMessage) {
      console.error(errMessage)
    }
  },
}

const mutations = {
  updateChannelTagsByChannel(state, { channelId, channelTags }) {
    state.channelTags[channelId] = channelTags
  },

  setChannelTags(state, channelTags) {
    // Any seen while this was loading are newer than what was on disk
    state.channelTags = { ...channelTags, ...state.channelTags }
  },
}

export default {
  state,
  getters,
  actions,
  mutations
}
