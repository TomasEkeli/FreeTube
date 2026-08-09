<template>
  <div
    class="floatingRefreshSection"
  >
    <p
      v-if="activityLabel"
      class="activityLabel"
    >
      {{ activityLabel }}
    </p>
    <p
      v-else-if="lastRefreshTimestamp"
      class="lastRefreshTimestamp"
    >
      {{ t('Feed.Feed Last Updated', { feedName: title, date: lastRefreshTimestamp }) }}
    </p>
    <FtIconButton
      v-if="canStopActivity"
      :icon="['fas', 'xmark']"
      class="stopActivityButton"
      :title="t('Subscriptions.Stop Recovering')"
      :size="12"
      theme="secondary"
      @click="stopActivity"
    />
    <FtIconButton
      :disabled="disableRefresh"
      :icon="['fas', 'sync']"
      class="refreshButton"
      :title="refreshFeedButtonTitle"
      :size="12"
      theme="primary"
      @click="click"
    />
    <div
      v-if="activityLabel"
      class="activityProgressTrack"
    >
      <div
        class="activityProgressFill"
        :class="{ indeterminate: activityProgress === null }"
        :style="activityProgress === null ? undefined : { inlineSize: `${Math.round(activityProgress * 100)}%` }"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import { KeyboardShortcuts } from '../../../constants'
import { addKeyboardShortcutToActionTitle } from '../../helpers/utils'

const props = defineProps({
  disableRefresh: {
    type: Boolean,
    default: false
  },
  lastRefreshTimestamp: {
    type: String,
    default: ''
  },
  title: {
    type: String,
    required: true
  },
  /**
   * Short description of background work in progress. Takes the place of the
   * last-updated time while set, since during a recovery that time is stale
   * anyway: the feed is in the middle of being completed.
   */
  activityLabel: {
    type: String,
    default: ''
  },
  /** How far along, 0 to 1, or null when there is no honest answer. */
  activityProgress: {
    type: Number,
    default: null
  },
  canStopActivity: {
    type: Boolean,
    default: false
  }
})

const { t } = useI18n()

const refreshFeedButtonTitle = computed(() => {
  return addKeyboardShortcutToActionTitle(
    t('Feed.Refresh Feed', { subscriptionName: props.title }),
    KeyboardShortcuts.APP.SITUATIONAL.REFRESH
  )
})

const emit = defineEmits(['click', 'stop-activity'])

function click() {
  emit('click')
}

function stopActivity() {
  emit('stop-activity')
}
</script>

<style scoped lang="scss" src="./FtRefreshWidget.scss" />
