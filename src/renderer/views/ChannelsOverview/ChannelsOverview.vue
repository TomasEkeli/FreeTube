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
          :match-counts="matchCounts"
          :duplicate-counts="duplicateCountsByProfile"
          @toggle="toggleColumn"
          @drop-channels="fileChannelsFromPalette"
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
        <FtInput
          ref="searchInput"
          class="channelSearch"
          :placeholder="t('Channels.Search bar placeholder')"
          :value="query"
          :show-clear-text-button="true"
          :show-action-button="false"
          :maxlength="255"
          @input="(value) => query = value"
          @clear="query = ''"
        />
        <FtButton
          :label="searching ? t('Channels.Overview.Select All Matches') : t('Channels.Overview.Select All')"
          @click="selectAllShown"
        />
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
        <ChannelsOverviewTrash
          v-if="!hideUnsubscribeButton"
          class="trash"
          @drop-channels="askToUnsubscribe"
        />
      </div>
      <div class="columns">
        <ChannelsOverviewColumn
          v-for="column in columns"
          :key="column.profile?._id ?? 'pool'"
          :class="{ poolColumn: column.profile === null }"
          :is-pool="column.profile === null"
          :title="column.profile?.name ?? t('Channels.Overview.Unassigned')"
          :count-label="countLabel(column)"
          :empty-label="searching ? t('Channels.Overview.No Matches') : t('Channels.Overview.Empty Profile')"
          :background-color="column.profile?.bgColor"
          :text-color="column.profile?.textColor"
          :channels="column.channels"
          :selected-ids="selection.get(column.id)"
          :duplicate-profiles="duplicateProfiles"
          :callout-colours="calloutColours"
          @thumbnail-error="updateThumbnail"
          @select="(channel, extend) => selectChannel(column, channel, extend)"
          @drag-start="(event, channel) => dragChannel(event, channel, column.id)"
          @drop-channels="(dragged, copy) => fileChannels(dragged, column.id, copy)"
          @remove-here="(channel) => removeDuplicate(channel, column.id)"
          @keep-here="(channel) => keepOnlyIn(channel, column.id)"
        />
        <p
          v-if="openColumns.length === 0 && profiles.length > 0"
          class="message columnsHint"
        >
          {{ t('Channels.Overview.Open a Profile') }}
        </p>
      </div>
    </template>
    <FtPrompt
      v-if="unsubscribeChannelIds.length > 0"
      :label="t('Channels.Overview.Unsubscribe Prompt', { count: unsubscribeChannelIds.length }, unsubscribeChannelIds.length)"
      :extra-labels="[t('Channels.Overview.Unsubscribe Prompt Detail')]"
      :option-names="[t('Channel.Unsubscribe'), t('Cancel')]"
      :option-values="['unsubscribe', 'cancel']"
      :is-first-option-destructive="true"
      @click="handleUnsubscribePrompt"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtPrompt from '../../components/FtPrompt/FtPrompt.vue'
import ChannelsOverviewColumn from '../../components/ChannelsOverviewColumn/ChannelsOverviewColumn.vue'
import ChannelsOverviewPalette from '../../components/ChannelsOverviewPalette/ChannelsOverviewPalette.vue'
import ChannelsOverviewTrash from '../../components/ChannelsOverviewTrash/ChannelsOverviewTrash.vue'

import store from '../../store/index'
import { invidiousGetChannelInfo } from '../../helpers/api/invidious'
import { getLocalChannel, parseLocalChannelHeader } from '../../helpers/api/local'
import { startChannelDrag } from '../../helpers/channelDragAndDrop'
import { ctrlFHandler, deepCopy, showToast } from '../../helpers/utils'
import {
  assignCalloutColours,
  channelMemberships,
  duplicateCounts,
  filterChannels,
  isSelected,
  nonPrimaryProfiles,
  normaliseQuery,
  planTransfer,
  planUnsubscribe,
  primaryProfile,
  profilesOutsideHome,
  pruneSelection,
  restoreOpenProfiles,
  selectAll,
  selectedChannels,
  selectionAfterTransfer,
  selectionSize,
  selectRange,
  sortChannels,
  sortColumn,
  toggleOpenProfile,
  toggleSelected,
  unassignedChannels,
  uniqueChannels,
} from '../../helpers/channelsOverview'

