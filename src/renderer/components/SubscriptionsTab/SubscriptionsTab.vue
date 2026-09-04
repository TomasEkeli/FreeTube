<template>
  <p
    v-if="unavailableMessage"
    class="message"
  >
    {{ unavailableMessage }}
  </p>
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

import SubscriptionsTabUi from '../SubscriptionsTabUi/SubscriptionsTabUi.vue'

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

/**
 * Why this feed cannot be fetched right now, or empty if it can.
 *
 * Computed rather than decided once, because the setting that makes a feed
 * unavailable can be changed while its tab is open, and the tab is not rebuilt
 * when it is.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const unavailableMessage = computed(() => {
  if (subscriptionFeedIsAvailable(props.feed)) { return '' }

  return descriptor.unavailableMessage?.(t) ?? ''
})

const {
  isLoading,
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  refresh
} = useSubscriptionFeed(props.feed)
</script>

<style scoped src="./SubscriptionsTab.css" />
