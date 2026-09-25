<!--
  A button that opens a menu of choices, for the Channels page: the mark on a
  channel in more than one profile, and the move and copy menus over the
  columns.

  Both the button and the menu are usable from the keyboard, as these menus
  are how channels are sorted without dragging. The menu is put over the page
  instead of beside the button, as a column clips whatever sticks out of it.
-->
<template>
  <button
    ref="button"
    type="button"
    class="menuButton"
    :class="variant"
    :title="label"
    :aria-label="variant === 'icon' ? label : null"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    draggable="false"
    @click.stop="toggle"
    @keydown.enter.space.stop.prevent="openMenu(true)"
    @keydown.down.stop.prevent="openMenu(true)"
  >
    <slot />
  </button>
  <Teleport
    v-if="open"
    to=".app"
  >
    <ul
      ref="menu"
      class="menu"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="menuPosition"
      @keydown.stop="handleMenuKeydown"
      @focusout="handleFocusOut"
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
import { nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue'

const props = defineProps({
  /** What the menu is for: the button's tooltip, and the menu's name */
  label: {
    type: String,
    required: true
  },
  /** @type {import('vue').PropType<{ value: string, label: string }[]>} */
  items: {
    type: Array,
    required: true
  },
  /** 'icon' for a small round button with only an icon in it, 'button' for one with text */
  variant: {
    type: String,
    default: 'icon'
  }
})

const emit = defineEmits(['choose'])

const button = useTemplateRef('button')
const menu = useTemplateRef('menu')

const open = ref(false)
const menuPosition = ref({})

function toggle() {
  if (open.value) {
    closeMenu(false)
  } else {
    openMenu(false)
  }
}

/**
 * Below the button, or above it where there is no room below. Lined up with
 * whichever side of the button leaves the menu inside the window. Physical
 * sides, as the button's position is measured in them.
 */
function positionMenu() {
  const rect = button.value.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  const roomBelow = window.innerHeight - rect.bottom
  const roomAbove = rect.top
  const below = roomBelow >= props.items.length * 36 + 12 || roomBelow >= roomAbove
  const fromLeft = rect.left + rect.width / 2 < width / 2

  menuPosition.value = {
    top: below ? `${rect.bottom + 4}px` : null,
    bottom: below ? null : `${window.innerHeight - rect.top + 4}px`,
    left: fromLeft ? `${Math.max(8, rect.left)}px` : null,
    right: fromLeft ? null : `${Math.max(8, width - rect.right)}px`,
    maxHeight: `${Math.max(0, (below ? roomBelow : roomAbove) - 12)}px`
  }
}

/**
 * @param {boolean} focusFirst from the keyboard, the first item takes focus
 */
async function openMenu(focusFirst) {
  positionMenu()
  open.value = true

  document.addEventListener('pointerdown', closeOnOutsidePointer, true)
  document.addEventListener('scroll', closeOnScroll, true)
  window.addEventListener('resize', closeOnScroll)

  await nextTick()

  if (focusFirst) {
    menuItems()[0]?.focus()
  }
}

/**
 * @param {boolean} returnFocus
 */
function closeMenu(returnFocus) {
  if (!open.value) { return }

  open.value = false

  document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  document.removeEventListener('scroll', closeOnScroll, true)
  window.removeEventListener('resize', closeOnScroll)

  if (returnFocus) {
    button.value?.focus()
  }
}

/** @returns {HTMLButtonElement[]} */
function menuItems() {
  return menu.value ? [...menu.value.querySelectorAll('.menuItem')] : []
}

/**
 * @param {KeyboardEvent} event
 */
function handleMenuKeydown(event) {
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
      closeMenu(true)
      break
    case 'Tab':
      closeMenu(false)
      break
  }
}

/**
 * @param {FocusEvent} event
 */
function handleFocusOut(event) {
  if (event.relatedTarget !== null && !menu.value?.contains(event.relatedTarget) && event.relatedTarget !== button.value) {
    closeMenu(false)
  }
}

/**
 * @param {PointerEvent} event
 */
function closeOnOutsidePointer(event) {
  if (!menu.value?.contains(event.target) && !button.value?.contains(event.target)) {
    closeMenu(false)
  }
}

/**
 * The menu is placed against the window, so it would be left behind by a
 * column scrolling under it.
 * @param {Event} event
 */
function closeOnScroll(event) {
  if (event?.target instanceof Node && menu.value?.contains(event.target)) { return }

  closeMenu(false)
}

/**
 * @param {string} value
 */
function choose(value) {
  closeMenu(true)
  emit('choose', value)
}

onBeforeUnmount(() => closeMenu(false))
</script>

<style scoped src="./ChannelsOverviewMenuButton.css" />
