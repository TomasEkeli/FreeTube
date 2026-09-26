/**
 * Profile suggestions: where the channels on the Channels page might belong,
 * worked out from what the app has already seen of them and nothing else.
 *
 * Two things are remembered as the app goes, at no cost in requests: the
 * YouTube category of every video watched, on its history entry, and the tags
 * of every subscribed channel whose page passes through, on its subscription
 * cache record. This module turns those into suggestions.
 *
 * Like `channelsOverview`, it touches no store, no i18n and no router, so the
 * rules can be checked from node, in `_scripts/checkProfileSuggestions.mjs`.
 */

/** A channel keeps at most this many tags: some have dozens, chosen for search */
export const TAG_LIMIT = 30

/**
 * @typedef {object} ChannelTags
 * @property {string[]} tags normalised, in the order the channel gives them
 * @property {boolean} musicArtist whether it is a YouTube music artist channel
 * @property {number} [seenAt] ms since epoch, the last time the tags changed
 */

/**
 * A tag, or anything compared with one, as tags are kept: composed the same
 * way, lower case, trimmed and with every run of spaces made one.
 * @param {string} text
 * @returns {string}
 */
export function normaliseTag(text) {
  return text.normalize('NFC').toLowerCase().trim().replaceAll(/\s+/gu, ' ')
}

/**
 * A channel's keywords as YouTube gives them: one string, split on spaces,
 * with a keyword of more than one word in double quotes.
 * @param {unknown} keywords
 * @returns {string[]}
 */
function parseKeywords(keywords) {
  if (typeof keywords !== 'string') { return [] }

  const parsed = []

  for (const match of keywords.matchAll(/"([^"]*)"|(\S+)/gu)) {
    // A quote left open has no pair to end it; the stray mark goes
    parsed.push((match[1] ?? match[2]).replaceAll('"', ''))
  }

  return parsed
}

/**
 * The tags worth keeping from a channel page's metadata. The page's own tags
 * when it has any, otherwise the creator's keywords, which say much the same
 * thing in a harder form to read. Anything that cannot tell one channel from
 * another is dropped: nothing at all, a single character, a bare number, and
 * the channel's own name.
 * @param {{ tags?: unknown, keywords?: unknown, music_artist_name?: unknown } | null | undefined} metadata
 * @param {string} [channelName]
 * @returns {ChannelTags} without `seenAt`, which is for whoever stores them
 */
export function normaliseChannelTags(metadata, channelName) {
  const source = Array.isArray(metadata?.tags) && metadata.tags.length > 0
    ? metadata.tags
    : parseKeywords(metadata?.keywords)

  const ownName = typeof channelName === 'string' ? normaliseTag(channelName) : ''
  const seen = new Set()
  const tags = []

  for (const raw of source) {
    if (typeof raw !== 'string') { continue }

    const tag = normaliseTag(raw)

    if ([...tag].length < 2 || /^\p{N}+$/u.test(tag) || tag === ownName || seen.has(tag)) { continue }

    seen.add(tag)
    tags.push(tag)

    if (tags.length === TAG_LIMIT) { break }
  }

  const artistName = metadata?.music_artist_name

  return { tags, musicArtist: typeof artistName === 'string' && artistName.length > 0 }
}

/**
 * Whether newly seen tags differ from the ones kept, so that a refresh of
 * every channel writes only for the channels that changed. Reordered tags
 * count as a change, as the first matching tag decides some suggestions.
 * With nothing kept yet, nothing to keep is no change either.
 * @param {ChannelTags | null | undefined} stored
 * @param {ChannelTags} next
 * @returns {boolean}
 */
export function channelTagsChanged(stored, next) {
  if (!stored) {
    return next.tags.length > 0 || next.musicArtist
  }

  if (Boolean(stored.musicArtist) !== next.musicArtist) { return true }

  const storedTags = Array.isArray(stored.tags) ? stored.tags : []

  return storedTags.length !== next.tags.length || storedTags.some((tag, index) => tag !== next.tags[index])
}

/**
 * @typedef {object} HistoryEntry
 * @property {string} [authorId]
 * @property {string} [category]
 * @property {number} [timeWatched]
 */

/**
 * @typedef {object} WatchedCategory
 * @property {number} count how many watched videos had it
 * @property {number} lastWatched the most recent of them, ms since epoch
 */

/**
 * The categories of the videos watched from each channel: per channel id,
 * each category's count and the last time a video of it was watched. An
 * entry with no category, as every entry from before categories were
 * recorded has, or with no channel, says nothing and is skipped.
 * @param {HistoryEntry[]} historyEntries
 * @returns {Map<string, Map<string, WatchedCategory>>}
 */
export function watchedCategories(historyEntries) {
  /** @type {Map<string, Map<string, WatchedCategory>>} */
  const byChannel = new Map()

  for (const entry of historyEntries) {
    const channelId = entry.authorId
    const category = typeof entry.category === 'string' ? entry.category.trim() : ''

    if (typeof channelId !== 'string' || channelId === '' || category === '') { continue }

    let categories = byChannel.get(channelId)

    if (!categories) {
      categories = new Map()
      byChannel.set(channelId, categories)
    }

    const watchedAt = typeof entry.timeWatched === 'number' ? entry.timeWatched : 0
    const known = categories.get(category)

    if (known) {
      known.count++
      known.lastWatched = Math.max(known.lastWatched, watchedAt)
    } else {
      categories.set(category, { count: 1, lastWatched: watchedAt })
    }
  }

  return byChannel
}
