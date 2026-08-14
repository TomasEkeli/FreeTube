import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  cancelSubscriptionRecovery,
  subscriptionRecoveryProgress
} from '../helpers/subscriptionRecovery'
import { subscriptionRefreshProgress } from '../helpers/subscriptionRefresh'

/**
 * What the subscriptions page is doing in the background, reduced to something
 * that fits on one line of the feed's status strip.
 *
 * A refresh that runs behind an existing feed, and the recovery behind that, both
 * deliberately avoid the loading spinner so the feed stays readable while they
 * work — which leaves them invisible, and a feed quietly reassembling itself is
 * indistinguishable from a broken one. What is worth saying is that something is
 * happening and roughly how far along it is.
 *
 * The detail back-fill is deliberately not reported. It is an improvement to a
 * feed that is already perfectly usable without it, it now runs over every
 * channel rather than the visible hundred, and it is held to a narrow share of
 * the budget on purpose. Announcing it would mean a status line and a crawling
 * bar for the best part of an hour after every refresh, which turns "this is
 * getting better in the background" into "this is stuck". Whether it is running
 * is a question for `FT_SUBS_TRACE`, not for the person reading the feed.
 */
/**
 * @param {object} sources
 * @param {import('vue').Ref<boolean>} sources.isRefreshing whether a remote
 *   refresh is in flight for the feed being shown
 */
export function useSubscriptionActivity({ isRefreshing }) {
  const { t } = useI18n()

  const recovery = subscriptionRecoveryProgress
  const refreshing = subscriptionRefreshProgress

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

    return ''
  })

  /**
   * How far along, from 0 to 1, or null when there is no honest answer.
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
