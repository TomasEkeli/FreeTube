<!--
  The mark on a channel that is in more than one profile, and the two ways out
  it offers: take the channel out of this profile only, or keep it here and
  take it out of every other.

  A button and a menu, both reachable and usable from the keyboard: this and
  dropping on a palette bubble are how channels are sorted without dragging.
  The menu is put over the page instead of inside the row, as a column clips
  whatever sticks out of it.
-->
<template>
  <button
    ref="button"
    type="button"
    class="duplicateButton"
    :title="label"
    :aria-label="label"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    draggable="false"
    @click.stop="toggle"
    @keydown.enter.space.stop.prevent="openMenu(true)"
    @keydown.down.stop.prevent="openMenu(true)"
  >
    <FontAwesomeIcon :icon="['fas', 'clone']" />
  </button>
  <Teleport
    v-if="open"
    to=".app"
  >
    <ul
      ref="menu"
      class="duplicateMenu"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      :style="menuPosition"
      @keydown.stop="handleMenuKeydown"
      @focusout="handleFocusOut"
    >
      <li role="none">
        <button
          type="button"
          role="menuitem"
          class="menuItem"
          tabindex="-1"
          @click.stop="choose('remove-here')"
        >
          {{ t('Channels.Overview.Remove This Duplicate') }}
        </button>
      </li>
      <li role="none">
        <button
          type="button"
          role="menuitem"
          class="menuItem"
          tabindex="-1"
          @click.stop="choose('keep-here')"
        >
          {{ t('Channels.Overview.Keep Here Only') }}
        </button>
      </li>
    </ul>
  </Teleport>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { nextTick, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps({
  /** Says which profiles the channel is in */
  label: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['remove-here', 'keep-here'])

const { t } = useI18n()

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
 * Below the button, or above it where there is no room below; aligned to its
 * end so it stays inside the window.
 */
function positionMenu() {
  const rect = button.value.getBoundingClientRect()
  const roomBelow = window.innerHeight - rect.bottom

  menuPosition.value = {
    insetBlockStart: roomBelow > 110 ? `${rect.bottom + 4}px` : null,
    insetBlockEnd: roomBelow > 110 ? null : `${window.innerHeight - rect.top + 4}px`,
    insetInlineEnd: `${Math.max(8, document.documentElement.clientWidth - rect.right)}px`
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
    items()[0]?.focus()
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
function items() {
  return menu.value ? [...menu.value.querySelectorAll('.menuItem')] : []
}

/**
 * @param {KeyboardEvent} event
 */
function handleMenuKeydown(event) {
  const all = items()
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
 * @param {'remove-here' | 'keep-here'} action
 */
function choose(action) {
  closeMenu(true)

  if (action === 'remove-here') {
    emit('remove-here')
  } else {
    emit('keep-here')
  }
}

onBeforeUnmount(() => closeMenu(false))
</script>

<style scoped src="./ChannelsOverviewDuplicateMenu.css" />
