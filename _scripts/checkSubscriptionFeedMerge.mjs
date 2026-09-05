/**
 * Checks the rules for assembling the four subscription feeds into one stream.
 *
 * The merge is the one place where the kinds meet, and it fails quietly: a post
 * that sorts to the bottom of the stream because its time was read from the
 * wrong field looks exactly like a channel that has not posted lately, and a
 * live stream listed twice looks like the channel uploaded it twice. Nothing
 * throws. So the rules are asserted here.
 *
 * Run with `pnpm run check-subscription-feed-merge`. There is no test runner in
 * this project, which is why this is a script.
 */

import {
  mergeSubscriptionFeedEntries,
  subscriptionEntryPublishedAt
} from '../src/subscriptionFeedMerge.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

/** A video, short or live stream, as every source spells one. */
function video(id, daysAgo, overrides = {}) {
  return {
    videoId: id,
    authorId: 'UC1',
    author: 'Channel',
    title: id,
    type: 'video',
    published: NOW - daysAgo * DAY,
    ...overrides
  }
}

/** A community post, which spells its time differently and has no video id. */
function post(id, daysAgo, overrides = {}) {
  return {
    postId: id,
    authorId: 'UC1',
    author: 'Channel',
    type: 'community',
    publishedTime: NOW - daysAgo * DAY,
    ...overrides
  }
}

const idsOf = entries => entries.map(entry => entry.videoId ?? entry.postId).join(',')

// The whole point: a post takes its place among the videos by date, rather than
// arriving after them because it was a different list
{
  const merged = mergeSubscriptionFeedEntries([
    [video('v-today', 0), video('v-old', 5)],
    [post('p-yesterday', 1)]
  ])

  check(
    `posts interleave with videos by date (${idsOf(merged)})`,
    idsOf(merged) === 'v-today,p-yesterday,v-old'
  )
}

// Every kind at once, newest first, regardless of which list it came in
{
  const merged = mergeSubscriptionFeedEntries([
    [video('video', 3)],
    [video('short', 1, { type: 'shortVideo' })],
    [video('live', 4, { liveNow: true })],
    [post('post', 2)]
  ])

  check(
    `four kinds sort into one order (${idsOf(merged)})`,
    idsOf(merged) === 'short,post,video,live'
  )
}

// The sort field is read per entry, not per list: a list holding both spellings
// still sorts correctly, which is what stops the merge from depending on the
// caller having grouped things the way it expects
{
  const merged = mergeSubscriptionFeedEntries([
    [post('p-old', 9), video('v-new', 1), post('p-new', 0)]
  ])

  check(`both time fields are read within one list (${idsOf(merged)})`, idsOf(merged) === 'p-new,v-new,p-old')
}

// An entry nothing dates sorts last rather than anywhere
{
  const undated = { videoId: 'undated', type: 'video' }
  const merged = mergeSubscriptionFeedEntries([[undated, video('dated', 300)]])

  check(`an undated entry sorts last (${idsOf(merged)})`, idsOf(merged) === 'dated,undated')
  check('and an undated entry reads as zero, not NaN', subscriptionEntryPublishedAt(undated) === 0)
}

// A finished live stream reported by two feeds is one entry, and it is the one
// from the earlier list
{
  const asLive = video('dup', 2, { liveNow: false, lengthSeconds: '' })
  const asVideo = video('dup', 2, { lengthSeconds: '1:02:03' })

  const merged = mergeSubscriptionFeedEntries([[asVideo], [asLive]])

  check(`the same video from two feeds appears once (${merged.length})`, merged.length === 1)
  check('and it is the copy from the earlier list', merged[0] === asVideo)
}

// Two posts by different channels can share nothing but a null video id; that
// must not collapse them
{
  const merged = mergeSubscriptionFeedEntries([[post('p1', 1), post('p2', 2)]])

  check(`posts are not confused with each other (${idsOf(merged)})`, idsOf(merged) === 'p1,p2')
}

// Something with neither id — a shape no parser produces today, but the merge
// should not silently swallow all but one of them if one ever does
{
  const merged = mergeSubscriptionFeedEntries([[
    { type: 'video', published: NOW },
    { type: 'video', published: NOW - DAY }
  ]])

  check(`entries with no id are all kept (${merged.length})`, merged.length === 2)
}

// The entries are the cached objects, passed through. The detail back-fill
// writes into them in place, so a merge that copied would break it in a way
// nothing else would notice.
{
  const original = video('v', 1)
  const merged = mergeSubscriptionFeedEntries([[original]])

  check('entries are passed through, not copied', merged[0] === original)
}

// Assembling is not allowed to reorder the caller's lists underneath it: the
// per-kind list is what the back-fill and the per-kind filters were handed
{
  const list = [video('a', 1), video('b', 2)]
  const before = idsOf(list)

  mergeSubscriptionFeedEntries([list])

  check(`the input lists are left alone (${before} -> ${idsOf(list)})`, idsOf(list) === before)
}

// An empty stream is an empty stream, not a crash
check('no kinds at all merges to nothing', mergeSubscriptionFeedEntries([]).length === 0)
check('empty kinds merge to nothing', mergeSubscriptionFeedEntries([[], [], [], []]).length === 0)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
