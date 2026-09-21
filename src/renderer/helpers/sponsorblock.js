import store from '../store/index'
import { deepCopy } from './utils'

/**
 * The entries already on the list come out of the store as Vue's reactive
 * proxies, and a proxy cannot cross the IPC boundary to the settings database:
 * the structured clone throws, the updater swallows it, and the setting is
 * never committed. So everything on its way to the store goes through a plain
 * copy first.
 * @param {{ id: string, name: string }[]} channels
 * @returns {Promise<void>} resolves once the write has been tried, whether or
 * not it landed
 */
function storeMarkOnlyChannels(channels) {
  return store.dispatch('updateSponsorBlockMarkOnlyChannels', deepCopy(channels))
}

/**
 * Whether this channel's segments are only ever marked, never skipped.
 * Reads the setting through the store getter, so callers that ask inside a
 * computed stay reactive to the list changing.
 * @param {string} channelId
 * @returns {boolean}
 */
export function isSponsorBlockMarkOnlyChannel(channelId) {
  if (!channelId) {
    return false
  }

  return store.getters.getSponsorBlockMarkOnlyChannels
    .some(channel => channel.id === channelId)
}

/**
 * Add the channel to the never-skip list, or take it off again if it is already
 * on it. The name is stored alongside the id purely so the settings list has
 * something to show.
 * @param {string} channelId
 * @param {string} channelName
 * @returns {Promise<boolean>} whether the channel is on the list afterwards.
 * Read back from the store rather than assumed, because the updater reports a
 * failed write by logging it and leaving the setting alone, so the only honest
 * answer is the one the store gives once the write has been tried.
 */
export async function toggleSponsorBlockMarkOnlyChannel(channelId, channelName) {
  if (!channelId) {
    return false
  }

  const channels = store.getters.getSponsorBlockMarkOnlyChannels

  if (channels.some(channel => channel.id === channelId)) {
    await storeMarkOnlyChannels(channels.filter(channel => channel.id !== channelId))
  } else {
    await storeMarkOnlyChannels([...channels, { id: channelId, name: channelName || channelId }])
  }

  return isSponsorBlockMarkOnlyChannel(channelId)
}

/**
 * @param {string[]} channelIds
 */
export function removeSponsorBlockMarkOnlyChannels(channelIds) {
  const removing = new Set(channelIds)

  storeMarkOnlyChannels(
    store.getters.getSponsorBlockMarkOnlyChannels.filter(channel => !removing.has(channel.id))
  )
}

async function getVideoHash(videoId) {
  const videoIdBuffer = new TextEncoder().encode(videoId)

  const hashBuffer = await crypto.subtle.digest('SHA-256', videoIdBuffer)
  const hashArray = new Uint8Array(hashBuffer)

  return hashArray[0].toString(16).padStart(2, '0') +
    hashArray[1].toString(16).padStart(2, '0')
}

/**
 * @typedef {'sponsor' | 'selfpromo' | 'interaction' | 'intro' | 'outro' | 'preview' | 'music_offtopic' | 'filler'} SponsorBlockCategory
 */

/**
 * @param {string} videoId
 * @param {SponsorBlockCategory[]} categories
 * @returns {Promise<{
 *   UUID: string,
 *   actionType: string,
 *   category: SponsorBlockCategory,
 *   description: string,
 *   locked: 1|0,
 *   segment: [
 *     number,
 *     number
 *   ],
 *   videoDuration: number,
 *   votes: number
 * }[]>}
 */
export async function sponsorBlockSkipSegments(videoId, categories) {
  const videoIdHashPrefix = await getVideoHash(videoId)
  const requestUrl = `${store.getters.getSponsorBlockUrl}/api/skipSegments/${videoIdHashPrefix}?categories=${JSON.stringify(categories)}`

  try {
    const response = await fetch(requestUrl)

    // 404 means that there are no segments registered for the video
    if (response.status === 404) {
      return []
    }

    // Sometimes the sponsor block server goes down or returns other errors
    if (!response.ok) {
      throw new Error(await response.text())
    }

    const json = await response.json()
    return json
      .filter((result) => result.videoID === videoId)
      .flatMap((result) => result.segments)
  } catch (error) {
    console.error('failed to fetch SponsorBlock segments', requestUrl, error)
    throw error
  }
}

export async function deArrowData(videoId) {
  const videoIdHashPrefix = await getVideoHash(videoId)
  const requestUrl = `${store.getters.getSponsorBlockUrl}/api/branding/${videoIdHashPrefix}`

  try {
    const response = await fetch(requestUrl)

    // 404 means that there are no segments registered for the video
    if (response.status === 404) {
      return undefined
    }

    const json = await response.json()
    return json[videoId] ?? undefined
  } catch (error) {
    console.error('failed to fetch DeArrow data', requestUrl, error)
    throw error
  }
}

export async function deArrowThumbnail(videoId, timestamp) {
  let requestUrl = `${store.getters.getDeArrowThumbnailGeneratorUrl}/api/v1/getThumbnail?videoID=` + videoId
  if (timestamp != null) {
    requestUrl += `&time=${timestamp}`
  }

  try {
    const response = await fetch(requestUrl)

    // 204 means that there are no thumbnails found for the video
    if (response.status === 204) {
      return undefined
    }

    if (response.ok) {
      return response.url
    }

    // this usually means that a thumbnail was not generated on the server yet so we'll log the error but otherwise ignore it.
    const json = await response.json()
    console.error(json)
    return undefined
  } catch (error) {
    console.error('failed to fetch DeArrow data', requestUrl, error)
    throw error
  }
}
