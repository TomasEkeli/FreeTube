<template>
  <div>
    <FtLoader
      v-if="isLoading"
    />
    <div
      v-if="!isLoading && errorChannels.length !== 0"
    >
      <h3> {{ $t("Subscriptions.Error Channels") }}</h3>
      <FtFlexBox>
        <FtChannelBubble
          v-for="channel in errorChannels"
          :key="channel.id"
          :channel-name="channel.name"
          :channel-id="channel.id"
          :channel-thumbnail="channel.thumbnail"
        />
      </FtFlexBox>
    </div>
    <FtFlexBox
      v-if="!isLoading && activeVideoList.length === 0"
    >
      <p
        v-if="!activeProfileHasSubscriptions"
        class="message"
      >
        {{ $t("Subscriptions['Your Subscription list is currently empty. Start adding subscriptions to see them here.']") }}
      </p>
      <p
        v-else-if="!fetchSubscriptionsAutomatically && !attemptedFetch"
        class="message"
      >
        {{ $t("Subscriptions.Disabled Automatic Fetching") }}
      </p>
      <p
        v-else
        class="message"
      >
        {{ $t("Subscriptions.Empty Channels") }}
      </p>
    </FtFlexBox>
    <FtElementList
      v-if="!isLoading && activeVideoList.length > 0"
      :data="activeVideoList"
      :use-channels-hidden-preference="false"
    />
    <FtAutoLoadNextPageWrapper
      v-if="!isLoading && filteredVideoList.length > dataLimit"
      @load-next-page="increaseLimit"
    >
      <FtFlexBox>
        <FtButton
          :label="$t('Subscriptions.Load More')"
          background-color="var(--primary-color)"
          text-color="var(--text-with-main-color)"
          @click="increaseLimit"
        />
      </FtFlexBox>
    </FtAutoLoadNextPageWrapper>

    <FtRefreshWidget
      :disable-refresh="isLoading || !activeProfileHasSubscriptions"
      :last-refresh-timestamp="lastRefreshTimestamp"
      :title="title"
      :activity-label="activityLabel"
      :activity-progress="activityProgress"
      :can-stop-activity="canStopActivity"
      @click="refresh"
      @stop-activity="stopActivity"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'

import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtChannelBubble from '../FtChannelBubble/FtChannelBubble.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import FtRefreshWidget from '../FtRefreshWidget/FtRefreshWidget.vue'

import store from '../../store/index'

import { useSubscriptionActivity } from '../../composables/useSubscriptionActivity'

import { debounce } from '../../helpers/utils'

import { KeyboardShortcuts } from '../../../constants'

/**
 * The subscriptions stream, as a list on a page.
 *
 * Named for the tabs it used to be one of; it now renders the one merged stream
 * of videos, shorts, live streams and posts. The name is left alone because
 * upstream carries this file too and a rename buys nothing but merge conflicts.
 *
 * Everything here is about display: which slice is on screen, which of the
 * viewing preferences hide entries, and the widget over the top. What the
 * entries are and where they came from is the composable's business.
 */
const props = defineProps({
  isLoading: {
    type: Boolean,
    default: false
  },
  /** A remote refresh is running, whether or not the feed is empty meanwhile. */
  isRefreshing: {
    type: Boolean,
    default: false
  },
  videoList: {
    type: Array,
    default: () => []
  },
  errorChannels: {
    type: Array,
    default: () => []
  },
  attemptedFetch: {
    type: Boolean,
    default: false
  },
  lastRefreshTimestamp: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['refresh', 'visible-entries'])

const {
  label: activityLabel,
  progress: activityProgress,
  canStop: canStopActivity,
  stop: stopActivity
} = useSubscriptionActivity({ isRefreshing: toRef(props, 'isRefreshing') })

/**
 * How much of the stream is rendered at once, and how much each "load more"
 * adds.
 *
 * A prop until the four feeds became one, so that posts could be paged twenty
 * at a time where videos went a hundred. There is one stream now, so there is
 * one page size.
 */
const PAGE_SIZE = 100

const subscriptionLimit = sessionStorage.getItem('subscriptionLimit')

const dataLimit = ref(subscriptionLimit !== null ? parseInt(subscriptionLimit) : PAGE_SIZE)

const activeVideoList = computed(() => {
  if (filteredVideoList.value.length < dataLimit.value) {
    return filteredVideoList.value
  } else {
    return filteredVideoList.value.slice(0, dataLimit.value)
  }
})

const activeProfileHasSubscriptions = computed(() => {
  return store.getters.getActiveProfile.subscriptions.length > 0
})

/** @type {import('vue').ComputedRef<boolean>} */
const fetchSubscriptionsAutomatically = computed(() => {
  return store.getters.getFetchSubscriptionsAutomatically
})

const historyCacheById = computed(() => {
  return store.getters.getHistoryCacheById
})

const hideWatchedSubs = computed(() => {
  return store.getters.getHideWatchedSubs
})

const onlyShowLatestFromChannel = computed(() => {
  return store.getters.getOnlyShowLatestFromChannel
})

const onlyShowLatestFromChannelNumber = computed(() => {
  return store.getters.getOnlyShowLatestFromChannelNumber
})

const filteredVideoList = computed(() => {
  let videoList = props.videoList

  if (hideWatchedSubs.value) {
    videoList = videoList.filter((video) => {
      return historyCacheById.value[video.videoId] === undefined
    })
  }

  if (onlyShowLatestFromChannel.value) {
    const authors = new Map()
    videoList = videoList.filter((video) => {
      if (!video.authorId) {
        return true
      }

      if (!authors.has(video.authorId)) {
        authors.set(video.authorId, 1)
        return true
      } else {
        const currentVideos = authors.get(video.authorId)

        if (currentVideos < onlyShowLatestFromChannelNumber.value) {
          authors.set(video.authorId, currentVideos + 1)
          return true
        }
      }

      return false
    })
  }

  return videoList
})

function increaseLimit() {
  dataLimit.value += PAGE_SIZE
  sessionStorage.setItem('subscriptionLimit', dataLimit.value.toFixed(0))
}

// This component is the only place that knows which part of the feed is actually
// on screen, so it is the place that says what it is. What that is worth doing
// about is not its business: the entries no longer say which kind they are, and
// the composable that assembled them is what knows. Debounced because the
// visible slice changes on every refresh, profile switch and "load more", and
// often several times in quick succession.
const reportVisibleEntries = debounce(() => {
  if (props.isLoading) { return }

  emit('visible-entries', activeVideoList.value)
}, 500)

watch(activeVideoList, reportVisibleEntries)

/**
 * @param {KeyboardEvent} event
 */
function keyboardShortcutHandler(event) {
  if (document.activeElement.classList.contains('ft-input')) {
    return
  }
  // Avoid handling events due to user holding a key (not released)
  // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/repeat
  if (event.repeat) { return }

  switch (event.key.toLowerCase()) {
    case 'f5':
    case KeyboardShortcuts.APP.SITUATIONAL.REFRESH:
      if (!props.isLoading && activeProfileHasSubscriptions.value) {
        refresh()
      }
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', keyboardShortcutHandler)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboardShortcutHandler)
})

function refresh() {
  emit('refresh')
}
</script>

<style scoped src="./SubscriptionsTabUi.css" />
