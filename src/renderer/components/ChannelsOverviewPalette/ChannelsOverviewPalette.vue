<!--
  Every profile a channel can be filed into, as a strip of bubbles over the
  Channels overview. Clicking a bubble opens that profile's column below, or
  closes it if it is open. Dropping channels on a bubble files them into that
  profile, open or not.

  The primary profile has no bubble: it is every subscription, and is never a
  column of its own.
-->
<template>
  <div
    class="palette"
    role="group"
    :aria-label="t('Channels.Overview.Profiles')"
  >
    <ChannelsOverviewPaletteBubble
      v-for="profile in profiles"
      :key="profile._id"
      :profile="profile"
      :open="openProfileIds.includes(profile._id)"
      @toggle="emit('toggle', profile._id)"
      @drop-channels="(dragged, copy) => emit('drop-channels', profile._id, dragged, copy)"
    />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import ChannelsOverviewPaletteBubble from '../ChannelsOverviewPaletteBubble/ChannelsOverviewPaletteBubble.vue'

defineProps({
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Profile[]>} */
  profiles: {
    type: Array,
    required: true
  },
  /** @type {import('vue').PropType<string[]>} */
  openProfileIds: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['toggle', 'drop-channels'])

const { t } = useI18n()
</script>

<style scoped src="./ChannelsOverviewPalette.css" />
