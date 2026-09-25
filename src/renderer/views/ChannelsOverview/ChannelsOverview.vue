<!--
  The Channels page: where subscriptions are sorted into profiles.

  Every profile is a bubble in the strip at the top, and a few of them at a
  time are open as columns below. The primary profile is never a column, as it
  holds every subscription. Its place, pinned leftmost, goes to the channels no
  other profile has claimed, and that column is there to be emptied: once it
  is, it goes away, and it only comes back when something new lands in it.
-->
<template>
  <div class="channelsOverview">
    <h2 class="visuallyHidden">
      {{ t('Channels.Title') }}
    </h2>
    <FtCard
      v-if="allChannels.length === 0"
      class="emptyCard"
    >
      <p class="message">
        {{ t('Channels.Empty') }}
      </p>
    </FtCard>
    <template v-else>
      <FtCard class="paletteCard">
        <ChannelsOverviewPalette
          v-if="profiles.length > 0"
          :profiles="profiles"
          :open-profile-ids="openProfileIds"
          @toggle="toggleColumn"
        />
        <p
          v-else
          class="message"
        >
          {{ t('Channels.Overview.No Profiles') }}
          <RouterLink to="/settings/profile">
            {{ t('Channels.Overview.Create Profiles') }}
          </RouterLink>
        </p>
      </FtCard>
      <div
        class="toolbar"
        role="toolbar"
        :aria-label="t('Channels.Overview.Selection')"
      >
        <template v-if="selectedCount > 0">
          <span
            class="selectedCount"
            aria-live="polite"
          >
            {{ t('Channels.Overview.Selected Count', { count: selectedCount }, selectedCount) }}
          </span>
          <FtButton
            :label="t('Channels.Overview.Clear Selection')"
            @click="clearSelection"
          />
        </template>
        <span
          v-else
          class="toolbarHint"
        >
          {{ t('Channels.Overview.Selection Hint') }}
        </span>
      </div>
      <div class="columns">
        <ChannelsOverviewColumn
          v-for="column in columns"
          :key="column.profile?._id ?? 'pool'"
          :class="{ poolColumn: column.profile === null }"
          :is-pool="column.profile === null"
          :title="column.profile?.name ?? t('Channels.Overview.Unassigned')"
          :count-label="column.profile === null
            ? t('Channels.Overview.Unassigned Count', { count: column.channels.length }, column.channels.length)
            : String(column.channels.length)"
          :empty-label="t('Channels.Overview.Empty Profile')"
          :background-color="column.profile?.bgColor"
          :text-color="column.profile?.textColor"
          :channels="column.channels"
          :selected-ids="selection.get(column.id)"
          @thumbnail-error="updateThumbnail"
          @select="(channel, extend) => selectChannel(column, channel, extend)"
          @drag-start="(event, channel) => dragChannel(event, channel, column.id)"
          @drop-channels="(dragged, copy) => fileChannels(dragged, column.id, copy)"
        />
        <p
          v-if="openColumns.length === 0 && profiles.length > 0"
          class="message columnsHint"
        >
          {{ t('Channels.Overview.Open a Profile') }}
        </p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import ChannelsOverviewColumn from '../../components/ChannelsOverviewColumn/ChannelsOverviewColumn.vue'
import ChannelsOverviewPalette from '../../components/ChannelsOverviewPalette/ChannelsOverviewPalette.vue'

import store from '../../store/index'
import { invidiousGetChannelInfo } from '../../helpers/api/invidious'
import { getLocalChannel, parseLocalChannelHeader } from '../../helpers/api/local'
import { startChannelDrag } from '../../helpers/channelDragAndDrop'
import { deepCopy } from '../../helpers/utils'
import {
  channelMemberships,
  isSelected,
  nonPrimaryProfiles,
  planTransfer,
  primaryProfile,
  pruneSelection,
  restoreOpenProfiles,
  selectedChannels,
  selectionAfterTransfer,
  selectionSize,
  selectRange,
  sortChannels,
  toggleOpenProfile,
  toggleSelected,
  unassignedChannels,
  uniqueChannels,
} from '../../helpers/channelsOverview'

/** @import { Profile, Channel } from '../../helpers/channelsOverview' */
/** @import { DraggedChannel } from '../../helpers/channelDragAndDrop' */

const { locale, t } = useI18n()

/** @type {import('vue').ComputedRef<Profile[]>} */
const profileList = computed(() => store.getters.getProfileList)

/** @type {import('vue').ComputedRef<Profile[]>} */
const profiles = computed(() => nonPrimaryProfiles(profileList.value))

/** @type {import('vue').ComputedRef<Channel[]>} */
const allChannels = computed(() => primaryProfile(profileList.value)?.subscriptions ?? [])

const collator = computed(() => new Intl.Collator([locale.value, 'en'], { sensitivity: 'base', numeric: true }))

const memberships = computed(() => channelMemberships(profileList.value))

/** @type {import('vue').ComputedRef<Channel[]>} */
const pool = computed(() => sortChannels(unassignedChannels(profileList.value, memberships.value), collator.value))

/**
 * The open columns. Saved as a setting, so they survive leaving the page and
 * restarting the app, and follow along in any other window.
 *
 * The page keeps its own copy and saves it: the setting only changes once the
 * database has the value, and a second click before then would toggle the
 * value from before the first. Changes to the setting are taken up only while
 * nothing is being saved from here, so the page never falls back to one of
 * its own earlier values.
 * @type {import('vue').Ref<unknown>}
 */
const storedOpenProfileIds = ref(store.getters.getChannelsOverviewOpenProfiles)
let openProfileSavesInFlight = 0

watch(() => store.getters.getChannelsOverviewOpenProfiles, (value) => {
  if (openProfileSavesInFlight === 0) {
    storedOpenProfileIds.value = value
  }
})

