<!--
  A menu of choices on the Channels page, put over the page next to what
  opened it: under a button, or where a channel was right-clicked. Over the
  page, as a column clips whatever sticks out of it.

  Usable from the keyboard: the arrow keys, Home and End move through it,
  Enter chooses, Escape and Tab close it. A click outside it, or anything
  scrolling under it, closes it too.
-->
<template>
  <Teleport to=".app">
    <ul
      ref="menu"
      class="menu"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown.stop="handleKeydown"
      @focusout="handleFocusOut"
      @contextmenu.prevent
    >
      <li
        v-for="item in items"
        :key="item.value"
        role="none"
      >
        <button
          type="button"
          role="menuitem"
          class="menuItem"
          :class="{ destructive: item.destructive }"
          tabindex="-1"
          @click.stop="choose(item.value)"
        >
          {{ item.label }}
        </button>
      </li>
    </ul>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

/**
 * @typedef {object} MenuItem
 * @property {string} value
 * @property {string} label
 * @property {boolean} [destructive]
 */

const props = defineProps({
  /** The menu's name, for a screen reader */
  label: {
    type: String,
    required: true
  },
  /** @type {import('vue').PropType<MenuItem[]>} */
  items: {
    type: Array,
    required: true
  },
  /**
   * What it opens next to: `{ rect }` for under (or over) a button,
   * `{ x, y }` for at the pointer
   * @type {import('vue').PropType<{ rect: DOMRect } | { x: number, y: number }>}
   */
  anchor: {
    type: Object,
    required: true
  },
  /** An element whose clicks are not outside the menu: the button that opens it */
  owner: {
    type: Object,
    default: null
  },
  /** From the keyboard, the first item takes the focus */
  focusFirst: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['choose', 'close'])

const menu = useTemplateRef('menu')

/**
 * Below the anchor, or above it where there is no room below; lined up with
 * whichever side leaves the menu inside the window. Physical sides, as the
 * anchor's position is measured in them.
 */
const position = computed(() => {
  const rect = 'rect' in props.anchor
    ? props.anchor.rect
    : { top: props.anchor.y, bottom: props.anchor.y, left: props.anchor.x, right: props.anchor.x, width: 0 }
  const gap = 'rect' in props.anchor ? 4 : 0
  const width = document.documentElement.clientWidth
  const roomBelow = window.innerHeight - rect.bottom
  const roomAbove = rect.top
  const below = roomBelow >= props.items.length * 36 + 12 || roomBelow >= roomAbove
  const fromLeft = 'rect' in props.anchor
    ? rect.left + rect.width / 2 < width / 2
    : width - rect.left >= 240

  return {
    top: below ? `${rect.bottom + gap}px` : null,
    bottom: below ? null : `${window.innerHeight - rect.top + gap}px`,
    left: fromLeft ? `${Math.max(8, rect.left)}px` : null,
    right: fromLeft ? null : `${Math.max(8, width - rect.right)}px`,
    maxHeight: `${Math.max(0, (below ? roomBelow : roomAbove) - 12)}px`
  }
})

/** @returns {HTMLButtonElement[]} */
function menuItems() {
  return menu.value ? [...menu.value.querySelectorAll('.menuItem')] : []
}

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  const all = menuItems()
  const index = all.indexOf(document.activeElement)

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      all[(index + 1) % all.length]?.focus()
      break
    case 'ArrowUp':
      event.preventDefault()
      all[(index - 1 + all.length) % all.length]?.focus()
      break
    case 'Home':
      event.preventDefault()
      all[0]?.focus()
      break
    case 'End':
      event.preventDefault()
      all[all.length - 1]?.focus()
      break
    case 'Escape':
      // Handled here, so the page does not also take it as clearing the selection
      event.preventDefault()
      emit('close', true)
      break
    case 'Tab':
      emit('close', false)
      break
  }
}

/**
 * @param {FocusEvent} event
 */
function handleFocusOut(event) {
  const next = event.relatedTarget

  if (next !== null && !menu.value?.contains(next) && !props.owner?.contains(next)) {
    emit('close', false)
  }
}

/**
 * @param {PointerEvent} event
 */
function closeOnOutsidePointer(event) {
  if (!menu.value?.contains(event.target) && !props.owner?.contains(event.target)) {
    emit('close', false)
  }
}

/**
 * The menu is placed against the window, so it would be left behind by a
 * column scrolling under it.
 * @param {Event} event
 */
function closeOnScroll(event) {
  if (event?.target instanceof Node && menu.value?.contains(event.target)) { return }

  emit('close', false)
}

/**
 * @param {string} value
 */
function choose(value) {
  // The choice first: whoever opened the menu may forget what it was for
  // once it is closed
  emit('choose', value)
  emit('close', true)
}

onMounted(async () => {
  document.addEventListener('pointerdown', closeOnOutsidePointer, true)
  document.addEventListener('scroll', closeOnScroll, true)
  window.addEventListener('resize', closeOnScroll)

  await nextTick()

  if (props.focusFirst) {
    menuItems()[0]?.focus()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  document.removeEventListener('scroll', closeOnScroll, true)
  window.removeEventListener('resize', closeOnScroll)
})
</script>

<style scoped src="./ChannelsOverviewMenu.css" />
