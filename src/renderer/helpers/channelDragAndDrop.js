/**
 * Dragging channels between profiles on the Channels page.
 *
 * Plain HTML5 drag and drop, like the playlist reordering in dragAndDrop.js,
 * but carrying what that one cannot: any number of channels, each with the
 * profile it is being dragged out of. The same channel can be in two open
 * columns, and moving it out of one must leave the other alone, so the
 * channel id alone does not say what to do.
 *
 * The payload travels in the drag data under a type of its own, which also
 * tells a drop target that the drag is one of ours: while a drag is over a
 * target the browser shows the types but withholds the data.
 */

/** @typedef {{ channelId: string, profileId: string | null }} DraggedChannel */

/** Custom drag data types are lower case in Chromium whatever they were set as. */
export const CHANNEL_DRAG_TYPE = 'application/x-freetube-channels'

/**
 * @param {DragEvent} event
 * @param {DraggedChannel[]} channels `profileId` is null for the unassigned pool
 * @param {string} label shown by anything the channels are dropped on outside the app
 */
export function startChannelDrag(event, channels, label) {
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(CHANNEL_DRAG_TYPE, JSON.stringify({ channels }))
  // Allows drag and drop to work with touch devices, and gives a drop outside
  // the app something to show
  event.dataTransfer.setData('text/plain', label)
}

/**
 * Whether a drag is carrying channels. Usable during dragenter and dragover,
 * when the data itself cannot be read yet.
 * @param {DragEvent} event
 * @returns {boolean}
 */
export function isChannelDrag(event) {
  return event.dataTransfer?.types.includes(CHANNEL_DRAG_TYPE) ?? false
}

/**
 * The channels a drop carries, or an empty list for a drop that is not ours
 * or carries something malformed.
 * @param {DragEvent} event
 * @returns {DraggedChannel[]}
 */
export function readChannelDrag(event) {
  const raw = event.dataTransfer?.getData(CHANNEL_DRAG_TYPE)

  if (!raw) { return [] }

  try {
    const { channels } = JSON.parse(raw)

    if (!Array.isArray(channels)) { return [] }

    return channels.filter(channel => {
      return typeof channel?.channelId === 'string' &&
        (channel.profileId === null || typeof channel.profileId === 'string')
    })
  } catch {
    return []
  }
}

/**
 * Whether a drop copies instead of moving. Ctrl is the copy modifier on
 * Windows and Linux; on macOS it is Option, and Ctrl-click is a right click.
 * @param {DragEvent} event
 * @returns {boolean}
 */
export function isCopyDrop(event) {
  if (process.platform === 'darwin') {
    return event.altKey
  }

  return event.ctrlKey
}

/**
 * Lets a drag of channels drop here, with the cursor saying whether it will
 * move or copy. Call from dragover; anything else dragged over is left alone
 * and so cannot be dropped.
 * @param {DragEvent} event
 * @param {boolean} [canCopy] false for a target where a copy means nothing
 * @returns {boolean} whether the drag is one of ours
 */
export function acceptChannelDrag(event, canCopy = true) {
  if (!isChannelDrag(event)) { return false }

  event.preventDefault()
  event.dataTransfer.dropEffect = canCopy && isCopyDrop(event) ? 'copy' : 'move'

  return true
}
