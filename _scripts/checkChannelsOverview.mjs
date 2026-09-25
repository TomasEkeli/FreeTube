/**
 * Checks the rules behind the Channels overview: which channels are
 * unassigned, how columns are ordered, and how the working set of open
 * columns behaves.
 *
 * The page only draws what these functions return, so a mistake here shows up
 * as a channel in the wrong column or missing from the pool, which is easy to
 * overlook among a few thousand of them.
 *
 * Run with `pnpm run check-channels-overview`.
 */

import {
  channelMemberships,
  MAX_OPEN_COLUMNS,
  nonPrimaryProfiles,
  restoreOpenProfiles,
  sortChannels,
  toggleOpenProfile,
  unassignedChannels,
  uniqueChannels,
} from '../src/renderer/helpers/channelsOverview.js'
import { MAIN_PROFILE_ID } from '../src/constants.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const channel = id => ({ id, name: `channel ${id}`, thumbnail: `https://yt3.googleusercontent.com/${id}=s176` })
const channels = (...ids) => ids.map(channel)
const ids = list => list.map(item => item.id ?? item._id).join(',')

function profile(_id, name, channelIds) {
  return { _id, name, bgColor: '#000000', textColor: '#FFFFFF', subscriptions: channels(...channelIds) }
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

// Unassigned pool
{
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b', 'c', 'd']),
    profile('p1', 'Gaming', ['a']),
    profile('p2', 'Science', ['c', 'a'])
  ]

  check('the pool is what no other profile has', ids(unassignedChannels(profiles)) === 'b,d')
  check('the primary profile is never a column', ids(nonPrimaryProfiles(profiles)) === 'p1,p2')

  const memberships = channelMemberships(profiles)
  check('memberships name every profile a channel is in', memberships.get('a').join(',') === 'p1,p2')
  check('memberships leave out the primary profile', !memberships.has('b'))
}

// An empty pool is empty, so the page can drop the column
{
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b']),
    profile('p1', 'Gaming', ['a', 'b'])
  ]

  check('everything filed leaves the pool empty', unassignedChannels(profiles).length === 0)
}

// Only a primary profile: everything is unassigned
{
  const profiles = [profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b'])]

  check('with no other profiles everything is unassigned', ids(unassignedChannels(profiles)) === 'a,b')
  check('no profile list gives no pool', unassignedChannels([]).length === 0)
}

// A channel stored twice in one profile is drawn once
{
  const twice = [...channels('a', 'b'), channel('a')]
  check('repeated entries are dropped', ids(uniqueChannels(twice)) === 'a,b')

  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'a', 'b']),
    profile('p1', 'Gaming', ['b', 'b'])
  ]
  check('a repeated entry is not a second membership', channelMemberships(profiles).get('b').length === 1)
  check('a repeated entry is one tile in the pool', ids(unassignedChannels(profiles)) === 'a')
}

// Alphabetical order, as nothing records when a channel was subscribed to
{
  const list = [
    { id: '1', name: 'banana' },
    { id: '2', name: 'Apple' },
    { id: '3', name: 'channel 10' },
    { id: '4', name: 'channel 9' },
    { id: '5' }
  ]
  const sorted = sortChannels(list, collator)

  check('names sort without regard to case', sorted[1].id === '2' && sorted[2].id === '1')
  check('numbers in names sort as numbers', sorted.findIndex(c => c.id === '4') < sorted.findIndex(c => c.id === '3'))
  check('a channel without a name sorts first instead of throwing', sorted[0].id === '5')
  check('sorting leaves the input alone', list[0].id === '1')
}

// Working set of open columns
{
  check('a closed column opens', toggleOpenProfile(['p1'], 'p2').join(',') === 'p1,p2')
  check('an open column closes', toggleOpenProfile(['p1', 'p2'], 'p1').join(',') === 'p2')

  const full = ['p1', 'p2', 'p3', 'p4']
  check('the working set tops out at the maximum', MAX_OPEN_COLUMNS === 4)
  check('opening one more closes the longest open', toggleOpenProfile(full, 'p5').join(',') === 'p2,p3,p4,p5')
}

// Restoring the working set from the stored setting
{
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', []),
    profile('p1', 'Gaming', []),
    profile('p2', 'Science', [])
  ]

  check('stored columns come back in order', restoreOpenProfiles(['p2', 'p1'], profiles).join(',') === 'p2,p1')
  check('a deleted profile does not come back', restoreOpenProfiles(['gone', 'p1'], profiles).join(',') === 'p1')
  check('the primary profile never comes back as a column', restoreOpenProfiles([MAIN_PROFILE_ID, 'p1'], profiles).join(',') === 'p1')
  check('a stored value that is not a list opens nothing', restoreOpenProfiles('p1', profiles).length === 0)
  check('a profile stored twice opens once', restoreOpenProfiles(['p1', 'p1'], profiles).join(',') === 'p1')
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
