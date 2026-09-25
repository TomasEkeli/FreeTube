import { onBeforeUnmount, onMounted, ref } from 'vue'

import { acceptChannelDrag, isCopyDrop, readChannelDrag } from '../helpers/channelDragAndDrop'

/**
 * Makes an element somewhere to drop dragged channels: a column, a palette
 * bubble, the trash. Bind `handlers` with `v-on` on the element, and use
 * `dragOver` to show that a drop would land there.
 *
 * @param {object} options
 * @param {(dragged: import('../helpers/channelDragAndDrop').DraggedChannel[], copy: boolean) => void} options.onDrop
 * @param {() => boolean} [options.canCopy] false where a copy means nothing
 */
export function useChannelDropTarget({ onDrop, canCopy = () => true }) {
  const dragOver = ref(false)

  /**
   * How many of the target's elements the drag is over. Moving from one child
   * on to the next enters the next before leaving the last, so the target is
   * only left once this is back to zero.
   */
  let dragDepth = 0

  /**
   * @param {DragEvent} event
   */
  function onDragEnter(event) {
    if (acceptChannelDrag(event, canCopy())) {
      dragDepth++
      dragOver.value = true
    }
  }

  /**
   * @param {DragEvent} event
   */
  function onDragOver(event) {
    acceptChannelDrag(event, canCopy())
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1)

    if (dragDepth === 0) {
      dragOver.value = false
    }
  }

  /** A drag given up with Escape, or dropped somewhere else, ends the highlight too. */
  function endDrag() {
    dragDepth = 0
    dragOver.value = false
  }

  /**
   * @param {DragEvent} event
   */
  function onDropEvent(event) {
    endDrag()

    const dragged = readChannelDrag(event)

    if (dragged.length === 0) { return }

    event.preventDefault()
    // Stops a target inside another from dropping twice
    event.stopPropagation()
    onDrop(dragged, canCopy() && isCopyDrop(event))
  }

  onMounted(() => document.addEventListener('dragend', endDrag))
  onBeforeUnmount(() => document.removeEventListener('dragend', endDrag))

  return {
    dragOver,
    handlers: {
      dragenter: onDragEnter,
      dragover: onDragOver,
      dragleave: onDragLeave,
      drop: onDropEvent,
    }
  }
}
