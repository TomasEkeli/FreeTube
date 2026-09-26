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
