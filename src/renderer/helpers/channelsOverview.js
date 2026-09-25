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
 * The open columns as stored, less any profile that no longer exists. A
 * profile deleted since the page was last open simply does not come back.
 * @param {unknown} storedIds
 * @param {Profile[]} profileList
 * @param {number} [max]
 * @returns {string[]}
 */
export function restoreOpenProfiles(storedIds, profileList, max = MAX_OPEN_COLUMNS) {
  if (!Array.isArray(storedIds)) { return [] }

  const existing = new Set(nonPrimaryProfiles(profileList).map(profile => profile._id))
  const restored = [...new Set(storedIds)].filter(id => existing.has(id))

  return restored.slice(Math.max(0, restored.length - max))
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

/**
 * @param {Channel} channel
 * @returns {Channel} a plain copy, safe to hand to the database
 */
function plainChannel(channel) {
  return { ...channel }
}

/**
 * What filing some channels into a profile, or back into the pool, does to
 * the profiles: the changed ones, as whole profiles ready to save, one per
 * profile however many channels it gains or loses.
 *
 * - Into a profile: each channel is added to it, unless it is there already.
 *   Moving also takes it out of the profile it was dragged from; copying
 *   leaves it there as well.
 * - Into the pool (`targetProfileId` null): each channel is taken out of the
 *   profile it was dragged from. It only turns up in the pool if no other
 *   profile has it either. Copying into the pool means nothing, so it moves.
 * - Dragged from the pool (`profileId` null): there is nothing to take it out
 *   of, so moving and copying both just add it.
 *
 * The primary profile is never changed here: it is every subscription, and
 * leaving it is unsubscribing, which is not what a drop onto a column means.
 * @param {Profile[]} profileList
 * @param {import('./channelDragAndDrop').DraggedChannel[]} dragged
 * @param {string | null} targetProfileId
 * @param {boolean} copy
 * @returns {Profile[]}
 */
export function planTransfer(profileList, dragged, targetProfileId, copy) {
  if (targetProfileId === MAIN_PROFILE_ID) { return [] }

  const byId = new Map(nonPrimaryProfiles(profileList).map(profile => [profile._id, profile]))

  if (targetProfileId !== null && !byId.has(targetProfileId)) { return [] }

  // Where a dragged channel's details come from: the primary profile has every
  // subscription, and the profile it was dragged from has it too otherwise
  const primary = primaryProfile(profileList)
  const knownChannels = new Map((primary?.subscriptions ?? []).map(channel => [channel.id, channel]))

  /** @type {Map<string, Set<string>>} */
  const removals = new Map()
  /** @type {Channel[]} */
  const additions = []
  const target = targetProfileId === null ? null : byId.get(targetProfileId)
  const inTarget = new Set(target?.subscriptions.map(channel => channel.id) ?? [])

  for (const { channelId, profileId: sourceId } of dragged) {
    const source = sourceId === null ? null : byId.get(sourceId)

    if (sourceId !== null && source === undefined) { continue }
    if (sourceId === targetProfileId) { continue }

    if (target !== null && !inTarget.has(channelId)) {
      const channel = knownChannels.get(channelId) ?? source?.subscriptions.find(channel => channel.id === channelId)

      if (channel === undefined) { continue }

      additions.push(plainChannel(channel))
      inTarget.add(channelId)
    }

    if (source !== null && (target === null || !copy)) {
      if (!removals.has(sourceId)) {
        removals.set(sourceId, new Set())
      }

      removals.get(sourceId).add(channelId)
    }
  }

  /** @type {Profile[]} */
  const updated = []

  for (const [profileId, channelIds] of removals) {
    const profile = byId.get(profileId)
    const subscriptions = profile.subscriptions.filter(channel => !channelIds.has(channel.id))

    if (subscriptions.length !== profile.subscriptions.length) {
      updated.push({ ...profile, subscriptions: subscriptions.map(plainChannel) })
    }
  }

  if (target !== null && additions.length > 0) {
    updated.push({ ...target, subscriptions: [...target.subscriptions.map(plainChannel), ...additions] })
  }

  return updated
}

/**
 * Selected channels, per column: the profile id, or null for the pool, to the
 * ids of the channels selected in it. Per column because the same channel can
 * be in two open columns, and selecting it in one is not selecting it in the
 * other. Never changed in place; every function here returns a new one.
 * @typedef {Map<string | null, Set<string>>} Selection
 */

/**
 * @param {Selection} selection
 * @param {string | null} profileId
 * @param {string} channelId
 * @returns {boolean}
 */
export function isSelected(selection, profileId, channelId) {
  return selection.get(profileId)?.has(channelId) ?? false
}

/**
 * @param {Selection} selection
 * @returns {number}
 */
export function selectionSize(selection) {
  let size = 0

  for (const channelIds of selection.values()) {
    size += channelIds.size
  }

  return size
}

/**
 * @param {Selection} selection
 * @param {string | null} profileId
 * @param {string} channelId
 * @returns {Selection}
 */
export function toggleSelected(selection, profileId, channelId) {
  const next = new Map(selection)
  const channelIds = new Set(selection.get(profileId))

  if (channelIds.has(channelId)) {
    channelIds.delete(channelId)
  } else {
    channelIds.add(channelId)
  }

  if (channelIds.size === 0) {
    next.delete(profileId)
  } else {
    next.set(profileId, channelIds)
  }

  return next
}

/**
 * Adds everything from one channel to an other in a column, both included, in
 * the order the column shows them. Either end missing from the column selects
 * nothing new.
 * @param {Selection} selection
 * @param {string | null} profileId
 * @param {string[]} orderedChannelIds the column as shown
 * @param {string} fromChannelId
 * @param {string} toChannelId
 * @returns {Selection}
 */
export function selectRange(selection, profileId, orderedChannelIds, fromChannelId, toChannelId) {
  const from = orderedChannelIds.indexOf(fromChannelId)
  const to = orderedChannelIds.indexOf(toChannelId)

  if (from === -1 || to === -1) { return selection }

  const next = new Map(selection)
  const channelIds = new Set(selection.get(profileId))

  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    channelIds.add(orderedChannelIds[i])
  }

  next.set(profileId, channelIds)

  return next
}

