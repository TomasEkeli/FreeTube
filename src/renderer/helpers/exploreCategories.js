import store from '../store/index'

/**
 * The destinations Explore shows, and what each one looks like in the chip row.
 *
 * A fixed three for now, which is what the page has always fetched. The set is
 * about to stop being fixed: the next ticket discovers it from YouTube's own
 * guide, so everything here is written as a list to be replaced rather than a
 * shape to be extended.
 *
 * What each one is called is not here but in the view, because a translation
 * key can only be looked up from a literal — the same reason the subscription
 * feeds keep their titles apart from their descriptors.
 *
 * @typedef {object} ExploreCategory
 * @property {string} id what the caches, the settings and `getLocalTrending`
 *   all call this destination
 * @property {string[]} icon the chip's icon
 */

/** @type {ExploreCategory[]} */
export const EXPLORE_CATEGORIES = [
  {
    id: 'gaming',
    icon: ['fas', 'gamepad']
  },
  {
    id: 'sports',
    icon: ['fas', 'trophy']
  },
  {
    id: 'podcasts',
    icon: ['fas', 'podcast']
  }
]

/**
 * Whether the reader has this destination's chip switched on.
 *
 * The setting records what has been switched *off*, so a destination nobody has
 * had an opinion about is on. That is the rule the discovered set needs: when
 * YouTube starts offering somewhere new, it arrives in the stream rather than
 * waiting to be found in a list of things that are off.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function exploreCategoryIsShown(id) {
  return !store.getters.getExploreCategoriesHidden.includes(id)
}

/**
 * Switch a destination's chip on or off. Persisted, because it is a standing
 * preference and not a mood.
 *
 * @param {string} id
 * @param {boolean} shown
 */
export function setExploreCategoryShown(id, shown) {
  const hidden = store.getters.getExploreCategoriesHidden

  if (shown === !hidden.includes(id)) {
    return Promise.resolve()
  }

  const updated = shown ? hidden.filter(other => other !== id) : [...hidden, id]

  return store.dispatch('updateExploreCategoriesHidden', updated)
}

/**
 * The destinations the stream is assembled from, in chip-row order.
 *
 * @returns {string[]}
 */
export function enabledExploreCategories() {
  return EXPLORE_CATEGORIES
    .filter(category => exploreCategoryIsShown(category.id))
    .map(category => category.id)
}

/**
 * One stream out of several ranked ones: first place from each, then second
 * place from each, and so on until the longest runs out.
 *
 * Rank is the only thing YouTube vouches for here. These lists are charts, not
 * timelines — the publish dates on them are reconstructed from "3 days ago"
 * strings and would sort the merge into something nobody chose. Round-robin
 * keeps each chart's own order intact and reads the way a reader expects: the
 * best of everything first.
 *
 * It is also why the merge is derived from the caches on every read rather than
 * accumulated: a refetched destination drops back into its own slots and the
 * others do not move.
 *
 * The same video can top two charts. It is shown once, at the earlier slot.
 *
 * @param {any[][]} rankedLists
 * @returns {any[]}
 */
export function mergeByRank(rankedLists) {
  const merged = []
  const seen = new Set()
  const deepest = rankedLists.reduce((deepest, list) => Math.max(deepest, list.length), 0)

  for (let rank = 0; rank < deepest; rank++) {
    for (const list of rankedLists) {
      const entry = list[rank]

      if (entry == null) { continue }

      const identity = entry.videoId ?? entry

      if (seen.has(identity)) { continue }

      seen.add(identity)
      merged.push(entry)
    }
  }

  return merged
}
