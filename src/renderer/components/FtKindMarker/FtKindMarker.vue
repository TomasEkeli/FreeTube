<!--
  The one marker language for card kinds.

  A card that carries no marker is a plain video: only the kinds that are not
  the default get one, so the marker means something wherever it appears. An
  icon alone would not, hence icon *and* text.
-->
<template>
  <div
    class="kindMarker"
    :class="kind"
  >
    <FontAwesomeIcon
      class="kindMarkerIcon"
      :icon="icon"
      aria-hidden="true"
    />
    <span class="kindMarkerLabel">{{ label }}</span>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  /** @type {import('vue').PropType<'shorts' | 'live' | 'upcoming' | 'post'>} */
  kind: {
    type: String,
    required: true,
    // Spelled out rather than read off the map below, because `defineProps` is
    // compiled away and may not reach for anything declared in this block.
    validator: (value) => ['shorts', 'live', 'upcoming', 'post'].includes(value)
  }
})

const { t } = useI18n()

/**
 * The icons are the ones the subscriptions feeds already answer to, so a kind
 * looks the same whether it is being chosen in the feed's controls or read off
 * a card.
 */
const ICONS = {
  shorts: ['fas', 'clapperboard'],
  live: ['fas', 'tower-broadcast'],
  upcoming: ['fas', 'clock'],
  post: ['fas', 'message']
}

const icon = computed(() => ICONS[props.kind])

// One `t` call per kind, spelled out: the i18n lint reads these keys statically
// to know they exist, and a key it computed would not be checked at all.
const label = computed(() => {
  switch (props.kind) {
    case 'shorts':
      return t('Global.Kind Marker.Short')
    case 'live':
      return t('Global.Kind Marker.Live')
    case 'upcoming':
      return t('Global.Kind Marker.Upcoming')
    case 'post':
      return t('Global.Kind Marker.Post')
    default:
      return ''
  }
})
</script>

<style scoped src="./FtKindMarker.scss" lang="scss" />