/**
 * Adds every channel of the given columns.
 * @param {Selection} selection
 * @param {Map<string | null, string[]>} columns
 * @returns {Selection}
 */
export function selectAll(selection, columns) {
  const next = new Map(selection)

  for (const [profileId, channelIds] of columns) {
    if (channelIds.length === 0) { continue }

    next.set(profileId, new Set([...(selection.get(profileId) ?? []), ...channelIds]))
  }

  return next
}

/**
 * Only what is in the given columns: a channel that has left its column, or
 * a column that has closed, is no longer selected.
 * @param {Selection} selection
 * @param {Map<string | null, Iterable<string>>} columns
 * @returns {Selection}
 */
export function pruneSelection(selection, columns) {
  /** @type {Selection} */
  const next = new Map()
  let changed = false

  for (const [profileId, channelIds] of selection) {
    const column = columns.get(profileId)

    if (column === undefined) {
      changed = true
      continue
    }

    const present = column instanceof Set ? column : new Set(column)
    const kept = new Set([...channelIds].filter(channelId => present.has(channelId)))

    if (kept.size !== channelIds.size) { changed = true }
    if (kept.size > 0) { next.set(profileId, kept) }
  }

  return changed ? next : selection
}

/**
 * The selection as a drag payload: every selected channel with its column.
 * @param {Selection} selection
 * @returns {import('./channelDragAndDrop').DraggedChannel[]}
 */
export function selectedChannels(selection) {
  const channels = []

  for (const [profileId, channelIds] of selection) {
    for (const channelId of channelIds) {
      channels.push({ channelId, profileId })
    }
  }

  return channels
}

/**
 * Where the selection is after a drop: moved channels are selected where they
 * landed, so a selection can be dragged on again. A copy leaves the selection
 * where it was, as the channels are still there too.
 * @param {Selection} selection
 * @param {import('./channelDragAndDrop').DraggedChannel[]} dragged
 * @param {string | null} targetProfileId
 * @param {boolean} copy
 * @returns {Selection}
 */
export function selectionAfterTransfer(selection, dragged, targetProfileId, copy) {
  if (copy && targetProfileId !== null) { return selection }

  let next = selection

  for (const { channelId, profileId } of dragged) {
    if (profileId === targetProfileId || !isSelected(next, profileId, channelId)) { continue }

    next = toggleSelected(next, profileId, channelId)

    if (!isSelected(next, targetProfileId, channelId)) {
      next = toggleSelected(next, targetProfileId, channelId)
    }
  }

  return next
}

/**
 * Unsubscribing from channels: for each, every profile it is in, the primary
 * one included. One removal per channel across all its profiles, the way the
 * subscribe button unsubscribes, so each goes out of every profile at once.
 * @param {Profile[]} profileList
 * @param {string[]} channelIds
 * @returns {{ channelId: string, profileIds: string[] }[]}
 */
