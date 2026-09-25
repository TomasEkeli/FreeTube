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
    :class="{ pool: isPool }"
    :aria-labelledby="headingId"
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
        @thumbnail-error="emit('thumbnail-error', $event)"
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
import { computed, ref, useId } from 'vue'

import ChannelsOverviewTile from '../ChannelsOverviewTile/ChannelsOverviewTile.vue'

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
  }
})

const emit = defineEmits(['thumbnail-error'])

const headingId = useId()

/** Rows drawn before any scrolling: a tall window's worth, with some to spare. */
const FIRST_BATCH = 60
const NEXT_BATCH = 120

const drawLimit = ref(FIRST_BATCH)

const drawnChannels = computed(() => props.channels.slice(0, drawLimit.value))

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
