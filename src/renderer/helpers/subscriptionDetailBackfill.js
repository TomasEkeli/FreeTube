import { ref } from 'vue'

import store from '../store/index'

import { getLocalChannelVideos } from './api/local'
import { getInvidiousChannelVideos } from './api/invidious'
import {
  enqueueSubscriptionJobs,
  cancelSubscriptionLane,
  LANE_ENRICHMENT
} from './subscriptionWorker'
import { durationIsMissing } from '../../subscriptionVideoDetails'

/**
 * Filling in the details RSS leaves out, for the part of the feed being looked
 * at.
 *
 * RSS carries no duration, so a feed built from it shows no duration badge. The
 * only source of duration is the channel page, which is the very thing being
 * avoided when falling back to RSS, so this is done as slowly as possible and
 * only for what is on screen: one channel at a time, on the shared worker, in
 * feed order from the top.
 *
 * One channel request covers every video that channel contributes to the feed,
 * which is why this works per channel rather than per video. The result is
 * written through to the cache, so a channel is filled in once and stays filled
 * in across restarts.
 *
 * If the channel page is blocked too then nothing happens, and nothing is lost:
 * the feed keeps the RSS data it already had. That is the whole bargain of doing
 * this in the background.
 */

/**
 * Channels tried and failed this session. Retrying them would mean a request per
 * scroll for a channel that has already said no.
 * @type {Set<string>}
 */
const failedThisSession = new Set()

/** Channels already filled in, so a re-offered feed costs nothing. */
const completedThisSession = new Set()

/**
 * Bumped whenever a merge actually changed something.
 *
 * The merge writes into the video objects the feed is already holding, but the
 * feed holds them in a shallowRef, so mutating them tells Vue nothing. Without a
 * signal the durations land in the store and on disk and never appear on
 * screen, which is exactly what happened the first time this was tried against a
 * real subscription list. The feed watches this and rebuilds its array, which
 * both triggers the shallowRef and lets the changed keys remount the items whose
 * details arrived.
 */
export const detailBackfillRevision = ref(0)

/**
 * Work out which channels are worth asking about, in the order they first appear
 * in what is being looked at.
 *
 * @param {any[]} visibleVideos the slice of the feed actually rendered
 * @returns {{ channelId: string, channelName?: string }[]}
 */
export function channelsNeedingDetails(visibleVideos) {
  /** @type {Map<string, string | undefined>} */
  const needed = new Map()

  for (const video of visibleVideos) {
    const channelId = video?.authorId

    if (channelId == null) { continue }
    if (needed.has(channelId)) { continue }
    if (failedThisSession.has(channelId) || completedThisSession.has(channelId)) { continue }

    // Live streams and premieres legitimately have no duration, so their absence
    // is not something to go and fetch.
    if (video.liveNow || video.isUpcoming) { continue }

    if (durationIsMissing(video.lengthSeconds)) {
      needed.set(channelId, video.author)
    }
  }

  return Array.from(needed, ([channelId, channelName]) => ({ channelId, channelName }))
}

/**
 * @param {string} channelId
 * @returns {Promise<any[] | null>}
 */
async function fetchChannelVideos(channelId) {
  if (!process.env.SUPPORTS_LOCAL_API || store.getters.getBackendPreference === 'invidious') {
    const result = await getInvidiousChannelVideos(channelId)

    return result?.videos ?? null
  }

  const result = await getLocalChannelVideos(channelId)

  // null means the channel is gone, which is not worth retrying
  return result?.videos ?? null
}

/**
 * Offer the visible part of the feed for filling in. Safe to call whenever the
 * visible slice changes: the worker drops channels it already has queued.
 *
 * @param {any[]} visibleVideos
 * @returns {number} how many channels were newly queued
 */
export function backfillDetailsForVisibleVideos(visibleVideos) {
  if (!store.getters.getSubscriptionBackfillDetails) { return 0 }

  const channels = channelsNeedingDetails(visibleVideos)

  if (channels.length === 0) { return 0 }

  return enqueueSubscriptionJobs(LANE_ENRICHMENT, channels.map(({ channelId, channelName }) => ({
    key: `videos-${channelId}`,
    label: channelName ?? channelId,
    run: async () => {
      let videos

      try {
        videos = await fetchChannelVideos(channelId)
      } catch (error) {
        console.error(error)
        failedThisSession.add(channelId)
        return
      }

      if (videos == null || videos.length === 0) {
        failedThisSession.add(channelId)
        return
      }

      completedThisSession.add(channelId)

      await store.dispatch('updateSubscriptionVideosCacheWithChannelPageVideos', {
        channelId,
        videos
      })

      detailBackfillRevision.value++
    }
  })))
}

/**
 * Called when the feed being looked at changes out from under the queue, for
 * instance on switching profile. Anything queued is for a feed nobody is reading
 * any more.
 */
export function cancelDetailBackfill() {
  cancelSubscriptionLane(LANE_ENRICHMENT)
}

/** Test seam. */
export function resetDetailBackfillForTests() {
  failedThisSession.clear()
  completedThisSession.clear()
}
