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
  channelTagsChanged,
  normaliseChannelTags,
  TAG_LIMIT,
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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Normalising a channel page's tags
{
  check('the page tags are preferred over the keywords', same(
    normaliseChannelTags({ tags: ['Lo-Fi', 'Study'], keywords: 'ignored words' }, 'Chill Beats').tags,
    ['lo-fi', 'study']
  ))
  check('with no page tags, the keywords are used', same(
    normaliseChannelTags({ tags: [], keywords: 'lofi chill' }, 'Chill Beats').tags,
    ['lofi', 'chill']
  ))
  check('a quoted keyword stays whole', same(
    normaliseChannelTags({ keywords: 'gaming "let\'s play" "retro  games" speedrun' }).tags,
    ['gaming', "let's play", 'retro games', 'speedrun']
  ))
  check('a quote left open is not part of the keyword', same(
    normaliseChannelTags({ keywords: 'music "live sessions' }).tags,
    ['music', 'live', 'sessions']
  ))
  check('lower-cased, trimmed, and inner space collapsed', same(
    normaliseChannelTags({ tags: ['  Science   AND  Tech ', 'SPACE'] }).tags,
    ['science and tech', 'space']
  ))
  check('composed the same way whatever the input', same(
    normaliseChannelTags({ tags: ['cafe\u0301'] }).tags,
    ['caf\u00e9']
  ))
  check('empty tags, single characters and bare numbers are dropped', same(
    normaliseChannelTags({ tags: ['', '   ', 'a', '2024', '42', 'b2', 'ok'] }).tags,
    ['b2', 'ok']
  ))
  check('the channel\'s own name is dropped', same(
    normaliseChannelTags({ tags: ['Chill  Beats', 'lofi'] }, 'chill beats').tags,
    ['lofi']
  ))
  check('repeats are dropped, first seen order kept', same(
    normaliseChannelTags({ tags: ['Music', 'jazz', 'MUSIC', 'Jazz', 'blues'] }).tags,
    ['music', 'jazz', 'blues']
  ))

  const many = Array.from({ length: 50 }, (_, i) => `tag${i}`)
  const capped = normaliseChannelTags({ tags: many }).tags
  check('capped, keeping the first', capped.length === TAG_LIMIT && capped[0] === 'tag0' && capped[TAG_LIMIT - 1] === `tag${TAG_LIMIT - 1}`)

  check('an artist channel is flagged', normaliseChannelTags({ music_artist_name: 'Someone' }).musicArtist === true)
  check('an empty artist name is not an artist', normaliseChannelTags({ music_artist_name: '' }).musicArtist === false)
  check('no metadata gives nothing', same(normaliseChannelTags(undefined, 'x'), { tags: [], musicArtist: false }))
  check('tags that are not strings are skipped', same(normaliseChannelTags({ tags: [null, 3, 'fine'] }).tags, ['fine']))
}

// Whether newly seen tags need writing
{
  const stored = { tags: ['a1', 'b1'], musicArtist: false, seenAt: 1 }

  check('the same tags, order and flag need no write', !channelTagsChanged(stored, { tags: ['a1', 'b1'], musicArtist: false }))
  check('a tag added needs a write', channelTagsChanged(stored, { tags: ['a1', 'b1', 'c1'], musicArtist: false }))
  check('a tag removed needs a write', channelTagsChanged(stored, { tags: ['a1'], musicArtist: false }))
  check('reordered tags need a write', channelTagsChanged(stored, { tags: ['b1', 'a1'], musicArtist: false }))
  check('a changed artist flag needs a write', channelTagsChanged(stored, { tags: ['a1', 'b1'], musicArtist: true }))
  check('nothing stored and something new needs a write', channelTagsChanged(undefined, { tags: ['a1'], musicArtist: false }))
  check('nothing stored and only the flag needs a write', channelTagsChanged(null, { tags: [], musicArtist: true }))
  check('nothing stored and nothing new needs no write', !channelTagsChanged(undefined, { tags: [], musicArtist: false }))
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
