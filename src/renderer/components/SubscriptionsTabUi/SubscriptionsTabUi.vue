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
        {{ isCommunity ? $t("Subscriptions.Empty Posts") : $t("Subscriptions.Empty Channels") }}
      </p>
    </FtFlexBox>
    <FtElementList
      v-if="!isLoading && activeVideoList.length > 0"
      :data="activeVideoList"
      :use-channels-hidden-preference="false"
      :display="isCommunity ? 'list' : ''"
    />
    <FtAutoLoadNextPageWrapper
      v-if="!isLoading && videoList.length > dataLimit"
      @load-next-page="increaseLimit"
    >
      <FtFlexBox>
        <FtButton
          :label="isCommunity ? $t('Subscriptions.Load More Posts') : $t('Subscriptions.Load More Videos')"
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import FtAutoLoadNextPageWrapper from '../FtAutoLoadNextPageWrapper.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtChannelBubble from '../FtChannelBubble/FtChannelBubble.vue'
import FtElementList from '../FtElementList/FtElementList.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtLoader from '../FtLoader/FtLoader.vue'
import FtRefreshWidget from '../FtRefreshWidget/FtRefreshWidget.vue'

import store from '../../store/index'

import { useSubscriptionActivity } from '../../composables/useSubscriptionActivity'

import { backfillDetailsForVisibleVideos } from '../../helpers/subscriptionDetailBackfill'
import { debounce } from '../../helpers/utils'

import { KeyboardShortcuts } from '../../../constants'

const props = defineProps({
  isLoading: {
    type: Boolean,
    default: false
  },
  videoList: {
    type: Array,
    default: () => []
  },
  isCommunity: {
    type: Boolean,
    default: false
  },
  errorChannels: {
    type: Array,
    default: () => []
  },
  attemptedFetch: {
    type: Boolean,
    default: false
  },
  initialDataLimit: {
    type: Number,
    default: 100
  },
  /**
   * Whether missing video details are worth fetching in the background. Shorts
   * have no duration by nature and posts are not videos at all.
   */
  backfillDetails: {
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

const emit = defineEmits(['refresh'])

const {
  label: activityLabel,
  progress: activityProgress,
  canStop: canStopActivity,
  stop: stopActivity
} = useSubscriptionActivity()

const subscriptionLimit = sessionStorage.getItem('subscriptionLimit')

const dataLimit = ref(subscriptionLimit !== null ? parseInt(subscriptionLimit) : props.initialDataLimit)

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
  if (props.isCommunity) {
    return props.videoList
  }

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
  dataLimit.value += props.initialDataLimit
  sessionStorage.setItem('subscriptionLimit', dataLimit.value.toFixed(0))
}

// This component is the only place that knows which part of the feed is actually
// on screen, so it is the place that decides what is worth filling in. Debounced
// because the visible slice changes on every refresh, profile switch and "load
// more", and often several times in quick succession.
const queueDetailBackfill = debounce(() => {
  if (!props.backfillDetails || props.isLoading) { return }

  backfillDetailsForVisibleVideos(activeVideoList.value)
}, 500)

watch(activeVideoList, queueDetailBackfill)

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
