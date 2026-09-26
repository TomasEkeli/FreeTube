<!--
  Every profile a channel can be filed into, as a strip of bubbles over the
  Channels overview. Clicking a bubble opens that profile's column below, or
  closes it if it is open. Dropping channels on a bubble files them into that
  profile, open or not. While searching, each bubble says how many of its
  channels match, which is how a closed profile shows it has any.

  At the end of the strip, New profile adds a bubble whose name is typed in place.

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
      :editing="profile._id === renamingProfileId"
      @toggle="emit('toggle', profile._id)"
      @drop-channels="(dragged, copy) => emit('drop-channels', profile._id, dragged, copy)"
      @rename="(name) => emit('rename', profile._id, name)"
      @menu="(anchor) => emit('menu', profile._id, anchor)"
    />
    <ChannelsOverviewProfileNameField
      v-if="draft !== null"
      :bg-color="draft.bgColor"
      :label="t('Channels.Overview.New Profile Name')"
      :disabled="draft.saving"
      @commit="(name, hadFocus) => emit('commit-draft', name, hadFocus)"
      @cancel="cancelDraft"
    />
    <button
      ref="newProfileButton"
      type="button"
      class="newProfile"
      @click="emit('new-profile')"
    >
      <span
        class="newProfileBubble"
        aria-hidden="true"
      >
        <FontAwesomeIcon :icon="['fas', 'plus']" />
      </span>
      <span class="newProfileName">{{ t('Channels.Overview.New Profile') }}</span>
    </button>
  </div>
</template>

<script setup>
import { nextTick, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

import ChannelsOverviewPaletteBubble from '../ChannelsOverviewPaletteBubble/ChannelsOverviewPaletteBubble.vue'
import ChannelsOverviewProfileNameField from '../ChannelsOverviewProfileNameField/ChannelsOverviewProfileNameField.vue'

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
  },
  /**
   * The new profile being named, if there is one
   * @type {import('vue').PropType<{ bgColor: string, saving: boolean } | null>}
   */
  draft: {
    type: Object,
    default: null
  },
  /** The profile whose name is being typed in place, if any */
  renamingProfileId: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['toggle', 'drop-channels', 'new-profile', 'commit-draft', 'cancel-draft', 'rename', 'menu'])

const { t } = useI18n()

const newProfileButton = useTemplateRef('newProfileButton')

/**
 * Given up with Escape, the focus goes back to New profile, as the field it
 * was in is gone.
 * @param {boolean} hadFocus
 */
async function cancelDraft(hadFocus) {
  emit('cancel-draft')

  if (hadFocus) {
    await nextTick()
    newProfileButton.value?.focus()
  }
}
</script>

<style scoped src="./ChannelsOverviewPalette.css" />
