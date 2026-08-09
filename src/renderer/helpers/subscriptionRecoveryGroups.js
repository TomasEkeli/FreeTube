import { MAIN_PROFILE_ID } from '../../constants.js'

/**
 * Deciding how much to ask for at once when going back for the channels a
 * refresh could not reach.
 *
 * Kept apart from the recovery itself, and free of the store, so that the seams
 * it produces can be checked directly. Getting this wrong does not announce
 * itself: either the same batch that just failed is sent again, or channels are
 * quietly dropped and the feed simply stays incomplete.
 */

/** At most this many channels in one group before it is split further. */
export const RECOVERY_GROUP_SIZE = 25

/**
 * Split the channels a refresh could not reach into the profiles they belong
 * to, in the order the profiles are listed, with the first profile to claim a
 * channel keeping it.
 *
 * Grouping by profile is not a technical necessity, since YouTube has no notion
 * of them: this is "smaller batches, spaced out", with profiles deciding where
 * the seams go. It is worth doing that way because partial progress then means
 * something to the person waiting, whose profiles are how they think about
 * their subscriptions in the first place.
 *
 * The main profile never claims anything, or it would take everything and leave
 * one group the size of the refresh. Channels belonging to no other profile
 * form the last group instead.
 *
 * Any group too large to be a step down from the refresh is split further. That
 * also covers viewing a single profile, where every unresolved channel is in
 * that one profile and grouping alone would rebuild the batch that just failed.
 *
 * @param {{ id: string }[]} channels
 * @param {{ _id: string, name: string, subscriptions: { id: string }[] }[]} profiles
 * @returns {{ label: string | null, channels: object[] }[]}
 */
export function buildRecoveryGroups(channels, profiles) {
  const remaining = new Map(channels.map(channel => [channel.id, channel]))
  const groups = []

  for (const profile of profiles) {
    if (profile._id === MAIN_PROFILE_ID) { continue }

    const claimed = []

    for (const subscription of profile.subscriptions) {
      const channel = remaining.get(subscription.id)

      if (channel != null) {
        claimed.push(channel)
        remaining.delete(subscription.id)
      }
    }

    if (claimed.length > 0) {
      groups.push({ label: profile.name, channels: claimed })
    }
  }

  if (remaining.size > 0) {
    groups.push({ label: null, channels: Array.from(remaining.values()) })
  }

  return groups.flatMap(({ label, channels: groupChannels }) => {
    if (groupChannels.length <= RECOVERY_GROUP_SIZE) {
      return [{ label, channels: groupChannels }]
    }

    const split = []

    for (let i = 0; i < groupChannels.length; i += RECOVERY_GROUP_SIZE) {
      split.push({ label, channels: groupChannels.slice(i, i + RECOVERY_GROUP_SIZE) })
    }

    return split
  })
}
