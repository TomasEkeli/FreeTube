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
 * @returns {string[]}
 */
export function restoreOpenProfiles(storedIds, profileList) {
  if (!Array.isArray(storedIds)) { return [] }

  const existing = new Set(nonPrimaryProfiles(profileList).map(profile => profile._id))

  return [...new Set(storedIds)].filter(id => existing.has(id))
}

/**
 * Opens a closed column or closes an open one. As many can be
 * open as the reader likes; the page scrolls sideways once they do not fit.
 * @param {string[]} openProfileIds in the order they were opened
 * @param {string} profileId
 * @returns {string[]} a new array
 */
export function toggleOpenProfile(openProfileIds, profileId) {
  if (openProfileIds.includes(profileId)) {
    return openProfileIds.filter(id => id !== profileId)
  }

  return [...openProfileIds, profileId]
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
 * Unsubscribing from channels: out of every profile any of them is in, the
 * primary one included, as one removal. One write for the lot, however many
 * channels: taken out one at a time, each channel would rewrite every profile
 * it leaves.
 * @param {Profile[]} profileList
 * @param {string[]} channelIds
 * @returns {{ channelIds: string[], profileIds: string[] } | null} null when none of them is subscribed to
 */
export function planUnsubscribe(profileList, channelIds) {
  const wanted = new Set(channelIds)
  const found = new Set()
  const profileIds = []

  for (const profile of profileList) {
    let inProfile = false

    for (const channel of profile.subscriptions) {
      if (wanted.has(channel.id)) {
        found.add(channel.id)
        inProfile = true
      }
    }

    if (inProfile) {
      profileIds.push(profile._id)
    }
  }

  if (found.size === 0) { return null }

  return { channelIds: [...found], profileIds }
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

/**
 * How many channels a planned transfer actually files: those it adds to the
 * target, and for a move also those it only takes out of where they were
 * dragged from, as a channel already in the target does.
 * @param {Profile[]} profileList before the transfer
 * @param {Profile[]} updated what `planTransfer` returned
 * @param {string | null} targetProfileId
 * @returns {number}
 */
export function countTransferred(profileList, updated, targetProfileId) {
  const byId = new Map(profileList.map(profile => [profile._id, profile]))
  const transferred = new Set()

  for (const profile of updated) {
    const before = new Set(byId.get(profile._id)?.subscriptions.map(channel => channel.id) ?? [])
    const after = new Set(profile.subscriptions.map(channel => channel.id))

    if (profile._id === targetProfileId) {
      for (const channelId of after) {
        if (!before.has(channelId)) { transferred.add(channelId) }
      }
    } else {
      for (const channelId of before) {
        if (!after.has(channelId)) { transferred.add(channelId) }
      }
    }
  }

  return transferred.size
}

/**
 * Takes every channel of the given columns out of the selection.
 * @param {Selection} selection
 * @param {Map<string | null, string[]>} columns
 * @returns {Selection}
 */
export function deselectAll(selection, columns) {
  const next = new Map(selection)

  for (const [profileId, channelIds] of columns) {
    const selected = selection.get(profileId)

    if (!selected) { continue }

    const kept = new Set(selected)

    for (const channelId of channelIds) {
      kept.delete(channelId)
    }

    if (kept.size === 0) {
      next.delete(profileId)
    } else {
      next.set(profileId, kept)
    }
  }

  return next
}

/**
 * Profiles in the user's own order: the primary profile first, then those the
 * stored order names, as it names them, then any it does not name,
 * alphabetically. An empty order is therefore plain alphabetical order, which
 * is what every list of profiles showed before there was an order to keep.
 * The order is a setting, and trusted for nothing: a deleted profile in it is
 * skipped, a repeated one counts at its first place.
 * @param {Profile[]} profileList
 * @param {unknown} order
 * @param {Intl.Collator} collator
 * @returns {Profile[]} a new array
 */
export function orderProfiles(profileList, order, collator) {
  const byId = new Map(profileList.map(profile => [profile._id, profile]))
  const placed = new Set([MAIN_PROFILE_ID])
  const ordered = byId.has(MAIN_PROFILE_ID) ? [byId.get(MAIN_PROFILE_ID)] : []

  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id !== 'string' || placed.has(id) || !byId.has(id)) { continue }

      placed.add(id)
      ordered.push(byId.get(id))
    }
  }

  const rest = profileList
    .filter(profile => !placed.has(profile._id))
    .sort((a, b) => collator.compare((a.name ?? '').normalize('NFC'), (b.name ?? '').normalize('NFC')))

  return [...ordered, ...rest]
}

