<!--
  The colours a profile can have, as a grid next to its bubble on the Channels
  page: every colour the app has, then one cell for any other, through the
  system's colour picker. Picking one is the change; there is nothing to
  confirm.

  From the keyboard: the arrow keys move through the grid, Home and End go to
  the first and last cell, Enter or Space picks, Escape and Tab close it.
-->
<template>
  <Teleport to=".app">
    <div
      ref="grid"
      class="colourMenu"
      role="radiogroup"
      tabindex="-1"
      :aria-label="label"
      :style="position"
      @keydown.stop="handleKeydown"
      @focusout="handleFocusOut"
      @contextmenu.prevent
    >
      <button
        v-for="(colour, index) in colors"
        :key="colour.value"
        type="button"
        role="radio"
        class="swatch"
        :class="{ current: index === currentIndex }"
        :style="{ backgroundColor: colour.value }"
        :aria-checked="index === currentIndex ? 'true' : 'false'"
        :aria-label="colourNames[index]"
        :title="colourNames[index]"
        :tabindex="index === focusIndex ? 0 : -1"
        @click="choose(colour.value)"
      />
      <button
        type="button"
        role="radio"
        class="swatch customSwatch"
        :class="{ current: currentIndex === colors.length }"
        :aria-checked="currentIndex === colors.length ? 'true' : 'false'"
        :aria-label="t('Profile.Custom Color')"
        :title="t('Profile.Custom Color')"
        :tabindex="focusIndex === colors.length ? 0 : -1"
        @click="openCustomPicker"
      />
      <!-- Not inside the button, as a button cannot hold a control. Hidden but
           rendered, next to the cell, so the picker opens beside it -->
      <input
        ref="customInput"
        class="customInput"
        type="color"
        tabindex="-1"
        aria-hidden="true"
        :value="current"
        @change="choose($event.target.value)"
      >
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAnchoredOverlay } from '../../composables/useAnchoredOverlay'
import { useColorTranslations } from '../../composables/colors'
import { colors } from '../../helpers/colors'

/** Cells per row; the width in ChannelsOverviewColourMenu.css follows it */
const COLUMNS = 10
const CELL = 32

const props = defineProps({
  /** The grid's name, for a screen reader */
  label: {
    type: String,
    required: true
  },
  /** The profile's colour now */
  current: {
    type: String,
    required: true
  },
  /** @type {import('vue').PropType<{ rect: DOMRect } | { x: number, y: number }>} */
  anchor: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['choose', 'close'])

const { t } = useI18n()
const colourNames = useColorTranslations()

const grid = useTemplateRef('grid')
const customInput = useTemplateRef('customInput')

const cellCount = colors.length + 1

/** The profile's colour among the cells; the custom cell when it is none of the list */
const currentIndex = computed(() => {
  const index = colors.findIndex(colour => colour.value.toLowerCase() === props.current.toLowerCase())

  return index === -1 ? colors.length : index
})

/** The one cell Tab reaches, and where the arrow keys move from */
const focusIndex = ref(currentIndex.value)

const { position } = useAnchoredOverlay({
  element: grid,
  anchor: () => props.anchor,
  height: () => Math.ceil(cellCount / COLUMNS) * CELL + 16,
  width: () => COLUMNS * CELL + 16,
  onClose: () => emit('close', false)
})

/**
 * @param {number} index
 */
function focusCell(index) {
  focusIndex.value = index
  grid.value?.querySelectorAll('.swatch')[index]?.focus()
}

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  // Left and Right are sides of the screen, and the grid runs the other way
  // in a right-to-left layout
  const forward = getComputedStyle(grid.value).direction === 'rtl' ? -1 : 1
  let next

  switch (event.key) {
    case 'ArrowRight':
      next = focusIndex.value + forward
      break
    case 'ArrowLeft':
      next = focusIndex.value - forward
      break
    case 'ArrowDown':
      next = focusIndex.value + COLUMNS
      break
    case 'ArrowUp':
      next = focusIndex.value - COLUMNS
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = cellCount - 1
      break
    case 'Escape':
      // Handled here, so the page does not also take it as clearing the selection
      event.preventDefault()
      emit('close', true)
      return
    case 'Tab':
      emit('close', false)
      return
    default:
      return
  }

  event.preventDefault()

  if (next >= 0 && next < cellCount) {
    focusCell(next)
  }
}

/**
 * Closes when the focus goes somewhere else on the page. Not when it goes
 * nowhere on the page, which is what the system's colour picker opening looks
 * like: closing then would take the input away under the picker.
 * @param {FocusEvent} event
 */
function handleFocusOut(event) {
  const next = event.relatedTarget

  if (next !== null && !grid.value?.contains(next)) {
    emit('close', false)
  }
}

function openCustomPicker() {
  const input = customInput.value

  if (!input) { return }

  try {
    input.showPicker()
  } catch {
    input.click()
  }
}

/**
 * @param {string} value
 */
function choose(value) {
  // The choice first: whoever opened the grid may forget what it was for
  // once it is closed
  emit('choose', value)
  emit('close', true)
}

onMounted(async () => {
  await nextTick()
  focusCell(focusIndex.value)
})
</script>

<style scoped src="./ChannelsOverviewColourMenu.css" />
