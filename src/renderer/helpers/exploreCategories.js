import store from '../store/index'

import { getLocalExploreDestinations, getLocalExploreFeed } from './api/local'

/**
 * What the Explore page shows, and how it finds out.
 *
 * There is no trending feed at YouTube any more, and there is no list of
 * categories either. What there is, is the Explore section of YouTube's own
 * sidebar — a handful of destinations, different in every region — and the
 * page is a row of chips over exactly those. Nothing here is allow-listed:
 * whatever YouTube says exists is what the reader can switch on.
 *
 * The one thing the code decides is what counts as a category, and the rule is
 * "a destination that answers with videos". Music answers with playlists,
 * Movies with a storefront, Playables with games; all three drop out without
 * being named. If YouTube ever puts videos behind one of them it gets a chip
 * that day.
 *
 * That rule has a cost, and it is the shape of everything below: you cannot
 * know whether a destination has videos without asking it. So discovery
 * fetches, and what it fetches is what the page shows.
 */

/**
 * Our own name for the destinations we recognise, keyed on the icon YouTube
 * draws them with — the one part of a guide entry that is neither localised
 * nor an opaque id.
 *
 * It buys two things. The chip's state is remembered under a name that means
 * something and does not move between regions, and the icon is one of ours, so
 * a category looks the same here as its kind does everywhere else in the app.
 *
 * A destination we do not recognise is not excluded: it gets its browseId as
 * its name and no icon, and YouTube's own title on the chip.
 */
const KNOWN_DESTINATIONS = {
  GAMING_LOGO_CAIRO: { id: 'gaming', icon: ['fas', 'gamepad'] },
  TROPHY_CAIRO: { id: 'sports', icon: ['fas', 'trophy'] },
  BROADCAST_CAIRO: { id: 'podcasts', icon: ['fas', 'podcast'] },
  LIVE_CAIRO: { id: 'live', icon: ['fas', 'tower-broadcast'] },
  NEWS_CAIRO: { id: 'news', icon: ['fas', 'newspaper'] },
  LEARNING_CAIRO: { id: 'learning', icon: ['fas', 'graduation-cap'] },
  FASHION_LOGO_CAIRO: { id: 'fashion', icon: ['fas', 'shirt'] }
}

/**
 * @typedef {object} ExploreCategory
 * @property {string} id our name for it, remembered by the chip setting
 * @property {string} title YouTube's own, in the reader's language
 * @property {string[]|null} icon
 * @property {any[]} videos what it was showing when we asked
 */

/**
 * Ask YouTube what it is showing in this region, and keep whatever answers
 * with videos.
 *
 * Every destination is asked, including the ones whose chips the reader has
 * switched off: the row cannot be drawn without knowing which destinations
 * have anything in them, and a chip switched off is still a chip. This is the
 * same bargain the subscriptions page makes — everything is fetched, the chips
 * only decide what is shown — and it is what makes switching one on instant.
 *
 * All of them at once, because they are independent and the reader is waiting.
 * One that fails or is empty simply does not appear; the rest of the page does
 * not wait for it and is not spoiled by it.
 *
 * @param {string} region
 * @param {string|undefined} lang
 * @returns {Promise<ExploreCategory[]>}
 */
export async function discoverExploreCategories(region, lang) {
  const destinations = await getLocalExploreDestinations(region, lang)

  const categories = await Promise.all(destinations.map(async destination => {
    let videos

    try {
      videos = await getLocalExploreFeed(region, destination)
    } catch (error) {
      // Some destinations answer with something youtubei.js cannot parse —
      // Memberships does today. That is an answer of "no videos here" as far as
      // this page is concerned.
      console.error(`Explore: ${destination.title} (${destination.browseId}) could not be read`, error)
      return null
    }

    if (videos.length === 0) { return null }

    const known = KNOWN_DESTINATIONS[destination.iconType]

    return {
      id: known?.id ?? destination.browseId,
      title: destination.title,
      icon: known?.icon ?? null,
      videos
    }
  }))

  // YouTube's order, which is the order the same destinations sit in on
  // YouTube's own sidebar. It is also the order the stream interleaves in.
  return categories.filter(category => category != null)
}

/**
 * Whether the reader has this category's chip switched on.
 *
 * The setting records what has been switched *off*, so a category nobody has
 * had an opinion about is on. That is the rule a discovered set needs: when
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
 * Switch a category's chip on or off. Persisted, because it is a standing
 * preference and not a mood.
 *
 * A category switched off keeps its entry even when it is not on offer in the
 * current region, so going back to the region it came from finds it as the
 * reader left it.
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
 * One stream out of several ranked ones: first place from each, then second
 * place from each, and so on until the longest runs out.
 *
 * Rank is the only thing YouTube vouches for here. These lists are charts, not
 * timelines — the publish dates on them are reconstructed from "3 days ago"
 * strings and would sort the merge into something nobody chose. Round-robin
 * keeps each chart's own order intact and reads the way a reader expects: the
 * best of everything first.
 *
 * It is also why the merge is derived from what was fetched on every read
 * rather than accumulated: switching a chip off takes its videos out and
 * leaves everything else where it was.
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
