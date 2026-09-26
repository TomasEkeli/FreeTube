import { computed, onBeforeUnmount, onMounted } from 'vue'

/**
 * Something put over the Channels page next to what opened it: a menu under a
 * button or where a channel was right-clicked, the colour grid next to a
 * bubble. Placed against the window, as a column clips whatever sticks out of
 * it, and so closed by anything that would leave it behind: a scroll under it,
 * the window resizing, a click outside it.
 *
 * @param {object} options
 * @param {import('vue').Ref<HTMLElement | null>} options.element
 * @param {() => ({ rect: DOMRect } | { x: number, y: number })} options.anchor
 * @param {() => HTMLElement | null} [options.owner] clicks on it are not outside: the button that opens it
 * @param {() => number} options.height how tall it expects to be
 * @param {() => number} [options.width] how wide it expects to be
 * @param {() => void} options.onClose
 */
export function useAnchoredOverlay({ element, anchor, owner = () => null, height, width = () => 240, onClose }) {
  /**
   * Below the anchor, or above it where there is no room below; lined up with
   * whichever side leaves it inside the window. Physical sides, as the
   * anchor's position is measured in them.
   */
  const position = computed(() => {
    const at = anchor()
    const rect = 'rect' in at
      ? at.rect
      : { top: at.y, bottom: at.y, left: at.x, right: at.x, width: 0 }
    const gap = 'rect' in at ? 4 : 0
    const windowWidth = document.documentElement.clientWidth
    const roomBelow = window.innerHeight - rect.bottom
    const roomAbove = rect.top
    const below = roomBelow >= height() || roomBelow >= roomAbove
    const fromLeft = 'rect' in at
      ? rect.left + rect.width / 2 < windowWidth / 2
      : windowWidth - rect.left >= width()

    return {
      top: below ? `${rect.bottom + gap}px` : null,
      bottom: below ? null : `${window.innerHeight - rect.top + gap}px`,
      left: fromLeft ? `${Math.max(8, rect.left)}px` : null,
      right: fromLeft ? null : `${Math.max(8, windowWidth - rect.right)}px`,
      maxHeight: `${Math.max(0, (below ? roomBelow : roomAbove) - 12)}px`
    }
  })

  /**
   * @param {PointerEvent} event
   */
  function closeOnOutsidePointer(event) {
    if (!element.value?.contains(event.target) && !owner()?.contains(event.target)) {
      onClose()
    }
  }

  /**
   * @param {Event} event
   */
  function closeOnScroll(event) {
    if (event?.target instanceof Node && element.value?.contains(event.target)) { return }

    onClose()
  }

  onMounted(() => {
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    document.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnScroll)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
    document.removeEventListener('scroll', closeOnScroll, true)
    window.removeEventListener('resize', closeOnScroll)
  })

  return { position }
}
