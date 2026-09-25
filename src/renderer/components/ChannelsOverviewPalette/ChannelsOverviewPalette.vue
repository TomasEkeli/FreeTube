<!--
  Every profile a channel can be filed into, as a strip of bubbles over the
  Channels overview. Clicking a bubble opens that profile's column below, or
  closes it if it is open. Dropping channels on a bubble files them into that
  profile, open or not. While searching, each bubble says how many of its
  channels match, which is how a closed profile shows it has any.

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
      :match-count="matchCounts?.get(profile._id) ?? null"
      :channel-count="new Set(profile.subscriptions.map(channel => channel.id)).size"
      :duplicate-count="duplicateCounts.get(profile._id) ?? 0"
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
  },
  /** @type {import('vue').PropType<Map<string, number> | null>} */
  matchCounts: {
    type: Map,
    default: null
  },
  /** @type {import('vue').PropType<Map<string, number>>} */
  duplicateCounts: {
    type: Map,
    default: () => new Map()
  }
})

const emit = defineEmits(['toggle', 'drop-channels'])

const { t } = useI18n()
</script>

<style scoped src="./ChannelsOverviewPalette.css" />
