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
    <span
      v-if="matchCount !== null"
      class="badge matchBadge"
      :class="{ noMatches: matchCount === 0 }"
      :title="t('Channels.Overview.Profile Matches', { count: matchCount }, matchCount)"
    >
      {{ matchCount }}
    </span>
    <span
      v-if="duplicateCount > 0"
      class="badge duplicateBadge"
      :title="t('Channels.Overview.Profile Duplicates', { count: duplicateCount }, duplicateCount)"
    >
      <FontAwesomeIcon
        :icon="['fas', 'clone']"
        aria-hidden="true"
      />
      {{ duplicateCount }}
    </span>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

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
  },
  /** How many of the profile's channels match the search, null while not searching */
  matchCount: {
    type: Number,
    default: null
  },
  /** How many of the profile's channels are in some other profile too */
  duplicateCount: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['toggle', 'drop-channels'])

const { t } = useI18n()

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
