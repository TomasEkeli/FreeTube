/**
 * Checks the rules behind profile suggestions on the Channels page: what is
 * remembered about a channel, what category it is given, how profiles are
 * understood from their members, and which channels are proposed where.
 *
 * The page only draws what these functions return, and a suggestion that is
 * slightly wrong looks just as plausible as one that is right, so the rules
 * are pinned down here, input to output.
 *
 * Run with `pnpm run check-profile-suggestions`.
 */

import {
  watchedCategories,
} from '../src/renderer/helpers/profileSuggestions.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

// Watched categories
{
  const history = [
    { videoId: 'v1', authorId: 'a', category: 'Music', timeWatched: 100 },
    { videoId: 'v2', authorId: 'a', category: 'Music', timeWatched: 300 },
    { videoId: 'v3', authorId: 'a', category: 'Gaming', timeWatched: 200 },
    { videoId: 'v4', authorId: 'b', category: 'Comedy', timeWatched: 50 },
    { videoId: 'v5', authorId: 'b', timeWatched: 400 },
    { videoId: 'v6', authorId: 'b', category: '', timeWatched: 500 },
    { videoId: 'v7', category: 'Music', timeWatched: 600 },
    { videoId: 'v8', authorId: '', category: 'Music', timeWatched: 700 }
  ]

  const watched = watchedCategories(history)

  check('counts each category per channel', watched.get('a').get('Music').count === 2 && watched.get('a').get('Gaming').count === 1)
  check('keeps the most recent watch per category', watched.get('a').get('Music').lastWatched === 300)
  check('an entry with no category is ignored', watched.get('b').size === 1 && watched.get('b').get('Comedy').count === 1)
  check('an entry with no channel is ignored', watched.size === 2)
  check('no history gives nothing', watchedCategories([]).size === 0)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
