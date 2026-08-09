/**
 * Merging details fetched from a channel into cached subscription videos.
 *
 * RSS feeds carry a title, an author, an exact publish time, an exact view
 * count and nothing else. In particular they carry no duration, which is why
 * the feed shows no duration badge when it was built from RSS. The channel
 * pages carry duration and the live and premiere flags, so the two can be
 * combined: keep what RSS does better, take what only the channel page has.
 *
 * This lives outside both the store and the datastore because both need it and
 * they must not disagree. The equivalent logic for shorts is written out twice,
 * once in each, which is a standing invitation for the two to drift apart.
 */

/**
 * Fields the channel page has and RSS does not. Only filled in when the cached
 * entry has nothing, so that a later refresh cannot undo them.
 */
const DETAIL_FIELDS = [
  'liveNow',
  'isUpcoming',
  'premiereDate',
  'is4k',
  'is8k',
  'isVr180',
  'isVr360',
  'is3d',
  'hasCaptions',
  'isNew',
  'premium',
  'description'
]

/**
 * A duration of `'0:00'` is what the RSS parser writes when it has none, and
 * `''` is what the scrapers write for a live stream. Both mean "not known".
 * @param {unknown} lengthSeconds
 */
export function durationIsMissing(lengthSeconds) {
  return lengthSeconds === '0:00' || lengthSeconds === '' || lengthSeconds == null
}

/**
 * @param {any[]} cachedVideos mutated in place
 * @param {any[]} channelVideos
 * @returns {boolean} whether anything changed, so callers can skip a pointless write
 */
export function mergeChannelPageVideoDetails(cachedVideos, channelVideos) {
  if (!Array.isArray(cachedVideos) || cachedVideos.length === 0) { return false }
  if (!Array.isArray(channelVideos) || channelVideos.length === 0) { return false }

  const byVideoId = new Map()

  for (const video of channelVideos) {
    if (video?.videoId != null) {
      byVideoId.set(video.videoId, video)
    }
  }

  let changed = false

  for (const cached of cachedVideos) {
    const fresh = byVideoId.get(cached.videoId)

    if (fresh == null) { continue }

    let entryChanged = false

    if (durationIsMissing(cached.lengthSeconds) && !durationIsMissing(fresh.lengthSeconds)) {
      cached.lengthSeconds = fresh.lengthSeconds
      entryChanged = true
    }

    // Titles get edited, so the newer one wins
    if (fresh.title != null && fresh.title !== cached.title) {
      cached.title = fresh.title
      entryChanged = true
    }

    if (fresh.author != null && fresh.author !== cached.author) {
      cached.author = fresh.author
      entryChanged = true
    }

    // RSS reports an exact view count while the channel page rounds it, so the
    // larger number is the better one: 12345 beats 12000, 15000 beats 12345.
    if (typeof fresh.viewCount === 'number' && !(fresh.viewCount <= cached.viewCount)) {
      cached.viewCount = fresh.viewCount
      entryChanged = true
    }

    // `published` is deliberately never touched. RSS has an exact timestamp,
    // whereas the local scraper derives one from text like "3 days ago". Taking
    // the scraper's would reorder the feed under whoever is reading it, since
    // the feed is sorted by this field.

    for (const field of DETAIL_FIELDS) {
      // Deliberately truthiness rather than a null check. These are flags and
      // an absent one already reads as false everywhere, so writing an explicit
      // false would mean a database write and a re-render for a video that has
      // not actually changed. None of these fields is meaningfully false, empty
      // or zero.
      if (cached[field] == null && fresh[field]) {
        cached[field] = fresh[field]
        entryChanged = true
      }
    }

    if (entryChanged) {
      // Now that a real duration is present, the premiere filter can use
      // `premiereDate` instead of the view count guess it falls back to for RSS
      // entries.
      if (cached.isRSS && !durationIsMissing(cached.lengthSeconds)) {
        delete cached.isRSS
      }

      // FtListVideo reads its props once, at setup, so an item has to be given a
      // new key for the change to reach the screen. FtElementList builds its key
      // partly from this field.
      cached.lastUpdatedAt = Date.now()

      changed = true
    }
  }

  return changed
}