/** @import { Profile, Channel } from '../../helpers/channelsOverview' */
/** @import { DraggedChannel } from '../../helpers/channelDragAndDrop' */

const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()

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
 * @property {Channel[]} channels shown, in the order shown
 * @property {Channel[]} [allChannels] every channel in the column, shown or not
 * @property {number} total how many channels the column has, shown or not
 */

/**
 * The search over the columns. Deliberately not kept anywhere: it is gone on
 * leaving the page.
 */
const query = ref('')

const normalisedQuery = computed(() => normaliseQuery(query.value))

const searching = computed(() => normalisedQuery.value !== '')

/** @type {import('vue').ComputedRef<Column[]>} */
const openColumns = computed(() => {
  return openProfileIds.value
    .map(id => profiles.value.find(profile => profile._id === id))
    .map(profile => {
      const channels = sortColumn(uniqueChannels(profile.subscriptions), memberships.value, collator.value)

      return {
        id: profile._id,
        profile,
        channels: filterChannels(channels, normalisedQuery.value),
        allChannels: channels,
        total: channels.length
      }
    })
})

/**
 * Everything drawn, pool first. The pool is left out once it is empty, and
 * with it the one place to drop a channel out of every profile. A search that
 * matches nothing in it leaves it in place, as it still has channels.
 * @type {import('vue').ComputedRef<Column[]>}
 */
const columns = computed(() => {
  if (pool.value.length === 0) {
    return openColumns.value
  }

  const poolColumn = {
    id: null,
    profile: null,
    channels: filterChannels(pool.value, normalisedQuery.value),
    total: pool.value.length
  }

  return [poolColumn, ...openColumns.value]
})

/**
 * The names of every profile each duplicated channel is in, for the mark on
 * its rows. Only channels in more than one profile have an entry.
 * @type {import('vue').ComputedRef<Map<string, string[]>>}
 */
const duplicateProfiles = computed(() => {
  const names = new Map(profiles.value.map(profile => [profile._id, profile.name]))
  const duplicates = new Map()

  for (const [channelId, profileIds] of memberships.value) {
    if (profileIds.length > 1) {
      duplicates.set(channelId, profileIds.map(id => names.get(id)))
    }
  }

  return duplicates
})

/**
 * Callout colours for the channels duplicated across the open columns. Taken
 * from the columns in full, so a search does not change a channel's colour.
 */
const calloutColours = computed(() => {
  return assignCalloutColours(openColumns.value.map(column => column.allChannels.map(channel => channel.id)))
})

const duplicateCountsByProfile = computed(() => duplicateCounts(profileList.value, memberships.value))

/**
 * How many channels in each profile match the search, so that a profile whose
 * column is closed still shows it has something. Null while not searching.
 * @type {import('vue').ComputedRef<Map<string, number> | null>}
 */
const matchCounts = computed(() => {
  if (!searching.value) { return null }

  return new Map(profiles.value.map(profile => {
    return [profile._id, filterChannels(uniqueChannels(profile.subscriptions), normalisedQuery.value).length]
  }))
})

/**
 * @param {Column} column
 * @returns {string}
 */
function countLabel(column) {
  const shown = column.channels.length

  if (column.profile === null) {
    return searching.value
      ? t('Channels.Overview.Unassigned Match Count', { matches: shown, count: column.total }, column.total)
      : t('Channels.Overview.Unassigned Count', { count: column.total }, column.total)
  }

  return searching.value
    ? t('Channels.Overview.Match Count', { matches: shown, count: column.total })
    : String(column.total)
}

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

/** Everything shown: with a search, exactly the matches in the open columns. */
function selectAllShown() {
  selection.value = selectAll(selection.value, new Map(columns.value.map(column => {
    return [column.id, column.channels.map(channel => channel.id)]
  })))
}

