<!--
  One column of the Channels overview: a profile's channels, or the pool of
  channels no profile has claimed.

  A column can hold a couple of thousand channels, and drawing them all at once
  is what made the old channel list slow to open. So it draws the first
  screenful and a little more, and each time the end of what it has drawn
  scrolls into view it draws the next batch. A new search starts it over. The marker at the end is keyed on
  how many are drawn, so a batch that still leaves the end in view triggers the
  next one as soon as it lands.
-->
<template>
  <section
    class="column"
    :class="{ pool: isPool, dropTarget: dragOver }"
    :aria-labelledby="headingId"
    v-on="dropHandlers"
  >
    <header
      class="columnHeader"
      :style="isPool ? null : { background: backgroundColor, color: textColor }"
    >
      <h3
        :id="headingId"
        class="columnTitle"
        dir="auto"
      >
        {{ title }}
      </h3>
      <span class="columnCount">
        {{ countLabel }}
      </span>
    </header>
    <div
      ref="body"
      class="columnBody"
    >
      <p
        v-if="channels.length === 0"
        class="emptyColumn"
      >
        {{ emptyLabel }}
      </p>
      <ChannelsOverviewTile
        v-for="channel in drawnChannels"
        :key="channel.id"
        :channel="channel"
        :selected="selectedIds.has(channel.id)"
        :duplicate-profiles="duplicateProfiles.get(channel.id) ?? null"
        :callout="calloutColours.get(channel.id) ?? null"
        @thumbnail-error="emit('thumbnail-error', $event)"
        @drag-start="(event, channel) => emit('drag-start', event, channel)"
        @select="(extend) => emit('select', channel, extend)"
        @remove-here="emit('remove-here', channel)"
        @keep-here="emit('keep-here', channel)"
      />
      <div
        v-if="drawnChannels.length < channels.length"
        :key="drawLimit"
        v-observe-visibility="{ callback: drawMore }"
        class="drawMore"
      />
    </div>
  </section>
</template>

<script setup>
import { computed, ref, useId, useTemplateRef, watch } from 'vue'

import ChannelsOverviewTile from '../ChannelsOverviewTile/ChannelsOverviewTile.vue'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

const props = defineProps({
  title: {
    type: String,
    required: true
  },
  countLabel: {
    type: String,
    required: true
  },
  emptyLabel: {
    type: String,
    default: ''
  },
  backgroundColor: {
    type: String,
    default: null
  },
  textColor: {
    type: String,
    default: null
  },
  isPool: {
    type: Boolean,
    default: false
  },
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Channel[]>} */
  channels: {
    type: Array,
    required: true
  },
  /**
   * Starts the column over from the top, drawing only the first rows, when it
   * changes: the search does this, as what was scrolled to is gone.
   */
  resetKey: {
    type: String,
    default: ''
  },
  /** @type {import('vue').PropType<Set<string>>} */
  selectedIds: {
    type: Set,
    default: () => new Set()
  },
  /**
   * For each channel in more than one profile, the names of its profiles
   * @type {import('vue').PropType<Map<string, string[]>>}
   */
  duplicateProfiles: {
    type: Map,
    default: () => new Map()
  },
  /**
   * The callout colour of each channel duplicated across the open columns
   * @type {import('vue').PropType<Map<string, number>>}
   */
  calloutColours: {
    type: Map,
    default: () => new Map()
  }
})

const emit = defineEmits(['thumbnail-error', 'drag-start', 'drop-channels', 'select', 'remove-here', 'keep-here'])

const headingId = useId()

/** Rows drawn before any scrolling: a tall window's worth, with some to spare. */
const FIRST_BATCH = 60
const NEXT_BATCH = 120

const drawLimit = ref(FIRST_BATCH)

const drawnChannels = computed(() => props.channels.slice(0, drawLimit.value))

const body = useTemplateRef('body')

// Otherwise a search cleared after scrolling far down would draw every row
// scrolled past in one go, and on a column of thousands that is a long wait
watch(() => props.resetKey, () => {
  drawLimit.value = FIRST_BATCH

  if (body.value) {
    body.value.scrollTop = 0
  }
})

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged, copy) => emit('drop-channels', dragged, copy),
  // A copy into the pool means nothing: the pool is where no profile has it
  canCopy: () => !props.isPool
})

/**
 * @param {boolean} isVisible
 */
function drawMore(isVisible) {
  if (isVisible) {
    drawLimit.value += NEXT_BATCH
  }
}
</script>

<style scoped src="./ChannelsOverviewColumn.css" />
