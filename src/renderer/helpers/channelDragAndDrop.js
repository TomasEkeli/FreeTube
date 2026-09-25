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
 * @param {string} label shown by anything the channels are dropped on outside the app,
 *   and on the picture of the drag when it carries more than one
 */
export function startChannelDrag(event, channels, label) {
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(CHANNEL_DRAG_TYPE, JSON.stringify({ channels }))
  // Allows drag and drop to work with touch devices, and gives a drop outside
  // the app something to show
  event.dataTransfer.setData('text/plain', label)

  const source = event.target instanceof Element ? event.target.closest('[data-channel-id]') ?? event.target : null

  if (source instanceof HTMLElement) {
    startDragPicture(event, source, channels.length > 1 ? label : null)
  }
}

/**
 * The picture that follows the pointer during a drag is drawn by the page,
 * not left to the browser. The browser's is only let go of once the drop has
 * been dealt with and the system has played its own ending to the drag, which
 * on some desktops leaves it hanging over the drop for up to a second. The
 * page's goes the moment the drop lands. It is a copy of the channel's
 * square, and for a selection it carries a badge with the count, as the
 * square alone is one of however many are going.
 *
 * The browser still gets a picture, an empty one, as without one it draws
 * its own of the square.
 * @param {DragEvent} event
 * @param {HTMLElement} source
 * @param {string | null} badgeLabel
 */
function startDragPicture(event, source, badgeLabel) {
  const empty = document.createElement('div')
  Object.assign(empty.style, { position: 'fixed', top: '-10px', left: '-10px', width: '1px', height: '1px', opacity: '0' })
  document.body.appendChild(empty)
  event.dataTransfer.setDragImage(empty, 0, 0)
  // The browser takes its picture of the element as the drag starts
  setTimeout(() => empty.remove(), 0)

  const rect = source.getBoundingClientRect()
  const grabX = event.clientX - rect.left
  const grabY = event.clientY - rect.top

  const picture = document.createElement('div')
  Object.assign(picture.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '1000',
    pointerEvents: 'none',
    opacity: '0.9',
    willChange: 'transform',
    transform: `translate(${rect.left}px, ${rect.top}px)`
  })

  const copy = source.cloneNode(true)
  copy.removeAttribute('data-channel-id')
  copy.classList.remove('dragging', 'selected')
  copy.querySelectorAll('.selectedMark, .corner').forEach(el => el.remove())
  Object.assign(copy.style, {
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    backgroundColor: 'var(--card-bg-color)',
    boxShadow: '0 4px 14px rgb(0 0 0 / 35%)',
    borderRadius: '8px'
  })
  picture.appendChild(copy)

  if (badgeLabel !== null) {
    const badge = document.createElement('div')
    badge.textContent = badgeLabel
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-10px',
      right: '-10px',
      padding: '4px 10px',
      borderRadius: '12px',
      background: 'var(--primary-color)',
      color: 'var(--text-with-main-color)',
      font: 'bold 13px sans-serif',
      whiteSpace: 'nowrap',
      boxShadow: '0 1px 3px rgb(0 0 0 / 40%)'
    })
    picture.appendChild(badge)
  }

  const page = document.querySelector('.app') ?? document.body
  page.appendChild(picture)

  /** @param {DragEvent} moveEvent */
  const follow = (moveEvent) => {
    // Chromium reports 0, 0 for the last events of a drag leaving the window
    if (moveEvent.clientX === 0 && moveEvent.clientY === 0) { return }

    picture.style.transform = `translate(${moveEvent.clientX - grabX}px, ${moveEvent.clientY - grabY}px)`
    picture.style.visibility = 'visible'
  }

  /** @param {DragEvent} leaveEvent */
  const hideOutside = (leaveEvent) => {
    // Leaving the window, not moving from one element on to the next
    if (leaveEvent.relatedTarget === null) {
      picture.style.visibility = 'hidden'
    }
  }

  const end = () => {
    picture.remove()
    document.removeEventListener('dragover', follow, true)
    document.removeEventListener('dragleave', hideOutside, true)
    document.removeEventListener('drop', end, true)
    source.removeEventListener('dragend', end)
  }

  document.addEventListener('dragover', follow, true)
  document.addEventListener('dragleave', hideOutside, true)
  // Before any drop target has done anything, so the picture is gone at once
  document.addEventListener('drop', end, true)
  // A drag given up, or dropped where nothing takes it. On the square itself,
  // as it may no longer be in the page by then, and then the event goes no
  // further.
  source.addEventListener('dragend', end)
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
