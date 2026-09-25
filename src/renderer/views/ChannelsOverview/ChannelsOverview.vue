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
      <div class="columns">
        <ChannelsOverviewColumn
          v-if="pool.length > 0"
          key="pool"
          class="poolColumn"
          is-pool
          :title="t('Channels.Overview.Unassigned')"
          :count-label="t('Channels.Overview.Unassigned Count', { count: pool.length }, pool.length)"
          :channels="pool"
          @thumbnail-error="updateThumbnail"
        />
        <ChannelsOverviewColumn
          v-for="column in openColumns"
          :key="column.profile._id"
          :title="column.profile.name"
          :count-label="String(column.channels.length)"
          :empty-label="t('Channels.Overview.Empty Profile')"
          :background-color="column.profile.bgColor"
          :text-color="column.profile.textColor"
          :channels="column.channels"
          @thumbnail-error="updateThumbnail"
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
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import ChannelsOverviewColumn from '../../components/ChannelsOverviewColumn/ChannelsOverviewColumn.vue'
import ChannelsOverviewPalette from '../../components/ChannelsOverviewPalette/ChannelsOverviewPalette.vue'

import store from '../../store/index'
import { invidiousGetChannelInfo } from '../../helpers/api/invidious'
import { getLocalChannel, parseLocalChannelHeader } from '../../helpers/api/local'
import {
  channelMemberships,
  nonPrimaryProfiles,
  primaryProfile,
  restoreOpenProfiles,
  sortChannels,
  toggleOpenProfile,
  unassignedChannels,
  uniqueChannels,
} from '../../helpers/channelsOverview'

/** @import { Profile, Channel } from '../../helpers/channelsOverview' */

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

const openColumns = computed(() => {
  return openProfileIds.value
    .map(id => profiles.value.find(profile => profile._id === id))
    .map(profile => ({
      profile,
      channels: sortChannels(uniqueChannels(profile.subscriptions), collator.value)
    }))
})

/**
 * @param {string} profileId
 */
function toggleColumn(profileId) {
  saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
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
