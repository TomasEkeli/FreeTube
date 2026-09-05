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
      <div
        v-for="feed in unavailableFeeds"
        :key="feed"
        class="unavailable"
      >
        <p class="message">
          {{ unavailableMessage(feed) }}
        </p>
        <FtButton
          v-if="unavailableActionLabel(feed)"
          :label="unavailableActionLabel(feed)"
          @click="refreshFeed(feed)"
        />
      </div>
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
import { useI18n } from 'vue-i18n'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import SubscriptionsTabUi from '../../components/SubscriptionsTabUi/SubscriptionsTabUi.vue'

import { useSubscriptionFeed } from '../../composables/useSubscriptionFeed'

import { enabledSubscriptionFeeds, subscriptionFeedDescriptor } from '../../helpers/subscriptionFeeds'

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

const { t } = useI18n()

const {
  isLoading,
  isRefreshing,
  entryList,
  errorChannels,
  attemptedFetch,
  unavailableFeeds,
  lastRefreshTimestamp,
  noteVisibleEntries,
  refresh,
  refreshFeed
} = useSubscriptionFeed()

/**
 * Whether any kind is switched on at all. Every one of them hidden is a page
 * with nothing on it and no way to tell why, so it is answered rather than
 * shown as an empty stream.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const anyFeedEnabled = computed(() => enabledSubscriptionFeeds().length > 0)

/**
 * Why nothing automatic will fetch a kind that is switched on.
 *
 * Written by the feed descriptor and handed `t` rather than reaching for one,
 * so the locale keys stay written out where lint and the translators can see
 * them.
 *
 * @param {string} feed
 * @returns {string}
 */
function unavailableMessage(feed) {
  return subscriptionFeedDescriptor(feed).unavailableMessage?.(t) ?? ''
}

/**
 * What to put on the button that fetches it anyway, or empty for a kind that
 * offers no such button.
 *
 * @param {string} feed
 * @returns {string}
 */
function unavailableActionLabel(feed) {
  return subscriptionFeedDescriptor(feed).unavailableActionLabel?.(t) ?? ''
}
</script>

<style scoped src="./Subscriptions.css" />
