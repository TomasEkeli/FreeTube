<template>
  <div
    v-if="showUnavailable"
    class="unavailable"
  >
    <p class="message">
      {{ unavailableMessage }}
    </p>
    <FtButton
      v-if="unavailableActionLabel"
      :label="unavailableActionLabel"
      @click="refreshThisFeed"
    />
  </div>
  <SubscriptionsTabUi
    v-else
    :is-loading="isLoading"
    :is-refreshing="isRefreshing"
    :video-list="entryList"
    :error-channels="errorChannels"
    :attempted-fetch="attemptedFetch"
    :last-refresh-timestamp="lastRefreshTimestamp"
    :is-community="descriptor.isCommunity === true"
    :initial-data-limit="descriptor.initialDataLimit ?? 100"
    :backfill-feed="descriptor.followsDetailBackfill ? feed : ''"
    :title="subscriptionFeedTitle(feed)"
    @refresh="refresh"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'
import SubscriptionsTabUi from '../SubscriptionsTabUi/SubscriptionsTabUi.vue'

import store from '../../store/index'

import { useSubscriptionFeed } from '../../composables/useSubscriptionFeed'
import { useSubscriptionFeedTitle } from '../../composables/useSubscriptionFeedTitle'

import { subscriptionFeedDescriptor, subscriptionFeedIsAvailable } from '../../helpers/subscriptionFeeds'

/**
 * One subscription feed's tab.
 *
 * There were four of these, one per feed, each carrying its own copy of the
 * fetch ladders. The ladders had to move to module scope — a refresh now covers
 * feeds whose tabs are not mounted, and a fetch function that only exists while
 * its tab is on screen cannot be used to fetch it — and once they had, the four
 * components were the same component with a different string in it.
 */
const props = defineProps({
  feed: {
    type: String,
    required: true
  }
})

const { t } = useI18n()

const subscriptionFeedTitle = useSubscriptionFeedTitle()

// The feed never changes under one instance: the view keys the component by it,
// so switching tabs mounts a different one
const descriptor = subscriptionFeedDescriptor(props.feed)

const {
  isLoading,
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  cacheHasAnyEntriesForActiveProfile,
  lastRefreshTimestamp,
  refresh,
  refreshThisFeed
} = useSubscriptionFeed(props.feed)

/**
 * Why no automatic refresh will fetch this feed right now, or empty when they
 * will. Not why it cannot be fetched: the button below says otherwise.
 *
 * Computed rather than decided once, because the setting that makes a feed
 * unavailable can be changed while its tab is open, from an other window.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const unavailableMessage = computed(() => {
  if (subscriptionFeedIsAvailable(props.feed)) { return '' }

  return descriptor.unavailableMessage?.(t) ?? ''
})

/**
 * What to put on the button that fetches this feed anyway, or empty when the
 * feed offers no such button.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const unavailableActionLabel = computed(() => {
  if (unavailableMessage.value === '') { return '' }

  return descriptor.unavailableActionLabel?.(t) ?? ''
})

const activeProfileHasSubscriptions = computed(() => {
  return store.getters.getActiveProfile.subscriptions.length > 0
})

/**
 * Whether to explain the feed instead of showing it.
 *
 * Being unavailable is not enough on its own. Posts fetched once are in the
 * cache and stay there, and a tab holding a readable feed should show it and
 * its refresh widget rather than an explanation of a setting.
 *
 * The cache is asked whether it holds anything, rather than the list being
 * checked for emptiness. A fetch that succeeded and found no posts caches an
 * empty array for every channel, which is a real answer and leaves the list
 * empty; treating that as never-fetched would put the panel back up and make
 * the button look broken. `SubscriptionsTabUi` has the right words for that
 * case already.
 *
 * A profile with no subscriptions also has the panel taken away from it: a
 * button that fetches nothing from nobody is worse than the tab's own
 * empty-list message.
 *
 * Loading and refreshing keep it away too, so the loader in
 * `SubscriptionsTabUi` is what a press of the button produces. A fetch that
 * fails for every channel caches nothing, so the panel comes back and can be
 * pressed again; those failures are reported by the toast the refresh already
 * shows, not by the error-channel bubbles, which live inside the component
 * this branch replaces.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const showUnavailable = computed(() => {
  return unavailableMessage.value !== '' &&
    !cacheHasAnyEntriesForActiveProfile.value &&
    activeProfileHasSubscriptions.value &&
    !isLoading.value &&
    !isRefreshing.value
})
</script>

<style scoped src="./SubscriptionsTab.css" />
