<template>
  <div
    v-if="message"
    class="subscriptionActivity"
  >
    <p class="activityMessage">
      {{ message }}
    </p>
    <FtButton
      v-if="recovery.active"
      :label="t('Subscriptions.Stop Recovering')"
      background-color="var(--secondary-card-bg-color)"
      text-color="var(--secondary-text-color)"
      @click="stop"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtButton from '../FtButton/FtButton.vue'

import {
  cancelSubscriptionRecovery,
  subscriptionRecoveryProgress
} from '../../helpers/subscriptionRecovery'
import { subscriptionWorkerProgress } from '../../helpers/subscriptionWorker'

/**
 * What the subscriptions page is doing in the background.
 *
 * Both of the things it reports deliberately avoid the loading spinner, so that
 * the feed stays readable while they run. The cost of that is they are
 * invisible, and a feed quietly filling itself in over several minutes with no
 * explanation is indistinguishable from one that is broken. This says which it
 * is, without taking over.
 *
 * Nothing is rendered when nothing is happening.
 */

const { t } = useI18n()

const recovery = subscriptionRecoveryProgress
const worker = subscriptionWorkerProgress

const message = computed(() => {
  if (recovery.active) {
    // Recovery is the more important of the two and outranks the back-fill on
    // the shared queue, so it is what gets said while both are outstanding
    return recovery.stage === 'channels'
      ? t('Subscriptions.Recovering Channels One At A Time', {
          remaining: recovery.remaining,
          recovered: recovery.recovered
        })
      : t('Subscriptions.Recovering Channels', {
          remaining: recovery.remaining,
          recovered: recovery.recovered
        })
  }

  if (worker.lane === 'enrichment') {
    return t('Subscriptions.Filling In Details', { remaining: worker.queued + 1 })
  }

  return ''
})

function stop() {
  cancelSubscriptionRecovery()
}
</script>

<style scoped src="./SubscriptionActivity.css" />
