import { reactive, readonly } from 'vue'

import store from '../store/index'
import { getLocalChannelVideos, getLocalVideoMetadata } from './api/local'
import { getInvidiousChannelVideos, invidiousGetVideoMetadata } from './api/invidious'
import { enqueueSubscriptionJob, subscriptionWorkerProgress, LANE_ENRICHMENT, LANE_REFRESH, LANE_RECOVERY } from './subscriptionWorker'
import { VIDEO_SAMPLE_SIZE, videoSample } from './profileSuggestions'

/**
 * Probing channels on request, from the Channels page: for each channel asked
 * about that FreeTube knows too little about, a look at a few of its recent
 * videos, whose categories and tags then feed the suggestions.
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
 * Channels are probed one at a time, in the order they were asked for: asking
 * for a second column's while the first's are going queues them behind. Each
 * column can take its own back out of the queue.
 *
 * It lives here rather than on the page, so that leaving the page does not
 * stop it. What it finds is kept on each channel's record as it goes, so
 * stopping loses nothing, and probing again carries on where it stopped.
 */

/** The pause between two of its requests, over and above the lane's own */
export const PROBE_GAP_MS = 2000

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
  /** Channels probed since it last started */
  done: 0,
  /** @type {'finished' | 'refused' | null} how the last run ended */
  ended: null,
  /** @type {string | null} the channel being probed now */
  current: null
})

/** How probing is going, for the page to read. Mutated only in here. */
export const channelProbingProgress = readonly(progress)

/**
 * The channels still to probe, the one being probed first, in order
 * @type {import('./channelsOverview').Channel[]}
 */
const queue = []

/** The ids of the channels in the queue, for the page to ask about */
const queued = reactive(new Set())

/**
 * Whether a channel is waiting to be probed, or being probed now.
 * @param {string} channelId
 * @returns {boolean}
 */
export function isProbing(channelId) {
  return queued.has(channelId)
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Waits for the subscriptions to be left alone: a refresh always comes first.
 * @param {() => boolean} isStopped
 */
async function waitForQuiet(isStopped) {
  const busy = () => [LANE_REFRESH, LANE_RECOVERY].some(lane => {
    const counts = subscriptionWorkerProgress.lanes[lane]

    return counts.queued > 0 || counts.inFlight > 0
  })

  // Stopping is asked for from outside, while this waits
  while (busy() && !isStopped()) {
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
 * @param {() => boolean} isStopped
 * @returns {Promise<T | null>}
 */
async function ask(key, label, request, isStopped) {
  await waitForQuiet(isStopped)

  if (isStopped()) { return null }

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

  await sleep(PROBE_GAP_MS)

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
 * Looks at one channel's recent videos and keeps what they say. Gives up, with
 * nothing kept, if the channel is taken out of the queue meanwhile.
 * @param {import('./channelsOverview').Channel} channel
 */
async function probe(channel) {
  const label = channel.name ?? channel.id
  const isStopped = () => !queued.has(channel.id)
  let videoIds = cachedVideoIds(channel.id)

  if (videoIds.length === 0) {
    const listed = await ask(`probe-channel-${channel.id}`, label, async () => {
      return usingInvidious()
        ? (await getInvidiousChannelVideos(channel.id))?.videos
        : (await getLocalChannelVideos(channel.id))?.videos
    }, isStopped)

    if (isStopped()) { return }

    videoIds = (listed ?? []).map(video => video.videoId).filter(id => typeof id === 'string').slice(0, VIDEO_SAMPLE_SIZE)
  }

  const videos = []

  for (const videoId of videoIds) {
    const metadata = await ask(`probe-video-${videoId}`, label, () => {
      return usingInvidious() ? invidiousGetVideoMetadata(videoId) : getLocalVideoMetadata(videoId)
    }, isStopped)

    if (isStopped()) { return }

    if (metadata !== null) {
      videos.push(videoSample(videoId, metadata.category, metadata.keywords, channel.name))
    }
  }

  // Kept even when nothing was found, so that the channel is not asked about
  // again: a channel with no videos has nothing more to say
  await store.dispatch('updateVideoSamples', { channelId: channel.id, videos })

  progress.done++
}

async function run() {
  progress.running = true
  progress.done = 0
  progress.ended = null
  failuresInARow = 0

  try {
    while (queue.length > 0) {
      const channel = queue[0]

      progress.current = channel.id
      await probe(channel)

      // It may have been taken out of the queue while it was being probed
      const index = queue.indexOf(channel)

      if (index !== -1) { queue.splice(index, 1) }

      queued.delete(channel.id)
    }

    progress.ended = 'finished'
  } catch (error) {
    if (!(error instanceof Refused)) { throw error }

    console.warn('Probing channels stopped, as YouTube refused a request', error.message)
    progress.ended = 'refused'
    queue.length = 0
    queued.clear()
  } finally {
    progress.current = null
    progress.running = false
  }
}

/**
 * Probes the channels given, after any already waiting. Those already waiting
 * keep their place.
 * @param {import('./channelsOverview').Channel[]} channels
 */
export function probeChannels(channels) {
  for (const channel of channels) {
    if (queued.has(channel.id)) { continue }

    queued.add(channel.id)
    queue.push(channel)
  }

  if (!progress.running && queue.length > 0) {
    run()
  }
}

/**
 * Takes channels back out of the queue. One being probed stops after the
 * request in flight, with nothing of it kept, and is probed afresh next time.
 * @param {string[]} channelIds
 */
export function stopProbing(channelIds) {
  const stopping = new Set(channelIds)

  for (let i = queue.length - 1; i >= 0; i--) {
    if (stopping.has(queue[i].id)) {
      queue.splice(i, 1)
    }
  }

  for (const channelId of stopping) {
    queued.delete(channelId)
  }
}
