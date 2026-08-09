/**
 * Checks how the recovery splits failed channels into groups.
 *
 * The grouping decides how much is asked for at once after a refresh has
 * already been refused, so getting it wrong means either asking for the same
 * batch that just failed, or forgetting channels entirely. Neither announces
 * itself: the feed simply stays incomplete.
 *
 * Run with `pnpm run check-subscription-recovery-groups`.
 */

import { buildRecoveryGroups } from '../src/renderer/helpers/subscriptionRecoveryGroups.js'
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

const channel = id => ({ id, name: `channel ${id}` })
const channels = (...ids) => ids.map(channel)

function profile(_id, name, ids) {
  return { _id, name, subscriptions: channels(...ids) }
}

// Grouped by profile, in the order the profiles are listed
{
  const failed = channels('a', 'b', 'c', 'd')
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b', 'c', 'd']),
    profile('p1', 'Gaming', ['a', 'b']),
    profile('p2', 'Science', ['c'])
  ]

  const groups = buildRecoveryGroups(failed, profiles)

  check('one group per profile plus the leftovers', groups.length === 3)
  check('first group is the first profile', groups[0].label === 'Gaming' && groups[0].channels.length === 2)
  check('second group is the second profile', groups[1].label === 'Science' && groups[1].channels.length === 1)
  check('channels in no sub-profile form a trailing group', groups[2].label === null && groups[2].channels[0].id === 'd')
}

// The main profile never forms a group of its own, or it would be the whole lot
{
  const failed = channels('a', 'b')
  const groups = buildRecoveryGroups(failed, [profile(MAIN_PROFILE_ID, 'All Channels', ['a', 'b'])])

  check('main profile does not claim channels', groups.length === 1 && groups[0].label === null)
  check('everything still ends up in a group', groups[0].channels.length === 2)
}

// A channel in two profiles is recovered once, by the first to claim it
{
  const failed = channels('a')
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', ['a']),
    profile('p1', 'First', ['a']),
    profile('p2', 'Second', ['a'])
  ]

  const groups = buildRecoveryGroups(failed, profiles)
  const total = groups.reduce((sum, group) => sum + group.channels.length, 0)

  check('a channel in two profiles appears once', total === 1)
  check('the first profile to claim it keeps it', groups[0].label === 'First')
}

// Nothing is ever dropped, whatever the shape
{
  const failed = channels(...Array.from({ length: 137 }, (_, i) => `c${i}`))
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', failed.map(c => c.id)),
    profile('p1', 'Big', failed.slice(0, 90).map(c => c.id)),
    profile('p2', 'Small', failed.slice(90, 95).map(c => c.id))
  ]

  const groups = buildRecoveryGroups(failed, profiles)
  const seen = new Set(groups.flatMap(group => group.channels.map(c => c.id)))

  check(`every channel appears exactly once (${seen.size} of 137)`, seen.size === 137)
  check(
    'no group is larger than a step down from the refresh',
    groups.every(group => group.channels.length <= 25)
  )
  check('an oversized profile is split rather than sent whole', groups.filter(g => g.label === 'Big').length === 4)
}

// Viewing a single profile: grouping alone would rebuild the batch that just
// failed, so the size cap has to do the work
{
  const failed = channels(...Array.from({ length: 60 }, (_, i) => `c${i}`))
  const profiles = [
    profile(MAIN_PROFILE_ID, 'All Channels', failed.map(c => c.id)),
    profile('p1', 'Only', failed.map(c => c.id))
  ]

  const groups = buildRecoveryGroups(failed, profiles)

  check('a single large profile is still broken up', groups.length === 3)
  check('and still holds everything', groups.reduce((n, g) => n + g.channels.length, 0) === 60)
}

// Degenerate input
{
  const build = buildRecoveryGroups

  check('no channels means no groups', build([], [profile(MAIN_PROFILE_ID, 'All', [])]).length === 0)
  check('no profiles still recovers everything', build(channels('a'), []).length === 1)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
