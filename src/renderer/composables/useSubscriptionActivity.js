import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  cancelSubscriptionRecovery,
  subscriptionRecoveryProgress
} from '../helpers/subscriptionRecovery'
import { subscriptionRefreshProgress } from '../helpers/subscriptionRefresh'
import { subscriptionWorkerProgress } from '../helpers/subscriptionWorker'

/**
 * What the subscriptions page is doing in the background, reduced to something
 * that fits on one line of the feed's status strip.
 *
 * Both the recovery and the detail back-fill deliberately avoid the loading
 * spinner so the feed stays readable while they work, which leaves them
 * invisible: a feed slowly filling itself in over several minutes with no
 * explanation is indistinguishable from a broken one.
 *
 * What is worth saying is that something is happening and roughly how far along
 * it is. The counts behind it are diagnostics, and belong in the trace rather
 * than in front of someone who only wants to know whether to keep waiting.
 */
/**
 * @param {object} sources
 * @param {import('vue').Ref<boolean>} sources.isRefreshing whether a remote
 *   refresh is in flight for the feed being shown
 */
export function useSubscriptionActivity({ isRefreshing }) {
  const { t } = useI18n()

  const recovery = subscriptionRecoveryProgress
  const worker = subscriptionWorkerProgress
  const refreshing = subscriptionRefreshProgress

  /**
   * Recovery outranks the back-fill on the shared queue, so it is what gets
   * reported while both are outstanding.
   */
  const label = computed(() => {
    // Said during a refresh as well as after one, because a refresh that runs
    // behind an existing feed has no spinner to announce it. It also keeps the
    // last-updated time off screen while it churns: that time is the oldest of
    // six hundred cached timestamps, and a refresh rewrites them one at a time,
    // so it jitters for the whole half minute.
    if (isRefreshing.value) {
      return t('Subscriptions.Refreshing')
    }

    if (recovery.active) {
      // Whether it is working through profiles or down to single channels is an
      // implementation detail; the progress already conveys how near the end it is
      return t('Subscriptions.Recovering Channels')
    }

    if (worker.lanes.enrichment.inFlight > 0 || worker.lanes.enrichment.queued > 0) {
      return t('Subscriptions.Filling In Details')
    }

    return ''
  })

  /**
   * How far along, from 0 to 1, or null when there is no honest answer.
   *
   * The back-fill's queue grows as more of the feed is looked at, so its
   * denominator moves and the bar can go backwards. That is still better than a
   * number that pretends otherwise, and a bar that occasionally retreats reads
   * as work arriving rather than as a fault.
   *
   * @type {import('vue').ComputedRef<number | null>}
   */
  const progress = computed(() => {
    if (isRefreshing.value) {
      // Read from the refresh itself rather than from the window's progress bar,
      // which is a mirror of this and not a source
      return refreshing.total > 0 ? refreshing.done / refreshing.total : null
    }

    if (recovery.active) {
      const total = recovery.recovered + recovery.remaining

      return total > 0 ? recovery.recovered / total : null
    }

    const enrichment = worker.lanes.enrichment
    const enrichmentTotal = enrichment.done + enrichment.queued + enrichment.inFlight

    if (enrichmentTotal > 0) {
      return enrichment.done / enrichmentTotal
    }

    return null
  })

  /** Only the recovery is worth stopping; the back-fill is nearly free. */
  const canStop = computed(() => recovery.active)

  return {
    label,
    progress,
    canStop,
    stop: cancelSubscriptionRecovery
  }
}
