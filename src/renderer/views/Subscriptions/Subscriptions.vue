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
      <div class="controlRow">
        <div
          class="chipRow"
          role="group"
          :aria-label="$t('Subscriptions.Kinds Shown')"
        >
          <FtToggleChip
            v-for="feed in choosableFeeds"
            :key="feed"
            :label="subscriptionFeedTitle(feed)"
            :icon="FEED_ICONS[feed]"
            :pressed="subscriptionFeedIsShown(feed)"
            @toggle="toggleFeed(feed)"
          />
        </div>
        <FtDensitySwitch />
      </div>
      <SubscriptionsUpcomingShelf
        v-if="anyFeedEnabled && !isLoading"
        :entries="upcomingList"
      />
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
        {{ $t("Subscriptions.No Kinds Shown") }}
      </p>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtToggleChip from '../../components/FtToggleChip/FtToggleChip.vue'
import SubscriptionsTabUi from '../../components/SubscriptionsTabUi/SubscriptionsTabUi.vue'
import SubscriptionsUpcomingShelf from '../../components/SubscriptionsUpcomingShelf/SubscriptionsUpcomingShelf.vue'

import { useSubscriptionFeed } from '../../composables/useSubscriptionFeed'
import { useSubscriptionFeedTitle } from '../../composables/useSubscriptionFeedTitle'

import {
  choosableSubscriptionFeeds,
  enabledSubscriptionFeeds,
  setSubscriptionFeedShown,
  subscriptionFeedIsShown
} from '../../helpers/subscriptionFeeds'

/**
 * The subscriptions page: one stream, not four tabs.
 *
 * The strip is gone, and with it the question it kept asking. Choosing between
 * videos, shorts, live streams and posts was never a thing anyone wanted to do;
 * it was a thing they had to do four times to find out what had happened since
 * yesterday, and choosing wrongly hid the answer. So the four lists are one
 * list, in one order, and over it a row of chips saying which kinds are in it.
 *
 * A chip is not a tab. A tab asked which one kind to look at; a chip says
 * whether this kind belongs in what is being read, and the reader may have all
 * four or none. And a chip is only ever about what is shown: every kind is
 * fetched every refresh whatever the chips say, so switching one on reveals
 * something as current as the rest of the stream, out of the cache, without a
 * request and without a spinner.
 *
 * The row is the page's one control row: the chips at one end and the density
 * switch at the other, since a second row of controls over a single stream is
 * the sort of thing this page was rebuilt to be rid of.
 *
 * Between that row and the stream sits the shelf of what has not happened yet,
 * which is the other half of making one list readable: a premiere is dated by
 * the day it will air, so leaving it in the stream put the future at the top of
 * a list of the past. The shelf is a schedule and the stream is history, and
 * neither has to be read as the other.
 */

const {
  isLoading,
  isRefreshing,
  entryList,
  upcomingList,
  errorChannels,
  attemptedFetch,
  lastRefreshTimestamp,
  noteVisibleEntries,
  refresh
} = useSubscriptionFeed()

/**
 * The same icons the cards' kind markers carry, so a kind looks the same
 * wherever it is met.
 */
const FEED_ICONS = {
  videos: ['fas', 'video'],
  shorts: ['fas', 'clapperboard'],
  live: ['fas', 'tower-broadcast'],
  posts: ['fas', 'message']
}

const subscriptionFeedTitle = useSubscriptionFeedTitle()

/**
 * Which kinds get a chip. Everything, unless a setting outside this page has
 * already hidden one everywhere — the live chip goes away entirely while the
 * app-wide "hide live streams" holds, rather than standing there unable to do
 * anything.
 *
 * Reactive because deciding it reads that setting out of the store, and doing
 * so inside a computed is what subscribes to it.
 *
 * @type {import('vue').ComputedRef<string[]>}
 */
const choosableFeeds = computed(() => choosableSubscriptionFeeds())

/**
 * Whether any kind is on at all. Every chip off is a page with nothing on it,
 * which the stream's own "nothing has been published" message would explain
 * wrongly, so it is answered here.
 *
 * @type {import('vue').ComputedRef<boolean>}
 */
const anyFeedEnabled = computed(() => enabledSubscriptionFeeds().length > 0)

/**
 * @param {string} feed
 */
function toggleFeed(feed) {
  setSubscriptionFeedShown(feed, !subscriptionFeedIsShown(feed))
}
</script>

<style scoped src="../../components/FtToggleChip/chipRow.css" />
<style scoped src="./Subscriptions.css" />
