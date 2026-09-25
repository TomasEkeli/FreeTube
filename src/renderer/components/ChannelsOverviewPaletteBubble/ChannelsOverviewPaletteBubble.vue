<!--
  One profile in the palette over the Channels overview. Clicking it opens or
  closes the profile's column; dropping channels on it files them into the
  profile without opening the column, and the bubble flashes to say they
  landed.

  Under the name, how many channels the profile has, and how many of those
  are shared with some other profile: the ones to sort out.
-->
<template>
  <div
    class="paletteEntry"
    :class="{ dropTarget: dragOver, acknowledged }"
    :data-profile-id="profile._id"
    :title="summary"
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
      class="counts"
      :class="{ open }"
      aria-hidden="true"
    >
      {{ channelCount }}
      <span
        v-if="duplicateCount > 0"
        class="sharedCount"
      >{{ t('Channels.Overview.Shared Count', { count: duplicateCount }) }}</span>
    </span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtProfileBubble from '../FtProfileBubble/FtProfileBubble.vue'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

const props = defineProps({
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
  /** How many channels the profile has */
  channelCount: {
    type: Number,
    default: 0
  },
  /** How many of the profile's channels are in some other profile too */
  duplicateCount: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['toggle', 'drop-channels'])

const { t } = useI18n()

/** The counts in words, for the tooltip and for a screen reader */
const summary = computed(() => {
  const channels = t('Channels.Overview.Profile Channels', { count: props.channelCount }, props.channelCount)

  if (props.duplicateCount === 0) { return `${props.profile.name}: ${channels}` }

  const shared = t('Channels.Overview.Profile Duplicates', { count: props.duplicateCount }, props.duplicateCount)

  return `${props.profile.name}: ${channels}. ${shared}`
})

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