function clearSelection() {
  selection.value = new Map()
  selectionAnchors.clear()
}

const searchInput = useTemplateRef('searchInput')

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  ctrlFHandler(event, searchInput.value)

  if (event.key === 'Escape' && selectedCount.value > 0 && !event.defaultPrevented) {
    clearSelection()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))

/**
 * A link here can ask for a profile's column to be open, as the one from that
 * profile's settings does. The request is taken off the address once met, so
 * that closing the column afterwards sticks.
 */
watch(() => route.query.open, (profileId) => {
  if (typeof profileId !== 'string' || profileId === '') { return }

  if (profiles.value.some(profile => profile._id === profileId) && !openProfileIds.value.includes(profileId)) {
    saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
  }

  router.replace({ query: { ...route.query, open: undefined } })
}, { immediate: true })

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

/**
 * A drop on a bubble does what a drop on its column does. The column may not
 * be open to show the channels arriving, so a toast says what happened.
 * @param {string} profileId
 * @param {DraggedChannel[]} dragged
 * @param {boolean} copy
 */
async function fileChannelsFromPalette(profileId, dragged, copy) {
  const profile = profiles.value.find(profile => profile._id === profileId)

  if (!profile) { return }

  const arriving = new Set(dragged.filter(channel => channel.profileId !== profileId).map(channel => channel.channelId))

  await fileChannels(dragged, profileId, copy)

  if (arriving.size === 0) {
    showToast(t('Channels.Overview.Already in Profile', { profile: profile.name }))
  } else if (copy) {
    showToast(t('Channels.Overview.Copied to Profile', { count: arriving.size, profile: profile.name }, arriving.size))
  } else {
    showToast(t('Channels.Overview.Moved to Profile', { count: arriving.size, profile: profile.name }, arriving.size))
  }
}

/**
 * Takes a duplicated channel out of this one profile, leaving it in the rest.
 * @param {Channel} channel
 * @param {string} profileId
 */
function removeDuplicate(channel, profileId) {
  store.dispatch('removeChannelFromProfiles', { channelId: channel.id, profileIds: [profileId] })
}

/**
 * Makes this profile a duplicated channel's only one, apart from the primary
 * profile: out of every other in one removal.
 * @param {Channel} channel
 * @param {string} homeProfileId
 */
function keepOnlyIn(channel, homeProfileId) {
  const profileIds = profilesOutsideHome(memberships.value, channel.id, homeProfileId)

  if (profileIds.length > 0) {
    store.dispatch('removeChannelFromProfiles', { channelId: channel.id, profileIds })
  }
}

/**
 * The trash follows the setting that hides the unsubscribe button everywhere
 * else, as unsubscribing is all it does.
 */
const hideUnsubscribeButton = computed(() => store.getters.getHideUnsubscribeButton)

/**
 * The channels a drop on the trash wants unsubscribed from, waiting on the
 * prompt. Empty while no prompt is showing.
 * @type {import('vue').ShallowRef<string[]>}
 */
const unsubscribeChannelIds = shallowRef([])

/**
 * @param {DraggedChannel[]} dragged
 */
function askToUnsubscribe(dragged) {
  unsubscribeChannelIds.value = [...new Set(dragged.map(channel => channel.channelId))]
}

/**
 * Unsubscribes the way the subscribe button does, one removal per channel
 * covering every profile it is in, so it leaves them all at once and other
 * windows hear of it. Cancelling leaves everything as it was, the selection
 * included.
 * @param {'unsubscribe' | 'cancel' | null} value
 */
async function handleUnsubscribePrompt(value) {
  const channelIds = unsubscribeChannelIds.value
  unsubscribeChannelIds.value = []

  if (value !== 'unsubscribe') { return }

  const removals = planUnsubscribe(profileList.value, channelIds)

  await Promise.all(removals.map(removal => store.dispatch('removeChannelFromProfiles', removal)))

  showToast(t('Channels.Overview.Unsubscribed', { count: removals.length }, removals.length))
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