/** @type {import('vue').ComputedRef<string[]>} */
const openProfileIds = computed(() => restoreOpenProfiles(storedOpenProfileIds.value, profileList.value))

/**
 * @param {string[]} profileIds
 */
async function saveOpenProfileIds(profileIds) {
  storedOpenProfileIds.value = profileIds
  openProfileSavesInFlight++

  try {
    await store.dispatch('updateChannelsOverviewOpenProfiles', profileIds)
  } finally {
    openProfileSavesInFlight--
  }
}

/**
 * @typedef {object} Column
 * @property {string | null} id the profile's, or null for the pool
 * @property {Profile | null} profile
 * @property {Channel[]} channels in the order shown
 */

/** @type {import('vue').ComputedRef<Column[]>} */
const openColumns = computed(() => {
  return openProfileIds.value
    .map(id => profiles.value.find(profile => profile._id === id))
    .map(profile => ({
      id: profile._id,
      profile,
      channels: sortChannels(uniqueChannels(profile.subscriptions), collator.value)
    }))
})

/**
 * Everything drawn, pool first. The pool is left out once it is empty, and
 * with it the one place to drop a channel out of every profile.
 * @type {import('vue').ComputedRef<Column[]>}
 */
const columns = computed(() => {
  if (pool.value.length === 0) {
    return openColumns.value
  }

  return [{ id: null, profile: null, channels: pool.value }, ...openColumns.value]
})

/** @type {import('vue').ShallowRef<import('../../helpers/channelsOverview').Selection>} */
const selection = shallowRef(new Map())

/**
 * The last row clicked in each column, where a Shift-click range starts from.
 * @type {Map<string | null, string>}
 */
const selectionAnchors = new Map()

const selectedCount = computed(() => selectionSize(selection.value))

// A channel that leaves its column, or a column that closes, is no longer selected
watch(columns, (columns) => {
  selection.value = pruneSelection(selection.value, new Map(columns.map(column => {
    return [column.id, column.channels.map(channel => channel.id)]
  })))
})

/**
 * @param {Column} column
 * @param {Channel} channel
 * @param {boolean} extend Shift was held: select from the last clicked row
 */
function selectChannel(column, channel, extend) {
  const anchor = selectionAnchors.get(column.id)

  if (extend && anchor !== undefined && anchor !== channel.id) {
    const order = column.channels.map(channel => channel.id)
    selection.value = selectRange(selection.value, column.id, order, anchor, channel.id)
  } else {
    selection.value = toggleSelected(selection.value, column.id, channel.id)
  }

  selectionAnchors.set(column.id, channel.id)
}

function clearSelection() {
  selection.value = new Map()
  selectionAnchors.clear()
}

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  if (event.key === 'Escape' && selectedCount.value > 0 && !event.defaultPrevented) {
    clearSelection()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))

/**
 * @param {string} profileId
 */
function toggleColumn(profileId) {
  saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
}

/**
 * @param {DragEvent} event
 * @param {Channel} channel
 * @param {string | null} profileId the column it is dragged out of, null for the pool
 */
function dragChannel(event, channel, profileId) {
  // A selected row carries the whole selection with it; any other row only itself
  if (isSelected(selection.value, profileId, channel.id)) {
    const dragged = selectedChannels(selection.value)
    const label = dragged.length === 1
      ? channel.name ?? channel.id
      : t('Channels.Overview.Channel Count', { count: dragged.length }, dragged.length)

    startChannelDrag(event, dragged, label)
  } else {
    startChannelDrag(event, [{ channelId: channel.id, profileId }], channel.name ?? channel.id)
  }
}

/**
 * Files dropped channels into a profile, or back into the pool with
 * `targetProfileId` null, saving each changed profile once. Through the
 * store, so the database write happens in the main process and every other
 * window hears about it.
 * @param {DraggedChannel[]} dragged
 * @param {string | null} targetProfileId
 * @param {boolean} copy
 */
async function fileChannels(dragged, targetProfileId, copy) {
  const updated = planTransfer(profileList.value, dragged, targetProfileId, copy)

  if (updated.length === 0) { return }

  const selectionAfter = selectionAfterTransfer(selection.value, dragged, targetProfileId, copy)

  await Promise.all(updated.map(profile => store.dispatch('updateProfile', deepCopy(profile))))

  // Only now, with the channels in their new columns: sooner, and they would
  // be pruned for not being there yet
  selection.value = pruneSelection(selectionAfter, new Map(columns.value.map(column => {
    return [column.id, column.channels.map(channel => channel.id)]
  })))
}

let thumbnailErrorCount = 0

/**
 * A stored thumbnail that no longer loads is fetched again from the channel
 * and saved, as the old channel list did. Spaced out, so that a column full of
 * stale thumbnails does not fire a request for each of them at once.
 * @param {Channel} channel
 */
function updateThumbnail(channel) {
  thumbnailErrorCount += 1

  setTimeout(async () => {
    try {
      let thumbnailUrl

      if (store.getters.getBackendPreference === 'local') {
        const response = await getLocalChannel(channel.id)

        if (response.alert) { return }

        thumbnailUrl = parseLocalChannelHeader(response).thumbnailUrl
      } else {
        const response = await invidiousGetChannelInfo(channel.id)

        thumbnailUrl = response.authorThumbnails[0].url
      }

      store.dispatch('updateSubscriptionDetails', {
        channelThumbnailUrl: thumbnailUrl,
        channelName: channel.name,
        channelId: channel.id
      })
    } catch (error) {
      console.error(error)
    }
  }, thumbnailErrorCount * 500)
}
</script>

<style scoped src="./ChannelsOverview.css" />
