import store from '../store/index'

/*
 * The batching that used to live here — fifty channels, then a two second
 * pause — is now `SUBSCRIPTION_BUDGET` in `subscriptionWorker.js`. It moved
 * because it was per refresh, and therefore per feed: two feeds refreshing
 * together made two batches of fifty, which is the hundred at a time that was
 * measured taking the renderer down. A budget one manager hands out composes,
 * where a batch size each caller applies for itself does not.
 */

/**
 * Filtering and sort based on user preferences
 * @param {any[]} videos
 */
export function updateVideoListAfterProcessing(videos) {
  let videoList = videos

  if (store.getters.getHideLiveStreams) {
    videoList = videoList.filter(item => {
      return (!item.liveNow && !item.isUpcoming)
    })
  }

  if (store.getters.getHideUpcomingPremieres) {
    videoList = videoList.filter(item => !isUpcomingPremiere(item))
  }

  videoList.sort((a, b) => {
    return b.published - a.published
  })

  return videoList
}

/**
 * Whether this entry is a premiere that has not aired yet.
 *
 * Each source says so in its own way, and RSS does not say so at all: the Atom
 * feed carries no premiere flag, so a view count of zero is the only hint to be
 * had without spending a request per video. A feed that omits the view count
 * says nothing either way, and silence is not evidence.
 *
 * One predicate, because there were two, written from the same comment and kept
 * in step by hand until they stopped being. See the note in the RSS branch.
 *
 * @param {object} item a video as the subscription feeds and the list wrapper
 *   hold it, from RSS, the local API, or Invidious
 * @returns {boolean}
 */
export function isUpcomingPremiere(item) {
  if (item.isRSS) {
    // Deliberately compared as a number. This read `viewCount === '0'` from
    // when the feed's raw attribute was stored as a string, and went on
    // reading it after #8328 parsed it into a number, at which point it
    // matched nothing and the setting quietly stopped working. The `!= null`
    // keeps an absent count out of it, since `Number(null)` is `0`.
    return item.viewCount != null && Number(item.viewCount) === 0
  }

  // Observed for premieres from the local API
  return item.premiereDate != null ||
    // Invidious sets this only on premieres
    // https://docs.invidious.io/api/common_types/#videoobject
    item.premiereTimestamp != null
}

/**
 * The video an entry in the feed leads to.
 *
 * For a video that is the video. For a post carrying one it is the attachment's,
 * because the post is a gateway: the card opens the video, so watching that
 * video is what "watched" means for the post as well. Without this a shared
 * video stays in a feed that hides watched videos for ever, since nothing the
 * post holds is a video id.
 *
 * Anything else — a text post, a poll, a shared playlist — leads to no video and
 * says so.
 *
 * @param {object} entry an entry as the merged subscription stream holds it
 * @returns {string | undefined}
 */
export function entryVideoId(entry) {
  if (entry.videoId) { return entry.videoId }

  const attachment = entry.postContent

  return attachment?.type === 'video' ? attachment.content?.videoId : undefined
}

/**
 * Parse a YouTube Atom feed.
 *
 * A feed that parses but has no `entry` elements is a real answer: the channel
 * has nothing of this kind. A feed that does not parse is not, and the
 * difference matters, because YouTube answers some requests it dislikes with
 * HTTP 200 and an HTML page. That used to come back as an empty video list,
 * indistinguishable from an empty channel, and got written to the cache as
 * emptiness. `videos: null` marks it instead, which the callers already treat
 * as "do not touch the cache".
 *
 * @param {string} rssString
 * @param {string} channelId
 * @returns {Promise<{ name?: string, videos: any[] | null, parseFailed?: boolean }>}
 */
export async function parseYouTubeRSSFeed(rssString, channelId) {
  // doesn't need to be asynchronous, but doing it allows us to do the relatively slow DOM querying in parallel
  try {
    const xmlDom = new DOMParser().parseFromString(rssString, 'application/xml')

    // DOMParser reports malformed input as a document containing this element
    // rather than by throwing
    if (xmlDom.querySelector('parsererror') != null) {
      return {
        videos: null,
        parseFailed: true
      }
    }

    const channelName = xmlDom.querySelector('author > name').textContent
    const entries = xmlDom.querySelectorAll('entry')

    const promises = []

    for (const entry of entries) {
      promises.push(parseRSSEntry(entry, channelId, channelName))
    }

    return {
      name: channelName,
      videos: await Promise.all(promises)
    }
  } catch {
    return {
      videos: null,
      parseFailed: true
    }
  }
}

/**
 * @param {Element} entry
 * @param {string} channelId
 * @param {string} channelName
 */
async function parseRSSEntry(entry, channelId, channelName) {
  // doesn't need to be asynchronous, but doing it allows us to do the relatively slow DOM querying in parallel

  const rawViewCount = entry.getElementsByTagName('media:statistics')[0]?.getAttribute('views')

  let viewCount = null

  if (rawViewCount) {
    const parsedViewCount = parseInt(rawViewCount)

    if (!isNaN(parsedViewCount)) {
      viewCount = parsedViewCount
    }
  }

  return {
    authorId: channelId,
    author: channelName,
    // querySelector doesn't support xml namespaces so we have to use getElementsByTagName here
    videoId: entry.getElementsByTagName('yt:videoId')[0].textContent,
    title: entry.querySelector('title').textContent,
    published: Date.parse(entry.querySelector('published').textContent),
    viewCount,
    type: 'video',
    lengthSeconds: '0:00',
    isRSS: true
  }
}