export function planUnsubscribe(profileList, channelIds) {
  const removals = []

  for (const channelId of new Set(channelIds)) {
    const profileIds = profileList
      .filter(profile => profile.subscriptions.some(channel => channel.id === channelId))
      .map(profile => profile._id)

    if (profileIds.length > 0) {
      removals.push({ channelId, profileIds })
    }
  }

  return removals
}

/**
 * The search as typed, ready to match against: trimmed and lower case. Plain
 * text, nothing in it has a special meaning.
 * @param {string} query
 * @returns {string}
 */
export function normaliseQuery(query) {
  return query.trim().normalize('NFC').toLocaleLowerCase()
}

/**
 * The channels whose name has the search in it, in their order. No search
 * gives back the same list.
 * @param {Channel[]} channels
 * @param {string} query as normalised by `normaliseQuery`
 * @returns {Channel[]}
 */
export function filterChannels(channels, query) {
  if (query === '') { return channels }

  return channels.filter(channel => {
    return (channel.name ?? '').normalize('NFC').toLocaleLowerCase().includes(query)
  })
}

/**
 * How many callout colours there are to go round. Channels duplicated across
 * the open columns take them in turn, and start over once all are taken.
 */
export const CALLOUT_COLOUR_COUNT = 8

/**
 * Whether a channel is in more than one profile, the primary one aside.
 * @param {Map<string, string[]>} memberships from `channelMemberships`
 * @param {string} channelId
 * @returns {boolean}
 */
export function isDuplicate(memberships, channelId) {
  return (memberships.get(channelId)?.length ?? 0) > 1
}

/**
 * A profile's column order: channels in more than one profile first, so they
 * are hard to miss, then the rest; each part alphabetical.
 * @param {Channel[]} channels
 * @param {Map<string, string[]>} memberships
 * @param {Intl.Collator} collator
 * @returns {Channel[]} a new array
 */
export function sortColumn(channels, memberships, collator) {
  const sorted = sortChannels(channels, collator)

  return [
    ...sorted.filter(channel => isDuplicate(memberships, channel.id)),
    ...sorted.filter(channel => !isDuplicate(memberships, channel.id))
  ]
}

/**
 * Which callout colour each channel in two or more of the open columns gets,
 * by channel id, as an index below `CALLOUT_COLOUR_COUNT`. Only the open
 * columns count, so every colour on screen has its twin on screen too. The
 * colours go out in the order the channels are first met, reading the columns
 * left to right and each from the top.
 * @param {string[][]} openColumnChannelIds each open column's channel ids, in order
 * @param {number} [colourCount]
 * @returns {Map<string, number>}
 */
export function assignCalloutColours(openColumnChannelIds, colourCount = CALLOUT_COLOUR_COUNT) {
  /** @type {Map<string, number>} */
  const appearances = new Map()

  for (const channelIds of openColumnChannelIds) {
    for (const channelId of new Set(channelIds)) {
      appearances.set(channelId, (appearances.get(channelId) ?? 0) + 1)
    }
  }

  /** @type {Map<string, number>} */
  const colours = new Map()

  for (const channelIds of openColumnChannelIds) {
    for (const channelId of channelIds) {
      if (appearances.get(channelId) > 1 && !colours.has(channelId)) {
        colours.set(channelId, colours.size % colourCount)
      }
    }
  }

  return colours
}

/**
 * How many channels in each profile are in some other profile as well, by
 * profile id. The primary profile is left out.
 * @param {Profile[]} profileList
 * @param {Map<string, string[]>} [memberships]
 * @returns {Map<string, number>}
 */
export function duplicateCounts(profileList, memberships = channelMemberships(profileList)) {
  /** @type {Map<string, number>} */
  const counts = new Map(nonPrimaryProfiles(profileList).map(profile => [profile._id, 0]))

  for (const profileIds of memberships.values()) {
    if (profileIds.length < 2) { continue }

    for (const profileId of profileIds) {
      counts.set(profileId, counts.get(profileId) + 1)
    }
  }

  return counts
}

/**
 * The profiles to take a channel out of to leave it only in its home profile
 * (and the primary one, which has every subscription).
 * @param {Map<string, string[]>} memberships
 * @param {string} channelId
 * @param {string} homeProfileId
 * @returns {string[]}
 */
export function profilesOutsideHome(memberships, channelId, homeProfileId) {
  return (memberships.get(channelId) ?? []).filter(profileId => profileId !== homeProfileId)
}
