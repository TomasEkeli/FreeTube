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
  isSelected,
  MAX_OPEN_COLUMNS,
  nonPrimaryProfiles,
  planTransfer,
  pruneSelection,
  restoreOpenProfiles,
  selectAll,
  selectedChannels,
  selectionAfterTransfer,
  selectionSize,
  selectRange,
  sortChannels,
  toggleOpenProfile,
  toggleSelected,
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

// Filing channels by dropping them
{
  const profiles = () => [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b', 'c', 'd']),
    profile('p1', 'Gaming', ['a', 'b']),
    profile('p2', 'Science', ['c'])
  ]
  const subs = (updated, id) => ids(updated.find(p => p._id === id)?.subscriptions ?? [])
  const touched = updated => updated.map(p => p._id).sort().join(',')

  const moved = planTransfer(profiles(), [{ channelId: 'a', profileId: 'p1' }], 'p2', false)
  check('a move takes the channel out of its column', subs(moved, 'p1') === 'b')
  check('a move puts the channel in the target', subs(moved, 'p2') === 'c,a')
  check('a move changes only the two profiles', touched(moved) === 'p1,p2')

  const copied = planTransfer(profiles(), [{ channelId: 'a', profileId: 'p1' }], 'p2', true)
  check('a copy leaves the source alone', touched(copied) === 'p2' && subs(copied, 'p2') === 'c,a')

  const fromPool = planTransfer(profiles(), [{ channelId: 'd', profileId: null }], 'p1', false)
  check('from the pool the channel is added', touched(fromPool) === 'p1' && subs(fromPool, 'p1') === 'a,b,d')
  check('the added channel keeps its details', fromPool[0].subscriptions[2].name === 'channel d' && fromPool[0].subscriptions[2].thumbnail.includes('/d='))

  const toPool = planTransfer(profiles(), [{ channelId: 'a', profileId: 'p1' }], null, false)
  check('into the pool the channel leaves its profile', touched(toPool) === 'p1' && subs(toPool, 'p1') === 'b')
  const copyToPool = planTransfer(profiles(), [{ channelId: 'a', profileId: 'p1' }], null, true)
  check('copying into the pool still takes it out', subs(copyToPool, 'p1') === 'b')

  const already = planTransfer(profiles(), [{ channelId: 'd', profileId: null }, { channelId: 'a', profileId: null }], 'p1', false)
  check('a channel already in the target is not added twice', subs(already, 'p1') === 'a,b,d')

  const alreadyMove = planTransfer([
    profile(MAIN_PROFILE_ID, 'All Channels', ['a']),
    profile('p1', 'Gaming', ['a']),
    profile('p2', 'Science', ['a'])
  ], [{ channelId: 'a', profileId: 'p1' }], 'p2', false)
  check('moving onto a column that has it already leaves one copy', touched(alreadyMove) === 'p1' && subs(alreadyMove, 'p1') === '')

  check('dropping on its own column changes nothing', planTransfer(profiles(), [{ channelId: 'a', profileId: 'p1' }], 'p1', false).length === 0)
  check('the pool onto the pool changes nothing', planTransfer(profiles(), [{ channelId: 'd', profileId: null }], null, false).length === 0)
  check('the primary profile is never a target', planTransfer(profiles(), [{ channelId: 'd', profileId: null }], MAIN_PROFILE_ID, false).length === 0)
  check('a deleted target changes nothing', planTransfer(profiles(), [{ channelId: 'd', profileId: null }], 'gone', false).length === 0)
  check('a channel from a deleted profile is skipped', planTransfer(profiles(), [{ channelId: 'a', profileId: 'gone' }], 'p2', false).length === 0)

  // Many channels from many columns land as one update per profile
  const many = planTransfer(profiles(), [
    { channelId: 'a', profileId: 'p1' },
    { channelId: 'b', profileId: 'p1' },
    { channelId: 'c', profileId: 'p2' },
    { channelId: 'd', profileId: null }
  ], 'p2', false)
  check('a mixed drop updates each profile once', many.length === 2 && touched(many) === 'p1,p2')
  check('a mixed drop moves everything across', subs(many, 'p2') === 'c,a,b,d' && subs(many, 'p1') === '')

  const original = profiles()
  planTransfer(original, [{ channelId: 'a', profileId: 'p1' }], 'p2', false)
  check('planning leaves the profile list alone', ids(original[1].subscriptions) === 'a,b' && ids(original[2].subscriptions) === 'c')
}

// Selection
{
  const empty = new Map()
  const listed = selection => selectedChannels(selection).map(c => `${c.profileId ?? 'pool'}:${c.channelId}`).sort().join(',')

  const one = toggleSelected(empty, 'p1', 'a')
  check('a click selects', isSelected(one, 'p1', 'a') && selectionSize(one) === 1)
  check('selecting leaves the old selection alone', selectionSize(empty) === 0)
  check('a second click deselects', selectionSize(toggleSelected(one, 'p1', 'a')) === 0)
  check('the same channel in an other column is separate', !isSelected(one, 'p2', 'a'))
  check('the pool is a column of its own', isSelected(toggleSelected(empty, null, 'a'), null, 'a'))

  const order = ['a', 'b', 'c', 'd', 'e']
  const range = selectRange(one, 'p1', order, 'a', 'c')
  check('a range selects both ends and between', listed(range) === 'p1:a,p1:b,p1:c')
  check('a range works upwards too', listed(selectRange(empty, 'p1', order, 'd', 'b')) === 'p1:b,p1:c,p1:d')
  check('a range adds to what is selected', listed(selectRange(toggleSelected(empty, 'p2', 'x'), 'p1', order, 'a', 'b')) === 'p1:a,p1:b,p2:x')
  check('a range with a missing end selects nothing', selectRange(empty, 'p1', order, 'zz', 'b') === empty)

  const all = selectAll(one, new Map([['p1', ['b']], [null, ['c', 'd']], ['p2', []]]))
  check('select all adds every channel of the columns', listed(all) === 'p1:a,p1:b,pool:c,pool:d')

  const pruned = pruneSelection(all, new Map([['p1', ['a']], [null, new Set(['c', 'd'])]]))
  check('a channel gone from its column is deselected', listed(pruned) === 'p1:a,pool:c,pool:d')
  check('a closed column loses its selection', listed(pruneSelection(all, new Map([[null, ['c', 'd']]]))) === 'pool:c,pool:d')
  check('pruning nothing returns the same selection', pruneSelection(one, new Map([['p1', ['a']]])) === one)

  const two = toggleSelected(toggleSelected(empty, 'p1', 'a'), null, 'b')
  const dragged = selectedChannels(two)
  check('moved channels are selected where they landed', listed(selectionAfterTransfer(two, dragged, 'p2', false)) === 'p2:a,p2:b')
  check('copied channels stay selected where they were', listed(selectionAfterTransfer(two, dragged, 'p2', true)) === 'p1:a,pool:b')
  check('channels dropped on the pool are selected there', listed(selectionAfterTransfer(two, dragged, null, false)) === 'pool:a,pool:b')
  check('a drag of one unselected tile leaves the selection alone',
    listed(selectionAfterTransfer(two, [{ channelId: 'z', profileId: 'p1' }], 'p2', false)) === 'p1:a,pool:b')
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
