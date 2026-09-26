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
import { nextTick, onMounted, useTemplateRef } from 'vue'

import { useAnchoredOverlay } from '../../composables/useAnchoredOverlay'

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

const { position } = useAnchoredOverlay({
  element: menu,
  anchor: () => props.anchor,
  owner: () => props.owner,
  height: () => props.items.length * 36 + 12,
  onClose: () => emit('close', false)
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
 * @param {string} value
 */
function choose(value) {
  // The choice first: whoever opened the menu may forget what it was for
  // once it is closed
  emit('choose', value)
  emit('close', true)
}

onMounted(async () => {
  await nextTick()

  if (props.focusFirst) {
    menuItems()[0]?.focus()
  }
})
</script>

<style scoped src="./ChannelsOverviewMenu.css" />
