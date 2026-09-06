import store from '../store/index'

/**
 * The regions Explore offers as a click rather than as a hunt.
 *
 * YouTube has charts for a hundred and eleven countries and a reader has three
 * or four. The select holds all of them because it must; this holds the ones
 * that are actually being read, so switching between Norway and the UK is a
 * click and not a scroll through a list sorted by somebody else's alphabet.
 *
 * Two lists. Recent is a history: it maintains itself, it is short, and
 * anything can fall off it. Pinned is a statement: it is put there on purpose
 * and stays until it is taken away. They are kept apart because a history that
 * you can also nail things into is two ideas wearing one name — the pin would
 * have to survive being pushed off the end, which is the one thing a history
 * does to everything.
 */

/**
 * How many recent regions to keep. Four, because the reader who asked for this
 * named four countries, and because the row sits at the end of a control row
 * that must still fit in a narrow window.
 */
const RECENT_LIMIT = 4

/**
 * @typedef {object} RegionShortcut
 * @property {string} region the country code, which is also its label
 * @property {boolean} pinned
 */

/**
 * The shortcuts to show, in the order to show them: what is pinned, then where
 * the reader has recently been.
 *
 * Pins do not spend a recent slot. Pinning four countries and then visiting
 * four others leaves both sets intact, which is the whole point of saying a
 * place matters.
 *
 * @returns {RegionShortcut[]}
 */
export function exploreRegionShortcuts() {
  const pinned = store.getters.getExploreRegionsPinned
  const recent = store.getters.getExploreRegionsRecent

  return [
    ...pinned.map(region => ({ region, pinned: true })),
    ...recent
      .filter(region => !pinned.includes(region))
      .slice(0, RECENT_LIMIT)
      .map(region => ({ region, pinned: false }))
  ]
}

/**
 * Remember that the reader is looking at this region now.
 *
 * Called for wherever the page ends up pointed, however it got there — the
 * select, a shortcut, the settings screen, or simply opening the page — since
 * "recent" is about where you have been, not about which control took you
 * there.
 *
 * @param {string} region
 */
export function noteExploreRegionUsed(region) {
  const recent = store.getters.getExploreRegionsRecent

  if (recent[0] === region) { return Promise.resolve() }

  const updated = [region, ...recent.filter(other => other !== region)].slice(0, RECENT_LIMIT)

  return store.dispatch('updateExploreRegionsRecent', updated)
}

/**
 * Fix a region in place, or let it go again.
 *
 * @param {string} region
 */
export function toggleExploreRegionPinned(region) {
  const pinned = store.getters.getExploreRegionsPinned

  const updated = pinned.includes(region)
    ? pinned.filter(other => other !== region)
    : [...pinned, region]

  return store.dispatch('updateExploreRegionsPinned', updated)
}
