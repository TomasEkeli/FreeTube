import { reactive, readonly } from 'vue'

import store from '../store/index'
import { getLocalChannelVideos, getLocalVideoMetadata } from './api/local'
import { getInvidiousChannelVideos, invidiousGetVideoMetadata } from './api/invidious'
import { enqueueSubscriptionJob, subscriptionWorkerProgress, LANE_ENRICHMENT, LANE_REFRESH, LANE_RECOVERY } from './subscriptionWorker'
import { VIDEO_SAMPLE_SIZE, videoSample } from './profileSuggestions'

/**
 * Learning about channels on request, from the Channels page: for each channel
 * FreeTube knows too little about, a look at a few of its recent videos, whose
 * categories and tags then feed the suggestions.
 *
 * It goes carefully, as it asks YouTube for things nobody is waiting on:
 *
 * - every request goes through the request manager's lowest lane, one at a
 *   time, so that it counts against the same budget as everything else
 * - a pause of its own between requests, on top of the lane's
 * - nothing at all while a refresh or a recovery is running
 * - at the first sign of being refused, it stops, and says so
 *
 * The videos come from the subscription cache where it has them, so most
 * channels cost one request per video and nothing more. A channel with none
 * cached costs one more, for its videos tab, which also records its tags.
 *
 * It lives here rather than on the page, so that leaving the page does not
 * stop it. What it learns is kept on each channel's record as it goes, so
 * stopping loses nothing, and starting again carries on where it stopped.
 */

/** The pause between two of its requests, over and above the lane's own */
export const LEARNING_GAP_MS = 2000

/** How often to look again whether a refresh has finished */
const REFRESH_POLL_MS = 1000

/**
 * Failures in a row taken as being refused, whatever they look like: an
 * instance that is refusing may answer with a page that is not JSON at all
 */
const FAILURES_TAKEN_AS_REFUSAL = 3

let failuresInARow = 0

const progress = reactive({
  running: false,
  /** Channels finished in this run */
  done: 0,
  /** Channels this run set out to learn about */
  total: 0,
  /** @type {'finished' | 'stopped' | 'refused' | null} how the last run ended */
  ended: null
})

/** How learning is going, for the page to read. Mutated only in here. */
export const channelLearningProgress = readonly(progress)

let stopRequested = false

function isStopRequested() {
  return stopRequested
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Waits for the subscriptions to be left alone: a refresh always comes first */
async function waitForQuiet() {
  const busy = () => [LANE_REFRESH, LANE_RECOVERY].some(lane => {
    const counts = subscriptionWorkerProgress.lanes[lane]

    return counts.queued > 0 || counts.inFlight > 0
  })

  // Stopping is asked for from outside, while this waits
  while (busy() && !isStopRequested()) {
    await sleep(REFRESH_POLL_MS)
  }
}

/**
 * @param {unknown} error
 * @returns {boolean} whether YouTube, or the instance, is refusing us
 */
function isRefusal(error) {
  const message = error instanceof Error ? error.message : String(error)

  return /status code (403|429)\b|LOGIN_REQUIRED|Too Many Requests/i.test(message)
}

class Refused extends Error {}

/**
 * One request, in its turn on the request manager, then the pause. Resolves
 * to what it returned, or to null for a failure that is only about the one
 * thing asked for. Throws `Refused` when it was refused.
 * @template T
 * @param {string} key
 * @param {string} label
 * @param {() => Promise<T>} request
 * @returns {Promise<T | null>}
 */
async function ask(key, label, request) {
  await waitForQuiet()

  if (stopRequested) { return null }

  let result = null
  let failure = null

  await enqueueSubscriptionJob(LANE_ENRICHMENT, {
    key,
    label,
    run: async () => {
      try {
        result = await request()
      } catch (error) {
        failure = error
      }
    }
  })

  await sleep(LEARNING_GAP_MS)

  if (failure !== null) {
    failuresInARow++

    if (isRefusal(failure) || failuresInARow >= FAILURES_TAKEN_AS_REFUSAL) { throw new Refused(String(failure)) }

    console.error(failure)
  } else {
    failuresInARow = 0
  }

  return result
}

/**
 * The newest few videos of a channel the subscription cache knows of: videos
 * first, then streams, then shorts.
 * @param {string} channelId
 * @returns {string[]}
 */
function cachedVideoIds(channelId) {
  const ids = []

  for (const cache of [store.getters.getVideoCache, store.getters.getLiveCache, store.getters.getShortsCache]) {
    for (const video of cache[channelId]?.videos ?? []) {
      if (typeof video?.videoId === 'string' && !ids.includes(video.videoId)) {
        ids.push(video.videoId)
      }
    }

    if (ids.length >= VIDEO_SAMPLE_SIZE) { break }
  }

  return ids.slice(0, VIDEO_SAMPLE_SIZE)
}

/**
 * @returns {boolean}
 */
function usingInvidious() {
  return !process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious'
}

/**
 * Looks at one channel's recent videos and keeps what they say.
 * @param {import('./channelsOverview').Channel} channel
 */
async function learnAbout(channel) {
  const label = channel.name ?? channel.id
  let videoIds = cachedVideoIds(channel.id)

  if (videoIds.length === 0) {
    const listed = await ask(`learn-channel-${channel.id}`, label, async () => {
      return usingInvidious()
        ? (await getInvidiousChannelVideos(channel.id))?.videos
        : (await getLocalChannelVideos(channel.id))?.videos
    })

    if (stopRequested) { return }

    videoIds = (listed ?? []).map(video => video.videoId).filter(id => typeof id === 'string').slice(0, VIDEO_SAMPLE_SIZE)
  }

  const videos = []

  for (const videoId of videoIds) {
    const metadata = await ask(`learn-video-${videoId}`, label, () => {
      return usingInvidious() ? invidiousGetVideoMetadata(videoId) : getLocalVideoMetadata(videoId)
    })

    if (stopRequested) { return }

    if (metadata !== null) {
      videos.push(videoSample(videoId, metadata.category, metadata.keywords, channel.name))
    }
  }

  // Kept even when nothing was found, so that the channel is not asked about
  // again: a channel with no videos has nothing more to say
  await store.dispatch('updateVideoSamples', { channelId: channel.id, videos })
}

/**
 * Learns about the channels given, in order, one at a time. Does nothing
 * while a run is already going.
 * @param {import('./channelsOverview').Channel[]} channels
 */
export async function learnAboutChannels(channels) {
  if (progress.running || channels.length === 0) { return }

  stopRequested = false
  failuresInARow = 0
  progress.running = true
  progress.done = 0
  progress.total = channels.length
  progress.ended = null

  try {
    for (const channel of channels) {
      if (stopRequested) { break }

      await learnAbout(channel)

      if (!stopRequested) {
        progress.done++
      }
    }

    progress.ended = stopRequested ? 'stopped' : 'finished'
  } catch (error) {
    if (!(error instanceof Refused)) { throw error }

    console.warn('Learning about channels stopped, as YouTube refused a request', error.message)
    progress.ended = 'refused'
  } finally {
    progress.running = false
  }
}

/** Stops after the request in flight, keeping everything learned so far */
export function stopLearning() {
  stopRequested = true
}