/**
 * The order as it is stored: every profile but the primary one.
 * @param {Profile[]} profileList in order
 * @returns {string[]}
 */
export function profileOrderIds(profileList) {
  return nonPrimaryProfiles(profileList).map(profile => profile._id)
}

/**
 * The order to store once a profile is created: every profile as it is shown
 * now, then the new one. Written out in full, as appending to the stored order
 * alone would put the new profile ahead of every profile it does not name yet.
 * @param {Profile[]} orderedProfiles as the store's getProfileList has them
 * @param {string} newProfileId
 * @returns {string[]}
 */
export function appendToOrder(orderedProfiles, newProfileId) {
  return [...profileOrderIds(orderedProfiles).filter(id => id !== newProfileId), newProfileId]
}

/**
 * @param {string[]} orderedIds
 * @param {string} id
 * @param {number} toIndex its place in the list without it
 * @returns {string[]} a new array, or `orderedIds` itself when nothing moves,
 * so that a caller can tell there is nothing to save
 */
export function moveInOrder(orderedIds, id, toIndex) {
  const from = orderedIds.indexOf(id)

  if (from === -1) { return orderedIds }

  const rest = orderedIds.filter(other => other !== id)
  const to = Math.max(0, Math.min(toIndex, rest.length))

  if (to === from) { return orderedIds }

  return [...rest.slice(0, to), id, ...rest.slice(to)]
}

/**
 * A colour for a new profile that no profile has yet, the primary one
 * included, as its colour is shown in the top bar. Compared without regard to
 * case, as the colour picker and the list of colours write hex differently.
 * Any of the colours once every one is taken.
 * @param {string[]} colourValues
 * @param {Profile[]} profileList
 * @param {() => number} [random]
 * @returns {string}
 */
export function pickUnusedColour(colourValues, profileList, random = Math.random) {
  const used = new Set(profileList.map(profile => profile.bgColor?.toLowerCase()))
  const unused = colourValues.filter(colour => !used.has(colour.toLowerCase()))
  const choices = unused.length > 0 ? unused : colourValues

  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]
}

/**
 * Where a bubble dragged along the palette would land: the index of the bubble
 * it would go in front of, or the number of bubbles for after the last. The
 * strip wraps, so the row comes first: the first whose bottom is below the
 * pointer, or the last. Within it, in front of the first bubble whose middle
 * is past the pointer, in the reading direction.
 * @param {{ left: number, right: number, top: number, bottom: number }[]} rects the bubbles', in order
 * @param {{ x: number, y: number }} point
 * @param {boolean} rtl
 * @returns {number}
 */
export function insertionIndex(rects, point, rtl) {
  if (rects.length === 0) { return 0 }

  const rows = []

  rects.forEach((rect, index) => {
    const row = rows[rows.length - 1]

    if (row && Math.abs(row.top - rect.top) < 1) {
      row.end = index
      row.bottom = Math.max(row.bottom, rect.bottom)
    } else {
      rows.push({ start: index, end: index, top: rect.top, bottom: rect.bottom })
    }
  })

  const row = rows.find(candidate => point.y < candidate.bottom) ?? rows[rows.length - 1]

  for (let i = row.start; i <= row.end; i++) {
    const middle = (rects[i].left + rects[i].right) / 2

    if (rtl ? point.x > middle : point.x < middle) { return i }
  }

  return row.end + 1
}

/**
 * A drop's insertion index as a place in the order without the dragged
 * profile, which is what moveInOrder takes: in front of a later bubble is one
 * place earlier once the dragged one is out of the way.
 * @param {number} fromIndex
 * @param {number} insertion
 * @returns {number}
 */
export function moveTarget(fromIndex, insertion) {
  return insertion > fromIndex ? insertion - 1 : insertion
}
