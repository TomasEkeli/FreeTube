<template>
  <div>
    <FtCard class="card">
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'rss']"
          class="subscriptionIcon"
        />
        {{ $t("Subscriptions.Subscriptions") }}
      </h2>
      <SubscriptionsTabUi
        v-if="anyFeedEnabled"
        :is-loading="isLoading"
        :is-refreshing="isRefreshing"
        :video-list="entryList"
        :error-channels="errorChannels"
        :attempted-fetch="attemptedFetch"
        :last-refresh-timestamp="lastRefreshTimestamp"
        :title="$t('Subscriptions.Subscriptions')"
        @refresh="refresh"
        @visible-entries="noteVisibleEntries"
      />
      <p
        v-else
        class="message"
      >
        {{ $t("Subscriptions.All Subscription Kinds Hidden", {
          subsection: $t('Settings.Distraction Free Settings.Sections.Subscriptions Page'),
          settingsSection: $t('Settings.Distraction Free Settings.Distraction Free Settings')
        }) }}
      </p>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'

import FtCard from '../../components/ft-card/ft-card.vue'
import SubscriptionsTabUi from '../../components/SubscriptionsTabUi/SubscriptionsTabUi.vue'

import { useSubscriptionFeed } from '../../composables/useSubscriptionFeed'

import { enabledSubscriptionFeeds } from '../../helpers/subscriptionFeeds'

/**
 * The subscriptions page: one stream, not four tabs.
 *
 * The strip is gone, and with it the question it kept asking. Choosing between
 * videos, shorts, live streams and posts was never a thing anyone wanted to do;
 * it was a thing they had to do four times to find out what had happened since
 * yesterday, and choosing wrongly hid the answer. So the four lists are one
 * list, in one order, and what is left here is the page around it.
 *
 * The session key that remembered which tab was open went with the strip. There
 * is nothing left for it to remember.
 */

const {
  isLoading,
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  noteVisibleEntries,
  refresh
} = useSubscriptionFeed()

/**
 * Whether any kind is switched on at all. Every one of them hidden is a page
 * with nothing on it and no way to tell why, so it is answered rather than
 * shown as an empty stream.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const anyFeedEnabled = computed(() => enabledSubscriptionFeeds().length > 0)
</script>

<style scoped src="./Subscriptions.css" />
