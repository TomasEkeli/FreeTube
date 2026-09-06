<template>
  <div>
    <FtCard
      class="card"
    >
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'compass']"
          class="exploreIcon"
        />
        {{ $t("Explore.Explore") }}
      </h2>
      <div class="controlRow">
        <div
          class="chipRow"
          role="group"
          :aria-label="$t('Explore.Categories Shown')"
        >
          <FtToggleChip
            v-for="category in EXPLORE_CATEGORIES"
            :key="category.id"
            :label="categoryTitle(category.id)"
            :icon="category.icon"
            :pressed="categoryIsShown(category.id)"
            @toggle="toggleCategory(category.id)"
          />
        </div>
        <FtDensitySwitch />
      </div>
      <FtLoader
        v-if="anyLoading && stream.length === 0"
      />
      <FtElementList
        v-else-if="enabledCategories.length > 0"
        :data="stream"
      />
      <p
        v-else
        class="message"
      >
        {{ $t("Explore.No Categories Shown") }}
      </p>
    </FtCard>
    <FtRefreshWidget
      :disable-refresh="anyLoading"
      :last-refresh-timestamp="lastRefreshTimestamp"
      :title="$t('Explore.Explore')"
      @click="refresh"
    />
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtRefreshWidget from '../../components/FtRefreshWidget/FtRefreshWidget.vue'
import FtToggleChip from '../../components/FtToggleChip/FtToggleChip.vue'

import store from '../../store/index'

import {
  EXPLORE_CATEGORIES,
  enabledExploreCategories,
  exploreCategoryIsShown,
  mergeByRank,
  setExploreCategoryShown
} from '../../helpers/exploreCategories'
import { copyToClipboard, getRelativeTimeFromDate, showToast } from '../../helpers/utils'
import { getLocalTrending } from '../../helpers/api/local'
import { KeyboardShortcuts } from '../../../constants'

/**
 * Explore: what YouTube is pushing today, as one stream.
 *
 * The page used to be three tabs, because YouTube's trending used to be three
 * lists and a tab is what you build when you have three of something. But the
 * lists are not alternatives to each other — nobody wants to know what is
 * trending in gaming *instead of* what is trending in sport — and a tab made
 * the reader ask for each one in turn and remember what the other two said.
 *
 * So the tabs are chips, the same grammar as the subscriptions page: each says
 * whether its destination belongs in what is being read, any number of them can
 * be on, and the one stream below holds whichever are.
 *
 * The stream is round-robin by rank rather than by date: see `mergeByRank`.
 *
 * A destination is fetched when its chip first goes on and served from the
 * cache after that, so switching one off and back on costs nothing.
 */

const { t } = useI18n()

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => {
  return store.getters.getBackendPreference
})

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => {
  return store.getters.getBackendFallback
})

/** @type {import('vue').ComputedRef<string>} */
const region = computed(() => {
  return store.getters.getRegion.toUpperCase()
})

/** @type {import('vue').ComputedRef<Record<string, any[] | null>>} */
const exploreCache = computed(() => {
  return store.getters.getExploreCache
})

/**
 * Which destinations are being fetched right now, so that a chip switched on
 * twice in a second does not fetch twice.
 *
 * @type {import('vue').Ref<Record<string, boolean>>}
 */
const isLoading = ref({})

/** @type {import('vue').ComputedRef<string[]>} */
const enabledCategories = computed(() => {
  // Reading the setting inside the computed is what subscribes this to it, so
  // the chips and the stream both follow a toggle.
  return enabledExploreCategories()
})

const anyLoading = computed(() => enabledCategories.value.some(id => isLoading.value[id]))

/** @type {import('vue').ComputedRef<any[]>} */
const stream = computed(() => {
  return mergeByRank(enabledCategories.value.map(id => exploreCache.value[id] ?? []))
})

/**
 * How old the stream is: the age of the least recently fetched thing in it.
 *
 * Several destinations, several fetch times, and only one line to say it in.
 * The oldest is the honest answer — anything newer would claim the stale part
 * of the stream is fresher than it is.
 *
 * @type {import('vue').ComputedRef<string>}
 */
const lastRefreshTimestamp = computed(() => {
  const timestamps = store.getters.getLastExploreRefreshTimestamp
  const fetched = enabledCategories.value
    .map(id => timestamps[id])
    .filter(timestamp => timestamp)

  if (fetched.length === 0) { return '' }

  const oldest = fetched.reduce((oldest, timestamp) => timestamp < oldest ? timestamp : oldest)

  return getRelativeTimeFromDate(oldest, true)
})

/**
 * Fetch whatever is switched on and has never been fetched.
 *
 * A destination that answered with nothing is still a destination that has been
 * fetched; it is not asked again until a refresh.
 */
function fetchMissing() {
  for (const id of enabledCategories.value) {
    if (exploreCache.value[id] == null && !isLoading.value[id]) {
      fetchCategory(id)
    }
  }
}

/**
 * @param {string} id
 */
async function fetchCategory(id) {
  if (!process.env.SUPPORTS_LOCAL_API || !(backendFallback.value || backendPreference.value === 'local')) {
    return
  }

  isLoading.value = { ...isLoading.value, [id]: true }

  try {
    const results = await getLocalTrending(region.value, id)

    store.commit('setExploreCache', { value: results, page: id })
    store.commit('setLastExploreRefreshTimestamp', { page: id, timestamp: new Date() })
  } catch (error) {
    console.error(error)
    const errorMessage = t('Local API Error (Click to copy)')
    showToast(`${errorMessage}: ${error}`, 10000, () => {
      copyToClipboard(error)
    })
  } finally {
    isLoading.value = { ...isLoading.value, [id]: false }
  }
}

/** Throw away what is shown and ask for all of it again. */
function refresh() {
  for (const id of enabledCategories.value) {
    store.commit('clearExploreCache', id)
  }

  fetchMissing()
}

/**
 * What each destination is called.
 *
 * Written out rather than looked up from the descriptors, because a translation
 * key has to be a literal for the linter to check it against the locale files.
 * The strings still sit in the locale files' `Trending` section, where they are
 * translated into every language the app ships: the next ticket replaces them
 * with the localised titles YouTube itself gives each destination, so moving
 * them now would throw those translations away for one ticket's lifetime.
 *
 * @param {string} id
 * @returns {string}
 */
function categoryTitle(id) {
  switch (id) {
    case 'gaming':
      return t('Trending.Gaming')
    case 'sports':
      return t('Trending.Sports')
    case 'podcasts':
      return t('Channel.Podcasts.Podcasts')
    default:
      return ''
  }
}

/**
 * @param {string} id
 */
function categoryIsShown(id) {
  return enabledCategories.value.includes(id)
}

/**
 * @param {string} id
 */
function toggleCategory(id) {
  setExploreCategoryShown(id, !exploreCategoryIsShown(id))
}

// A chip switched on is a request for that destination, whether or not it has
// ever been fetched. Watching the set rather than handling it in the toggle
// keeps that true however the set comes to change.
watch(enabledCategories, fetchMissing)

/**
 * @param {KeyboardEvent} event the keyboard event
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
      if (!anyLoading.value) {
        refresh()
      }
      break
  }
}

onMounted(() => {
  fetchMissing()
  document.addEventListener('keydown', keyboardShortcutHandler)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboardShortcutHandler)
})
</script>

<style scoped src="../../components/FtToggleChip/chipRow.css" />
<style scoped src="./Explore.css" />
