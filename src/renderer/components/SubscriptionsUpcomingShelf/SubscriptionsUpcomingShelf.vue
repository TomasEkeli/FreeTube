<!--
  What has not happened yet, kept out of what has.

  A premiere is dated by the day it will air, so a stream sorted by date opened
  with things nobody could watch — the future wearing the newest upload's
  clothes. The fix is not to hide it: something scheduled for Friday is worth
  knowing about, and often more worth knowing about than another Tuesday upload.
  It is to stop pretending it is news. So it lives up here, in its own order,
  read as a schedule rather than as history: soonest first, because that is the
  next thing to happen, whereas the stream below runs newest first because that
  is the latest thing that did.

  A list rather than a row of cards. A schedule is a column of times one reads
  down, and the stream underneath is already a grid: a second grid over it would
  read as more of the same feed, which is exactly the confusion this exists to
  end.

  Folded away it is one line with a count on it, which is the whole shelf for a
  reader who does not care — and the count is still there, so caring again costs
  one click. Whether it is folded is remembered, because it is a standing
  preference and not a mood.
-->
<template>
  <section
    v-if="entries.length > 0"
    class="upcomingShelf"
  >
    <button
      class="shelfHeader"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <FontAwesomeIcon
        class="shelfIcon"
        :icon="['fas', 'clock']"
        aria-hidden="true"
      />
      <span class="shelfCount">
        {{ t('Subscriptions.Upcoming.Count', { count: entries.length }, entries.length) }}
      </span>
      <FontAwesomeIcon
        class="shelfChevron"
        :icon="expanded ? ['fas', 'angle-up'] : ['fas', 'angle-down']"
        aria-hidden="true"
      />
    </button>
    <FtElementList
      v-if="expanded"
      class="shelfList"
      :data="entries"
      display="list"
      :use-channels-hidden-preference="false"
    />
  </section>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtElementList from '../FtElementList/FtElementList.vue'

import store from '../../store/index'

defineProps({
  /**
   * The scheduled entries, soonest first. Already filtered — which kinds are
   * shown, and whether premieres are hidden at all — by the same assembly that
   * filtered the stream, so a chip switched off empties this of that kind too.
   *
   * @type {import('vue').PropType<any[]>}
   */
  entries: {
    type: Array,
    default: () => []
  }
})

const { t } = useI18n()

/**
 * Whether the shelf is open, read and written straight through to the setting.
 *
 * Written on every click rather than kept here and saved later: there is no
 * later, since the whole point is that closing it survives leaving the page and
 * closing the app.
 *
 * @type {import('vue').WritableComputedRef<boolean>}
 */
const expanded = computed({
  get: () => store.getters.getUpcomingShelfExpanded,
  set: (value) => store.dispatch('updateUpcomingShelfExpanded', value)
})
</script>

<style scoped src="./SubscriptionsUpcomingShelf.css" />
