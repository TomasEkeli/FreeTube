<template>
  <svg
    class="progressRing"
    :class="{ indeterminate: fraction === null }"
    viewBox="0 0 36 36"
    aria-hidden="true"
  >
    <circle
      class="track"
      cx="18"
      cy="18"
      :r="RADIUS"
    />
    <circle
      class="bar"
      cx="18"
      cy="18"
      :r="RADIUS"
      :stroke-dasharray="dashArray"
      :stroke-dashoffset="dashOffset"
    />
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** From 0 to 1, or null for a spinning ring that says only "busy" */
  fraction: {
    type: Number,
    default: null
  }
})

const RADIUS = 16
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const dashArray = computed(() => {
  return props.fraction === null ? `${CIRCUMFERENCE / 4} ${CIRCUMFERENCE}` : `${CIRCUMFERENCE}`
})

const dashOffset = computed(() => {
  return props.fraction === null ? 0 : CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, props.fraction)))
})
</script>

<style scoped src="./FtProgressRing.css" />
