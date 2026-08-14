<template>
  <SubscriptionsTabUi
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
import SubscriptionsTabUi from './SubscriptionsTabUi/SubscriptionsTabUi.vue'

import { useSubscriptionFeed } from '../composables/useSubscriptionFeed'
import { useSubscriptionFeedTitle } from '../composables/useSubscriptionFeedTitle'

import { subscriptionFeedDescriptor } from '../helpers/subscriptionFeeds'

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
  lastRefreshTimestamp,
  refresh
} = useSubscriptionFeed(props.feed)
</script>
