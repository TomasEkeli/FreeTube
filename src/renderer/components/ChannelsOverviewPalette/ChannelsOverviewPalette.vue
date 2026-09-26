<!--
  Every profile a channel can be filed into, as a strip of bubbles over the
  Channels overview. Clicking a bubble opens that profile's column below, or
  closes it if it is open. Dropping channels on a bubble files them into that
  profile, open or not. While searching, each bubble says how many of its
  channels match, which is how a closed profile shows it has any.

  At the end of the strip, New profile adds a bubble whose name is typed in
  place. Bubbles are dragged along it to put the profiles in the user's own
  order.

  The primary profile has no bubble: it is every subscription, and is never a
  column of its own.
-->
<template>
  <div
    ref="palette"
    class="palette"
    role="group"
    :aria-label="t('Channels.Overview.Profiles')"
    @dragover="onProfileDragOver"
    @dragleave="onProfileDragLeave"
    @drop="onProfileDrop"
    @dragend="endProfileDrag"
  >
    <ChannelsOverviewPaletteBubble
      v-for="(profile, index) in profiles"
      :key="profile._id"
      :profile="profile"
      :open="openProfileIds.includes(profile._id)"
      :match-count="matchCounts?.get(profile._id) ?? null"
      :channel-count="new Set(profile.subscriptions.map(channel => channel.id)).size"
      :duplicate-count="duplicateCounts.get(profile._id) ?? 0"
      :editing="profile._id === renamingProfileId"
      :dragging="profile._id === draggingProfileId"
      :insert-before="markerIndex === index"
      :insert-after="markerIndex === profiles.length && index === profiles.length - 1"
      @toggle="emit('toggle', profile._id)"
      @drop-channels="(dragged, copy) => emit('drop-channels', profile._id, dragged, copy)"
      @rename="(name) => emit('rename', profile._id, name)"
      @menu="(anchor) => emit('menu', profile._id, anchor)"
      @drag-profile="(event) => startProfileDrag(event, profile._id)"
      @move="(step) => moveByKeyboard(profile, index, step)"
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
    <span
      class="visuallyHidden"
      aria-live="polite"
    >{{ announcement }}</span>
  </div>
</template>

<script setup>
import { nextTick, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

import ChannelsOverviewPaletteBubble from '../ChannelsOverviewPaletteBubble/ChannelsOverviewPaletteBubble.vue'
import ChannelsOverviewProfileNameField from '../ChannelsOverviewProfileNameField/ChannelsOverviewProfileNameField.vue'

import { insertionIndex, moveTarget } from '../../helpers/channelsOverview'

const props = defineProps({
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

const emit = defineEmits(['toggle', 'drop-channels', 'new-profile', 'commit-draft', 'cancel-draft', 'rename', 'menu', 'reorder'])

const { t } = useI18n()

const newProfileButton = useTemplateRef('newProfileButton')
const palette = useTemplateRef('palette')

/** Its own kind of drag, so that the channel drop targets never take it for theirs */
const PROFILE_DRAG_TYPE = 'application/x-freetube-profile'

/**
 * The bubble being dragged. A drag's data cannot be read until it is dropped,
 * so the palette remembers which of its own it is; a profile dragged in from
 * another window is not one of them, and is ignored.
 * @type {import('vue').Ref<string | null>}
 */
const draggingProfileId = ref(null)

/** Where the dragged bubble would land, as an insertion index, or null where it would not move */
const markerIndex = ref(null)

/** What a keyboard move did, for a screen reader */
const announcement = ref('')

function isRtl() {
  return palette.value !== null && getComputedStyle(palette.value).direction === 'rtl'
}

/**
 * @param {DragEvent} event
 * @param {string} profileId
 */
function startProfileDrag(event, profileId) {
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(PROFILE_DRAG_TYPE, profileId)
  draggingProfileId.value = profileId
}

/**
 * @param {DragEvent} event
 */
function isOwnProfileDrag(event) {
  return draggingProfileId.value !== null && (event.dataTransfer?.types.includes(PROFILE_DRAG_TYPE) ?? false)
}

function draggedIndex() {
  return props.profiles.findIndex(profile => profile._id === draggingProfileId.value)
}

/**
 * @param {DragEvent} event
 */
function dropInsertion(event) {
  const rects = [...palette.value.querySelectorAll('.paletteEntry')].map(element => element.getBoundingClientRect())

  return insertionIndex(rects, { x: event.clientX, y: event.clientY }, isRtl())
}

/**
 * @param {DragEvent} event
 */
function onProfileDragOver(event) {
  if (!isOwnProfileDrag(event)) { return }

  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'

  const insertion = dropInsertion(event)
  const from = draggedIndex()

  markerIndex.value = moveTarget(from, insertion) === from ? null : insertion
}

/**
 * @param {DragEvent} event
 */
function onProfileDragLeave(event) {
  if (!palette.value?.contains(event.relatedTarget)) {
    markerIndex.value = null
  }
}

/**
 * A drop on a bubble reaches here too: the bubble only takes channels, and
 * leaves anything else to go on up.
 * @param {DragEvent} event
 */
function onProfileDrop(event) {
  if (!isOwnProfileDrag(event)) { return }

  event.preventDefault()

  const profileId = draggingProfileId.value
  const from = draggedIndex()
  const to = moveTarget(from, dropInsertion(event))

  endProfileDrag()

  if (from !== -1 && to !== from) {
    emit('reorder', profileId, to)
  }
}

function endProfileDrag() {
  draggingProfileId.value = null
  markerIndex.value = null
}

/**
 * One place along, on screen. The focus stays on the bubble, which Vue moving
 * its element can take away.
 * @param {import('../../helpers/channelsOverview').Profile} profile
 * @param {number} index
 * @param {1 | -1} step 1 is rightwards
 */
async function moveByKeyboard(profile, index, step) {
  const to = index + (isRtl() ? -step : step)

  if (to < 0 || to >= props.profiles.length) { return }

  emit('reorder', profile._id, to)
  announcement.value = t('Channels.Overview.Profile Moved', { profile: profile.name, position: to + 1, count: props.profiles.length })

  await nextTick()
  palette.value?.querySelector(`[data-profile-id="${CSS.escape(profile._id)}"] [role="button"]`)?.focus()
}

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
