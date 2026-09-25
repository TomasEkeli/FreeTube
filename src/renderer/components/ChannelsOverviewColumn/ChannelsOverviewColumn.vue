<!--
  One column of the Channels overview: a profile's channels, or the pool of
  channels no profile has claimed.

  A column can hold a couple of thousand channels, and drawing them all at once
  is what made the old channel list slow to open. So it draws the first
  screenful and a little more, and each time the end of what it has drawn
  scrolls into view it draws the next batch. The marker at the end is keyed on
  how many are drawn, so a batch that still leaves the end in view triggers the
  next one as soon as it lands.
-->
<template>
  <section
    class="column"
    :class="{ pool: isPool, dropTarget: dragOver }"
    :aria-labelledby="headingId"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
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
    <div class="columnBody">
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
        @thumbnail-error="emit('thumbnail-error', $event)"
        @drag-start="(event, channel) => emit('drag-start', event, channel)"
        @select="(extend) => emit('select', channel, extend)"
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
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'

import ChannelsOverviewTile from '../ChannelsOverviewTile/ChannelsOverviewTile.vue'

import { acceptChannelDrag, isCopyDrop, readChannelDrag } from '../../helpers/channelDragAndDrop'

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
  /** @type {import('vue').PropType<Set<string>>} */
  selectedIds: {
    type: Set,
    default: () => new Set()
  }
})

const emit = defineEmits(['thumbnail-error', 'drag-start', 'drop-channels', 'select'])

const headingId = useId()

/** Rows drawn before any scrolling: a tall window's worth, with some to spare. */
const FIRST_BATCH = 60
const NEXT_BATCH = 120

const drawLimit = ref(FIRST_BATCH)

const drawnChannels = computed(() => props.channels.slice(0, drawLimit.value))

const dragOver = ref(false)

/**
 * How many of the column's elements the drag is over. Moving from one row on
 * to the next enters the next before leaving the last, so the column is only
 * left once this is back to zero.
 */
let dragDepth = 0

/**
 * @param {DragEvent} event
 */
function onDragEnter(event) {
  // A copy into the pool means nothing: the pool is where no profile has it
  if (acceptChannelDrag(event, !props.isPool)) {
    dragDepth++
    dragOver.value = true
  }
}

/**
 * @param {DragEvent} event
 */
function onDragOver(event) {
  acceptChannelDrag(event, !props.isPool)
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)

  if (dragDepth === 0) {
    dragOver.value = false
  }
}

/** A drag given up with Escape, or dropped somewhere else, ends the highlight too. */
function endDrag() {
  dragDepth = 0
  dragOver.value = false
}

onMounted(() => document.addEventListener('dragend', endDrag))
onBeforeUnmount(() => document.removeEventListener('dragend', endDrag))

/**
 * @param {DragEvent} event
 */
function onDrop(event) {
  endDrag()

  const dragged = readChannelDrag(event)

  if (dragged.length === 0) { return }

  event.preventDefault()
  emit('drop-channels', dragged, isCopyDrop(event))
}

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
