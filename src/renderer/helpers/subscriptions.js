import store from '../store/index'

/**
 * How many channels to fetch at once, and how long to wait between batches.
 *
 * The scraper value is upstream's, from the change that replaced "force RSS
 * above 125 subscriptions" with batched fetching. RSS is given a smaller batch
 * because it is the path people fall back to when the scraper is already
 * failing, so it is the one that must not make things worse. Both numbers are
 * guesses that want measuring against a real subscription list; FT_SUBS_TRACE
 * reports the peak concurrency they actually produce.
 */
export const SUBSCRIPTION_SCRAPER_CHUNK_SIZE = 80

/**
 * Measured, not guessed. 50 at a time fetched 611 channels with no failures at
 * all; 100 at a time failed every request within 300ms of starting and took the
 * renderer down with it. Raise this only with evidence.
 */
export const SUBSCRIPTION_RSS_CHUNK_SIZE = 50
export const SUBSCRIPTION_CHUNK_DELAY_MS = 2000

/**
 * Run an async worker over items in batches, pausing between batches.
 *
 * Without this a few hundred subscriptions become a few hundred near
 * simultaneous requests to one host. The browser does not save us here: HTTP/2
 * multiplexes the lot over a single connection rather than applying the old
 * six-per-host limit.
 *
 * Results come back in input order, and a rejecting worker rejects the whole
 * batch, so workers are expected to handle their own failures. Every current
 * caller does.
 *
 * @template TItem, TResult
 * @param {TItem[]} items
 * @param {(item: TItem) => Promise<TResult>} worker
 * @param {object} options
 * @param {number} options.chunkSize
 * @param {number} options.delayMs
 * @returns {Promise<TResult[]>}
 */
export async function processInChunks(items, worker, { chunkSize, delayMs }) {
  const results = []

  for (let i = 0; i < items.length; i += chunkSize) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    const chunk = items.slice(i, i + chunkSize)

    results.push(...await Promise.all(chunk.map(worker)))
  }

  return results
}

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
    videoList = videoList.filter(item => {
      if (item.isRSS) {
        // viewCount is our only method of detecting premieres in RSS
        // data without sending an additional request.
        // If we ever get a better flag, use it here instead.
        return item.viewCount !== '0'
      }
      // Observed for premieres in Local API Subscriptions.
      return (item.premiereDate == null ||
        // Invidious API
        // `premiereTimestamp` only available on premiered videos
        // https://docs.invidious.io/api/common_types/#videoobject
        item.premiereTimestamp == null
      )
    })
  }

  videoList.sort((a, b) => {
    return b.published - a.published
  })

  return videoList
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
