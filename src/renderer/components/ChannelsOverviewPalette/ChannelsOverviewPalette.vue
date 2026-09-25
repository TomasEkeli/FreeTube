<!--
  Every profile a channel can be filed into, as a strip of bubbles over the
  Channels overview. Clicking a bubble opens that profile's column below, or
  closes it if it is open.

  The primary profile has no bubble: it is every subscription, and is never a
  column of its own.
-->
<template>
  <div
    class="palette"
    role="group"
    :aria-label="t('Channels.Overview.Profiles')"
  >
    <div
      v-for="profile in profiles"
      :key="profile._id"
      class="paletteEntry"
    >
      <FtProfileBubble
        class="paletteBubble"
        :class="{ open: openProfileIds.includes(profile._id) }"
        :profile-name="profile.name"
        :is-main-profile="false"
        :background-color="profile.bgColor"
        :text-color="profile.textColor"
        :aria-pressed="openProfileIds.includes(profile._id) ? 'true' : 'false'"
        @click="emit('toggle', profile._id)"
      />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import FtProfileBubble from '../FtProfileBubble/FtProfileBubble.vue'

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

const emit = defineEmits(['toggle'])

const { t } = useI18n()
</script>

<style scoped src="./ChannelsOverviewPalette.css" />
