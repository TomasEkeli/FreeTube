<!--
  One profile in the palette over the Channels overview. Clicking it opens or
  closes the profile's column; dropping channels on it files them into the
  profile without opening the column, and the bubble flashes to say they
  landed.
-->
<template>
  <div
    class="paletteEntry"
    :class="{ dropTarget: dragOver, acknowledged }"
    v-on="dropHandlers"
  >
    <FtProfileBubble
      class="paletteBubble"
      :class="{ open }"
      :profile-name="profile.name"
      :is-main-profile="false"
      :background-color="profile.bgColor"
      :text-color="profile.textColor"
      :aria-pressed="open ? 'true' : 'false'"
      @click="emit('toggle')"
    />
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'

import FtProfileBubble from '../FtProfileBubble/FtProfileBubble.vue'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

defineProps({
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Profile>} */
  profile: {
    type: Object,
    required: true
  },
  open: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['toggle', 'drop-channels'])

const acknowledged = ref(false)
let acknowledgeTimeout = null

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged, copy) => {
    emit('drop-channels', dragged, copy)
    acknowledge()
  }
})

/** Replays the flash if a second drop lands while the first is still showing. */
function acknowledge() {
  clearTimeout(acknowledgeTimeout)
  acknowledged.value = false

  requestAnimationFrame(() => {
    acknowledged.value = true
    acknowledgeTimeout = setTimeout(() => { acknowledged.value = false }, 900)
  })
}

onBeforeUnmount(() => clearTimeout(acknowledgeTimeout))
</script>

<style scoped src="./ChannelsOverviewPaletteBubble.css" />
