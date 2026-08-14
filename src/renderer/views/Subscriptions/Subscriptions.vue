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
      <FtFlexBox
        class="tabs"
        role="tablist"
        :aria-label="$t('Subscriptions.Subscriptions Tabs')"
      >
        <!-- eslint-disable-next-line vuejs-accessibility/interactive-supports-focus -->
        <div
          v-for="(feed, index) in visibleFeeds"
          :key="feed"
          :ref="element => { tabElements[index] = element }"
          class="tab"
          role="tab"
          :aria-selected="currentFeed === feed"
          aria-controls="subscriptionsPanel"
          :tabindex="currentFeed === feed ? 0 : -1"
          :class="{ selectedTab: currentFeed === feed }"
          @click="changeTab(feed)"
          @keydown.space.enter.prevent="changeTab(feed)"
          @keydown.left.right="focusTab($event, feed)"
        >
          <FontAwesomeIcon
            :icon="FEED_ICONS[feed]"
            class="subscriptionIcon"
          />
          {{ subscriptionFeedTitle(feed) }}
        </div>
      </FtFlexBox>
      <SubscriptionsTab
        v-if="currentFeed !== null"
        id="subscriptionsPanel"
        :key="currentFeed"
        :feed="currentFeed"
        role="tabpanel"
      />
      <p v-else>
        {{ $t("Subscriptions.All Subscription Tabs Hidden", {
          subsection: $t('Settings.Distraction Free Settings.Sections.Subscriptions Page'),
          settingsSection: $t('Settings.Distraction Free Settings.Distraction Free Settings')
        }) }}
      </p>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, ref, watch } from 'vue'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import SubscriptionsTab from '../../components/SubscriptionsTab.vue'

import store from '../../store/index'

import { useSubscriptionFeedTitle } from '../../composables/useSubscriptionFeedTitle'

import { enabledSubscriptionFeeds } from '../../helpers/subscriptionFeeds'

/**
 * Which feeds exist, and whether each is switched on, is the registry's
 * business now: the same answer decides what the tab strip offers and what a
 * refresh covers, and those two disagreeing would mean refreshing a feed nobody
 * can see, or showing a tab nothing fetches.
 *
 * What stays here is what is genuinely about the strip: the icons, and which
 * tab is selected.
 */
const FEED_ICONS = {
  videos: ['fa', 'video'],
  shorts: ['fa', 'clapperboard'],
  live: ['fa', 'tower-broadcast'],
  posts: ['fa', 'message']
}

const subscriptionFeedTitle = useSubscriptionFeedTitle()

/**
 * The feeds switched on, in tab order. Reactive because deciding it reads the
 * distraction-free settings out of the store, and doing that inside a computed
 * is what subscribes to them.
 *
 * @type {import('vue').ComputedRef<string[]>}
 */
const visibleFeeds = computed(() => enabledSubscriptionFeeds())

/** @type {import('vue').Ref<'videos' | 'shorts' | 'live' | 'posts' | null>} */
const currentFeed = ref(visibleFeeds.value[0] ?? null)

// Restore the tab last used, from before this view was navigated away from
const remembered = sessionStorage.getItem('Subscriptions/currentTab')

if (remembered !== null && visibleFeeds.value.includes(remembered)) {
  currentFeed.value = remembered
}

watch(currentFeed, (value) => {
  if (value !== null) {
    sessionStorage.setItem('Subscriptions/currentTab', value)
  } else {
    sessionStorage.removeItem('Subscriptions/currentTab')
  }
})

watch(visibleFeeds, (value) => {
  if (value.length === 0) {
    currentFeed.value = null
  } else if (!value.includes(currentFeed.value)) {
    currentFeed.value = value[0]
  }
})

/**
 * @param {string} feed
 */
function changeTab(feed) {
  if (feed === currentFeed.value) {
    return
  }

  if (visibleFeeds.value.includes(feed)) {
    currentFeed.value = feed
  } else {
    // First visible tab or no tab
    currentFeed.value = visibleFeeds.value.length > 0 ? visibleFeeds.value[0] : null
  }
}

/** @type {HTMLElement[]} */
const tabElements = ref([])

/**
 * @param {KeyboardEvent} event
 * @param {string} focusedFeed
 */
function focusTab(event, focusedFeed) {
  if (event.altKey) {
    return
  }

  event.preventDefault()

  const feeds = visibleFeeds.value

  if (feeds.length === 1) {
    store.commit('setOutlinesHidden', false)
    return
  }

  let index = feeds.indexOf(focusedFeed)

  if (event.key === 'ArrowLeft') {
    index--
  } else {
    index++
  }

  if (index < 0) {
    index = feeds.length - 1
  } else if (index > feeds.length - 1) {
    index = 0
  }

  tabElements.value[index]?.focus()

  store.commit('setOutlinesHidden', false)
}
</script>

<style scoped src="./Subscriptions.css" />
