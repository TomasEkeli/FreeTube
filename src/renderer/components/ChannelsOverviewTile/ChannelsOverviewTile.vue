<!--
  One channel in a column of the Channels overview.

  A square: the thumbnail large enough to know the channel by, and its name
  under it. Nothing else about the channel. The page is for sorting channels
  into profiles, and what a channel has uploaded lately is a question for
  another page.

  A channel in more than one profile has a mark in its corner saying which.
  Where its twin is in an other open column as well, both share a callout
  colour, ringing the thumbnail, so the pair can be matched at a glance.

  Clicking the square selects it, and Shift-click selects everything from
  the last one clicked; Space and Enter do the same from the keyboard. A
  double click goes to the channel, as does the icon in the top corner, so a
  single stray click while sorting never navigates. The mark on a duplicate
  opens a menu of the two ways out of being one, and right-clicking the
  square opens a menu with everything that can be done to the one channel.

  In a proposed column, hovering says why the channel is suggested there, and
  a channel suggested out of the profile it is in now has a badge in that
  profile's colour, naming it.
-->
<template>
  <div
    class="tile"
    :class="[{ dragging, selected }, callout === null ? null : `callout callout${callout}`]"
    draggable="true"
    @dragstart="onDragStart"
    @dragend="dragging = false"
    @contextmenu.prevent="emit('context-menu', $event, channel)"
  >
    <!--
      The checkbox is the thumbnail and the name, filling the square, with
      the two buttons laid over its corners. The square itself cannot be it:
      a checkbox hides whatever is inside it from a screen reader, buttons
      and all.
    -->
    <span
      class="selectArea"
      role="checkbox"
      tabindex="0"
      :aria-checked="selected ? 'true' : 'false'"
      :aria-label="channel.name"
      :aria-description="description"
      :title="evidence === null ? null : tooltip"
      @click="emit('select', $event.shiftKey)"
      @dblclick="goToChannel"
      @keydown.space.enter.prevent="emit('select', $event.shiftKey)"
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
        <!-- Drawn in CSS and only shown or hidden, as selecting a whole column
             would otherwise build and tear down an icon in every row -->
        <span
          v-show="selected"
          class="selectedMark"
        />
      </span>
      <span
        class="name"
        dir="auto"
        :title="tooltip"
      >
        {{ channel.name }}
      </span>
      <span
        v-if="badge !== null"
        class="badge"
        dir="auto"
        :style="{ background: badge.bgColor, color: badgeTextColor }"
      >
        {{ badge.label }}
      </span>
    </span>
    <span
      v-if="duplicateProfiles !== null"
      class="corner duplicateMark"
    >
      <ChannelsOverviewMenuButton
        :label="duplicateTitle"
        :items="duplicateMenuItems"
        @choose="(value) => value === 'remove-here' ? emit('remove-here', channel) : emit('keep-here', channel)"
      >
        <FontAwesomeIcon :icon="['fas', 'clone']" />
      </ChannelsOverviewMenuButton>
    </span>
    <!-- A plain link that hands a plain click to the router, as a
         RouterLink would: a RouterLink in each of a few thousand rows is a
         lot of routing to work out while scrolling -->
    <a
      v-if="showChannelLink"
      class="corner channelLink"
      :href="`#/channel/${channel.id}`"
      :title="channelLinkLabel"
      :aria-label="channelLinkLabel"
      draggable="false"
      @click.stop="openChannel"
    >
      <FontAwesomeIcon :icon="['fas', 'arrow-up-right-from-square']" />
    </a>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import ChannelsOverviewMenuButton from '../ChannelsOverviewMenuButton/ChannelsOverviewMenuButton.vue'

import store from '../../store/index'
import { invidiousImageUrlToInvidious, youtubeImageUrlToInvidious } from '../../helpers/api/invidious'
import { calculateColorLuminance } from '../../helpers/colors'

const props = defineProps({
  /** @type {import('vue').PropType<import('../../helpers/channelsOverview').Channel>} */
  channel: {
    type: Object,
    required: true
  },
  selected: {
    type: Boolean,
    default: false
  },
  /**
   * Every profile the channel is in, by name, when that is more than one;
   * null otherwise.
   * @type {import('vue').PropType<string[] | null>}
   */
  duplicateProfiles: {
    type: Array,
    default: null
  },
  /** The callout colour shared with its twins in the other open columns, if any */
  callout: {
    type: Number,
    default: null
  },
  /**
   * In a proposed column, the profile a suggested move takes it out of
   * @type {import('vue').PropType<{ label: string, bgColor: string } | null>}
   */
  badge: {
    type: Object,
    default: null
  },
  /** In a proposed column, why it is suggested there */
  evidence: {
    type: String,
    default: null
  }
})

/** The name, and in a proposed column why it is there, on a line of its own */
const tooltip = computed(() => {
  return props.evidence === null ? props.channel.name : `${props.channel.name}\n${props.evidence}`
})

/** What a screen reader hears besides the name: the badge and the reason */
const description = computed(() => {
  const parts = [props.badge?.label, props.evidence].filter(part => typeof part === 'string' && part !== '')

  return parts.length > 0 ? parts.join('. ') : null
})

const badgeTextColor = computed(() => props.badge ? calculateColorLuminance(props.badge.bgColor) : null)

const emit = defineEmits(['thumbnail-error', 'drag-start', 'select', 'remove-here', 'keep-here', 'context-menu'])

const dragging = ref(false)

/**
 * @param {DragEvent} event
 */
function onDragStart(event) {
  dragging.value = true
  emit('drag-start', event, props.channel)
}

const { locale, t } = useI18n()

const router = useRouter()

/**
 * Through the router, so that coming back finds the page where it was left.
 * A click with a modifier, or not the main button, is left to the link.
 * @param {MouseEvent} event
 */
function openChannel(event) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) { return }

  event.preventDefault()
  router.push(`/channel/${props.channel.id}`)
}

/**
 * A double click goes to the channel, as it opens a file where a click only
 * selects it. Its two clicks have toggled the selection and back again.
 */
function goToChannel() {
  if (showChannelLink.value) {
    router.push(`/channel/${props.channel.id}`)
  }
}

const channelLinkLabel = computed(() => t('Channels.Overview.Go to channel', { channelName: props.channel.name }))

const duplicateMenuItems = computed(() => [
  { value: 'remove-here', label: t('Channels.Overview.Remove This Duplicate') },
  { value: 'keep-here', label: t('Channels.Overview.Keep Here Only') }
])

const duplicateTitle = computed(() => {
  if (props.duplicateProfiles === null) { return '' }

  const profiles = new Intl.ListFormat([locale.value, 'en'], { type: 'conjunction' }).format(props.duplicateProfiles)

  return t('Channels.Overview.In Profiles', { profiles })
})

const showChannelLink = computed(() => !store.getters.getDisableChannelLinks)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

/** Twice the size it is shown at, for screens with twice the pixels */
const THUMBNAIL_SIZE = 176

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
