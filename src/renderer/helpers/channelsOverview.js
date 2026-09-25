/**
 * What the Channels overview shows, worked out from the profile list alone.
 *
 * Nothing in here touches the store or the database: the page hands in the
 * profile list as the store has it and gets back what to draw, or what to
 * write. That keeps the rules checkable without a window, in
 * `_scripts/checkChannelsOverview.mjs`.
 *
 * The overview never shows the primary profile as a column. It is every
 * subscription, so a column of it would be the whole list again. What it
 * shows instead is the unassigned pool: the channels in the primary profile
 * and in no other.
 */

import { MAIN_PROFILE_ID } from '../../constants.js'

/**
 * @typedef {object} Channel
 * @property {string} id
 * @property {string} [name]
 * @property {string} [thumbnail]
 */

/**
 * @typedef {object} Profile
 * @property {string} _id
 * @property {string} name
 * @property {string} bgColor
 * @property {string} textColor
 * @property {Channel[]} subscriptions
 */

/** How many profile columns can be open at once. */
export const MAX_OPEN_COLUMNS = 4

/**
 * @param {Profile[]} profileList
 * @returns {Profile | undefined}
 */
export function primaryProfile(profileList) {
  return profileList.find(profile => profile._id === MAIN_PROFILE_ID)
}

/**
 * Every profile a channel can be filed into, in the store's order.
 * @param {Profile[]} profileList
 * @returns {Profile[]}
 */
export function nonPrimaryProfiles(profileList) {
  return profileList.filter(profile => profile._id !== MAIN_PROFILE_ID)
}

/**
 * A profile's channels with any repeated entry dropped. The database has been
 * known to hold the same channel twice in one profile, and a column keyed on
 * the channel id cannot draw it twice.
 * @param {Channel[]} channels
 * @returns {Channel[]}
 */
export function uniqueChannels(channels) {
  const seen = new Set()
  const unique = []

  for (const channel of channels) {
    if (seen.has(channel.id)) { continue }

    seen.add(channel.id)
    unique.push(channel)
  }

  return unique
}

/**
 * Which non-primary profiles each channel belongs to, by channel id.
 * A channel in none of them has no entry.
 * @param {Profile[]} profileList
 * @returns {Map<string, string[]>}
 */
export function channelMemberships(profileList) {
  /** @type {Map<string, string[]>} */
  const memberships = new Map()

  for (const profile of nonPrimaryProfiles(profileList)) {
    const seen = new Set()

    for (const channel of profile.subscriptions) {
      if (seen.has(channel.id)) { continue }
      seen.add(channel.id)

      const profileIds = memberships.get(channel.id)

      if (profileIds) {
        profileIds.push(profile._id)
      } else {
        memberships.set(channel.id, [profile._id])
      }
    }
  }

  return memberships
}

/**
 * The channels in the primary profile that no other profile has claimed.
 * @param {Profile[]} profileList
 * @param {Map<string, string[]>} [memberships] reused when the caller already has it
 * @returns {Channel[]}
 */
export function unassignedChannels(profileList, memberships = channelMemberships(profileList)) {
  const primary = primaryProfile(profileList)

  if (!primary) { return [] }

  return uniqueChannels(primary.subscriptions).filter(channel => !memberships.has(channel.id))
}

/**
 * Alphabetical by name, as there is nothing else to order by: no profile
 * records when a channel was subscribed to.
 * @param {Channel[]} channels
 * @param {Intl.Collator} collator
 * @returns {Channel[]} a new array
 */
export function sortChannels(channels, collator) {
  return channels.slice().sort((a, b) => collator.compare(a.name ?? '', b.name ?? ''))
}

/**
 * Opens a closed column or closes an open one. Opening a column when the
 * working set is full closes the one that has been open longest, so the
 * newest choice always lands.
 * @param {string[]} openProfileIds in the order they were opened
 * @param {string} profileId
 * @param {number} [max]
 * @returns {string[]} a new array
 */
export function toggleOpenProfile(openProfileIds, profileId, max = MAX_OPEN_COLUMNS) {
  if (openProfileIds.includes(profileId)) {
    return openProfileIds.filter(id => id !== profileId)
  }

  const opened = [...openProfileIds, profileId]

  return opened.slice(Math.max(0, opened.length - max))
}
