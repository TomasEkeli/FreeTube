/**
 * Assembling the four subscription feeds into one stream.
 *
 * The subscriptions page used to be four tabs, one per kind, each a list sorted
 * by itself. One stream means one order, and the only thing that ever stood in
 * the way of it is that the kinds spell their publish time differently: videos,
 * shorts and live streams carry `published`, posts carry `publishedTime`. Both
 * are milliseconds since the epoch. Normalising that is nearly the whole job.
 *
 * This lives outside the renderer helpers, next to `subscriptionVideoDetails`,
 * because it touches neither the store nor the DOM and the checks in
 * `_scripts/checkSubscriptionFeedMerge.mjs` need to be able to import it.
 */

/**
 * When an entry was published, whatever kind it is.
 *
 * A post's time is reconstructed from relative text — "3 days ago" — and so is
 * only as precise as that text was. The imprecision is accepted rather than
 * worked around: the post lands somewhere inside the right day, which is close
 * enough to read a stream by, and the alternative costs a request per post.
 *
 * @param {object} entry
 * @returns {number} milliseconds since the epoch, or 0 when nothing says
 */
export function subscriptionEntryPublishedAt(entry) {
  const published = Number(entry.published ?? entry.publishedTime)

  return Number.isFinite(published) ? published : 0
}

/**
 * Assemble the per-kind lists into the one stream the subscriptions page shows.
 *
 * Each list arrives already filtered and sorted by its own feed's
 * `postProcess`, which is where the per-kind settings are applied. This does
 * only the part that needs every kind at once: one sort field, newest first.
 *
 * Deduplicated, because merging is the first thing that can show the same item
 * twice. The four feeds are meant to be disjoint — separate channel tabs,
 * separate RSS playlists — but a stream that has finished can be reported as
 * both a live stream and a video depending on which source answered, and two
 * copies of one upload in one list is a visible defect where two copies in two
 * tabs was invisible. First occurrence wins, so the order of `lists` decides
 * which kind an entry is counted as.
 *
 * The entries themselves are passed through untouched, not copied: they are the
 * cached objects, the detail back-fill writes into them, and a copy here would
 * quietly stop those writes from ever reaching the screen.
 *
 * @param {any[][]} lists one per kind, in the order kinds win ties
 * @returns {any[]}
 */
export function mergeSubscriptionFeedEntries(lists) {
  const merged = []
  const seen = new Set()

  for (const list of lists) {
    for (const entry of list) {
      const id = entry.videoId ?? entry.postId

      if (id != null) {
        if (seen.has(id)) { continue }

        seen.add(id)
      }

      merged.push(entry)
    }
  }

  return merged.sort((a, b) => subscriptionEntryPublishedAt(b) - subscriptionEntryPublishedAt(a))
}
