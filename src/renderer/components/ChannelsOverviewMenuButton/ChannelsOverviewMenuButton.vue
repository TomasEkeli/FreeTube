<!--
  A button that opens a menu of choices, for the Channels page: the mark on a
  channel in more than one profile, and the move and copy menus over the
  columns.

  Both the button and the menu are usable from the keyboard, as these menus
  are how channels are sorted without dragging. The menu itself is
  ChannelsOverviewMenu.
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
  <ChannelsOverviewMenu
    v-if="open"
    :label="label"
    :items="items"
    :anchor="anchor"
    :owner="button"
    :focus-first="focusFirst"
    @choose="(value) => emit('choose', value)"
    @close="closeMenu"
  />
</template>

<script setup>
import { ref, useTemplateRef } from 'vue'

import ChannelsOverviewMenu from '../ChannelsOverviewMenu/ChannelsOverviewMenu.vue'

defineProps({
  /** What the menu is for: the button's tooltip, and the menu's name */
  label: {
    type: String,
    required: true
  },
  /** @type {import('vue').PropType<import('../ChannelsOverviewMenu/ChannelsOverviewMenu.vue').MenuItem[]>} */
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

const open = ref(false)
const anchor = ref(null)
const focusFirst = ref(false)

function toggle() {
  if (open.value) {
    closeMenu(false)
  } else {
    openMenu(false)
  }
}

/**
 * @param {boolean} fromKeyboard the first item takes the focus
 */
function openMenu(fromKeyboard) {
  anchor.value = { rect: button.value.getBoundingClientRect() }
  focusFirst.value = fromKeyboard
  open.value = true
}

/**
 * @param {boolean} returnFocus
 */
function closeMenu(returnFocus) {
  open.value = false

  if (returnFocus) {
    button.value?.focus()
  }
}
</script>

<style scoped src="./ChannelsOverviewMenuButton.css" />
