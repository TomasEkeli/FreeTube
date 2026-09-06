/**
 * Assembling the four subscription feeds into one stream.
 *
 * The subscriptions page used to be four tabs, one per kind, each a list sorted
 * by itself. One stream means one order, and the only thing that ever stood in
 * the way of it is that the kinds spell their publish time differently: videos,
 * shorts and live streams carry `published`, posts carry `publishedTime`. Both
 * are milliseconds since the epoch. Normalising that is nearly the whole job.
 *
 * The rest of it is taking the future back out again: premieres and scheduled
 * live streams carry their premiere date as their publish time, so one order by
 * publish time would open the stream with things nobody can watch yet. They are
 * split off here and shown as a schedule instead.
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

/**
 * Whether this entry is something that has not happened yet: a premiere or a
 * scheduled live stream still ahead of us.
 *
 * Two questions, and both have to answer yes.
 *
 * Is it scheduled at all? Answered from the flags the sources set, and
 * deliberately not from the publish time being in the future. The two agree
 * today only because a premiere is given its premiere date as its publish time
 * — which is the very defect the shelf exists to undo, and a shelf that
 * depended on it would be built on the thing it is meant to correct.
 *
 * Not `isUpcomingPremiere`, which this file's renderer neighbour uses for the
 * hide-premieres setting. That predicate falls back to "an RSS entry with no
 * views is probably a premiere", a guess that is fine for a filter the reader
 * asked for and wrong for this: it would take every genuinely new upload out of
 * the stream for as long as nobody had watched it. An RSS entry says nothing
 * about premieres, so it stays in the stream until the detail back-fill fetches
 * the channel page and learns better, at which point the next rebuild moves it.
 *
 * And is it still ahead? The flag alone is not enough, because nothing ever
 * takes it off: an RSS refresh brings no premiere flag at all, so the carry-over
 * hands the old one straight back, and a stream that aired in August is still
 * marked upcoming in September. Twenty-eight entries were flagged in one real
 * profile and ten of them had already happened. A schedule that opens with ten
 * things one has already missed is not a schedule. When the stated time has
 * passed the thing has happened, and where it belongs is the stream, at the time
 * it happened — which is exactly where its publish time puts it.
 *
 * An entry nothing dates stays on the shelf: it was scheduled, and there is no
 * evidence it is over.
 *
 * @param {object} entry
 * @param {number} [now] milliseconds since the epoch, for the callers that
 *   split a whole list and should not ask the clock once per entry
 * @returns {boolean}
 */
export function subscriptionEntryIsUpcoming(entry, now = Date.now()) {
  const scheduled = entry.isUpcoming === true ||
    entry.premiere === true ||
    entry.premiereDate != null ||
    entry.premiereTimestamp != null

  if (!scheduled) { return false }

  const at = subscriptionEntryScheduledAt(entry)

  return at == null || at > now
}

/**
 * When an upcoming entry is scheduled for, or null when nothing says.
 *
 * The premiere date is preferred over the publish time even though they are
 * meant to hold the same instant, because the premiere date is the one the
 * source actually stated and the publish time is derived from it.
 *
 * `premiereDate` arrives as a `Date` from the scrapers and as a string once it
 * has been through the cache, since that is JSON on disk.
 *
 * @param {object} entry
 * @returns {number | null} milliseconds since the epoch
 */
export function subscriptionEntryScheduledAt(entry) {
  if (entry.premiereDate != null) {
    const at = entry.premiereDate instanceof Date
      ? entry.premiereDate.getTime()
      : Date.parse(entry.premiereDate)

    if (Number.isFinite(at)) { return at }
  }

  if (entry.premiereTimestamp != null) {
    const at = Number(entry.premiereTimestamp) * 1000

    if (Number.isFinite(at)) { return at }
  }

  const published = subscriptionEntryPublishedAt(entry)

  return published === 0 ? null : published
}

/**
 * Take the future out of the stream.
 *
 * The stream is what has been published, so a premiere three days out has no
 * business in it at all — least of all at the top, which is where its publish
 * time puts it and where it displaces the newest thing anyone can actually
 * watch. The two lists are read differently and so are ordered differently:
 * the stream is history, newest first, and the shelf is a schedule, soonest
 * first.
 *
 * The stream keeps the order it arrived in, which is the merge's. Only the
 * shelf is sorted here.
 *
 * An upcoming entry that nothing dates goes to the end of the shelf: it is
 * still scheduled, and "when" is the one thing the shelf is sorted by, so
 * placing an unknown time anywhere among the known ones would be a claim.
 *
 * @param {any[]} entries the merged stream, newest first
 * @param {number} [now] milliseconds since the epoch, asked once so that one
 *   list is split against one instant
 * @returns {{ stream: any[], upcoming: any[] }}
 */
export function splitUpcomingEntries(entries, now = Date.now()) {
  const stream = []
  const upcoming = []

  for (const entry of entries) {
    if (subscriptionEntryIsUpcoming(entry, now)) {
      upcoming.push(entry)
    } else {
      stream.push(entry)
    }
  }

  upcoming.sort((a, b) => {
    return (subscriptionEntryScheduledAt(a) ?? Infinity) - (subscriptionEntryScheduledAt(b) ?? Infinity)
  })

  return { stream, upcoming }
}
