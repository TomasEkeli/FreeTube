<!--
  One thing the reader can switch on and off, sitting in a row of its like.

  Generic rather than the subscriptions page's own: a chip is a labelled toggle
  that looks like what it controls, and that has nothing to do with feeds. The
  same row is wanted over trending later.

  A button with `aria-pressed`, and not a checkbox: it acts the moment it is
  pressed, and there is no form here to submit. Icon *and* label, for the same
  reason the kind markers on the cards carry both — an icon alone is a riddle.
-->
<template>
  <button
    class="chip"
    :class="{ chipPressed: pressed }"
    type="button"
    :aria-pressed="pressed"
    @click="toggle"
  >
    <FontAwesomeIcon
      v-if="icon"
      class="chipIcon"
      :icon="icon"
      aria-hidden="true"
    />
    {{ label }}
  </button>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

defineProps({
  label: {
    type: String,
    required: true
  },
  /** Whether what this chip controls is on. */
  pressed: {
    type: Boolean,
    default: false
  },
  icon: {
    type: Array,
    default: null
  }
})

const emit = defineEmits(['toggle'])

// Emitted as "the reader pressed this", not as the value it should now take:
// what a chip means is the caller's business, and the caller is what holds it.
function toggle() {
  emit('toggle')
}
</script>

<style scoped src="./FtToggleChip.css" />
