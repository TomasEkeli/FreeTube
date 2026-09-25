<!--
  One channel in a column of the Channels overview.

  A compact row, so that a column shows a screenful of channels and not a
  handful: the thumbnail, the name, and nothing else about the channel. The
  page is for sorting channels into profiles, and what a channel has uploaded
  lately is a question for another page.

  Clicking the row selects it, and Shift-click selects everything from the
  last clicked row; Space and Enter do the same from the keyboard. Going to
  the channel is the small icon at the end of the row, so a stray click while
  sorting never navigates.
-->
<template>
  <div
    class="tile"
    :class="{ dragging, selected }"
    role="checkbox"
    tabindex="0"
    :aria-checked="selected ? 'true' : 'false'"
    :aria-label="channel.name"
    draggable="true"
    @click="emit('select', $event.shiftKey)"
    @keydown.space.enter.self.prevent="emit('select', $event.shiftKey)"
    @dragstart="onDragStart"
    @dragend="dragging = false"
  >
    <span class="thumbnailSlot">
      <img
        v-if="thumbnailUrl"
        class="thumbnail"
        :src="thumbnailUrl"
        alt=""
        draggable="false"
        loading="lazy"
        @error.once="emit('thumbnail-error', channel)"
      >
      <FontAwesomeIcon
        v-else
        class="thumbnail"
        :icon="['fas', 'circle-user']"
      />
      <span
        v-if="selected"
        class="selectedMark"
      >
        <FontAwesomeIcon :icon="['fas', 'check']" />
      </span>
    </span>
    <span
      class="name"
      dir="auto"
      :title="channel.name"
    >
      {{ channel.name }}
    </span>
    <RouterLink
      v-if="showChannelLink"
      class="channelLink"
      :to="`/channel/${channel.id}`"
      :title="t('Channels.Overview.Go to channel', { channelName: channel.name })"
      :aria-label="t('Channels.Overview.Go to channel', { channelName: channel.name })"
      draggable="false"
      @click.stop
    >
      <FontAwesomeIcon :icon="['fas', 'arrow-up-right-from-square']" />
    </RouterLink>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../../store/index'
import { invidiousImageUrlToInvidious, youtubeImageUrlToInvidious } from '../../helpers/api/invidious'

const props = defineProps({
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Channel>} */
  channel: {
    type: Object,
    required: true
  },
  selected: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['thumbnail-error', 'drag-start', 'select'])

const dragging = ref(false)

/**
 * @param {DragEvent} event
 */
function onDragStart(event) {
  dragging.value = true
  emit('drag-start', event, props.channel)
}

const { t } = useI18n()

const showChannelLink = computed(() => !store.getters.getDisableChannelLinks)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

const THUMBNAIL_SIZE = 88

/**
 * The stored thumbnail, pointed at whichever backend is in use and asked for
 * at a size the row can use. Profiles store YouTube's image URLs, or an
 * Invidious instance's from before they were normalised on save.
 */
const thumbnailUrl = computed(() => {
  const original = props.channel.thumbnail

  if (!original) { return null }

  let url = original.startsWith('//') ? `https:${original}` : original

  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }

  if (hostname === 'yt3.ggpht.com' || hostname === 'yt3.googleusercontent.com') {
    if (backendPreference.value === 'invidious') {
      url = youtubeImageUrlToInvidious(url, currentInvidiousInstanceUrl.value)
    }
  } else if (backendPreference.value === 'local') {
    url = url.replace(/^.+ggpht\/(.+)/, 'https://yt3.ggpht.com/$1')
  } else {
    url = invidiousImageUrlToInvidious(url, currentInvidiousInstanceUrl.value)
  }

  return url.replace(/(.+=\w)\d+(.+)/, `$1${THUMBNAIL_SIZE}$2`)
})
</script>

<style scoped src="./ChannelsOverviewTile.css" />
