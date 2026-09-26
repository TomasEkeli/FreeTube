import store from '../store/index'
import { normaliseChannelTags } from './profileSuggestions'

/**
 * Remembers what a channel page says about a channel: its tags, and whether
 * it is a music artist's. Called with every channel page response the app
 * fetches anyway, for its videos, its streams or the channel itself, so it
 * costs no requests. The store keeps them only for subscribed channels, and
 * only writes when they have changed.
 *
 * Never throws: whatever fetched the page has better things to do than fail
 * over this.
 * @param {string | undefined} channelId
 * @param {string | undefined} channelName
 * @param {{ tags?: unknown, keywords?: unknown, music_artist_name?: unknown } | null | undefined} metadata
 * @param {object} [options]
 * @param {boolean} [options.artistKnown] false when the response cannot say
 * whether the channel is an artist's, which leaves the flag as it was
 */
export function rememberChannelTags(channelId, channelName, metadata, { artistKnown = true } = {}) {
  if (typeof channelId !== 'string' || channelId === '') { return }

  try {
    const { tags, musicArtist } = normaliseChannelTags(metadata, channelName)

    store.dispatch('updateChannelTags', { channelId, tags, musicArtist: artistKnown ? musicArtist : null })
  } catch (error) {
    console.error(error)
  }
}
