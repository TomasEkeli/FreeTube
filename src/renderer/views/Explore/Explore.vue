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
            v-for="category in categories"
            :key="category.id"
            :label="category.title"
            :icon="category.icon"
            :pressed="categoryIsShown(category.id)"
            @toggle="toggleCategory(category.id)"
          />
        </div>
        <div class="pageControls">
          <div
            v-if="regionNames.length > 0"
            class="regionPicker"
          >
            <label
              class="regionLabel"
              :for="regionSelectId"
            >
              {{ $t("Explore.Region") }}
            </label>
            <select
              :id="regionSelectId"
              v-model="region"
              class="regionSelect"
            >
              <option
                v-for="(name, index) in regionNames"
                :key="regionValues[index]"
                :value="regionValues[index]"
              >
                {{ name }}
              </option>
            </select>
          </div>
          <FtDensitySwitch />
        </div>
      </div>
      <FtLoader
        v-if="isLoading"
      />
      <FtElementList
        v-else-if="shownCategories.length > 0"
        :data="stream"
      />
      <p
        v-else
        class="message"
      >
        {{ categories.length > 0 ? $t("Explore.No Categories Shown") : $t("Explore.Nothing to Explore") }}
      </p>
    </FtCard>
    <FtRefreshWidget
      :disable-refresh="isLoading"
      :last-refresh-timestamp="lastRefreshTimestamp"
      :title="$t('Explore.Explore')"
      @click="refresh"
    />
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import FtCard from '../../components/ft-card/ft-card.vue'
import FtDensitySwitch from '../../components/FtDensitySwitch/FtDensitySwitch.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtRefreshWidget from '../../components/FtRefreshWidget/FtRefreshWidget.vue'
import FtToggleChip from '../../components/FtToggleChip/FtToggleChip.vue'

import store from '../../store/index'

import {
  discoverExploreCategories,
  exploreCategoryIsShown,
  mergeByRank,
  setExploreCategoryShown
} from '../../helpers/exploreCategories'
import { copyToClipboard, getRelativeTimeFromDate, showToast } from '../../helpers/utils'
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
 * whether its category belongs in what is being read, any number of them can be
 * on, and the one stream below holds whichever are.
 *
 * Which chips there are is YouTube's answer, not ours — see
 * `helpers/exploreCategories.js`. It differs by region, and it is found by
 * asking, so opening the page is one round of requests and then nothing:
 * everything a chip could show is already here, and a chip pressed either way
 * costs no traffic and no spinner.
 *
 * The stream is round-robin by rank rather than by date: see `mergeByRank`.
 */

const { t, locale } = useI18n()

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => {
  return store.getters.getBackendPreference
})

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => {
  return store.getters.getBackendFallback
})

/**
 * Which country's charts these are, and the page's own control for it.
 *
 * Trending is per country and always has been, but the only place to say which
 * country was the settings screen — two rooms away from the thing it changes,
 * and with no way to see what changed. So the setting is here too, on the page
 * it decides. It is the same setting, not a copy: General Settings goes on
 * showing it, and either one moves the other.
 *
 * @type {import('vue').WritableComputedRef<string>}
 */
const region = computed({
  get: () => store.getters.getRegion.toUpperCase(),
  set: (value) => store.dispatch('updateRegion', value)
})

const regionSelectId = useId()

/** @type {import('vue').ComputedRef<string[]>} */
const regionNames = computed(() => store.getters.getRegionNames)

/** @type {import('vue').ComputedRef<string[]>} */
const regionValues = computed(() => store.getters.getRegionValues)

/** What this region's last look at YouTube found, or nothing if we have not looked. */
const found = computed(() => {
  return store.getters.getExploreCache[region.value]
})

const isLoading = ref(false)

/**
 * The chips: every category this region has, whether or not it is switched on.
 *
 * @type {import('vue').ComputedRef<import('../../helpers/exploreCategories').ExploreCategory[]>}
 */
const categories = computed(() => found.value?.categories ?? [])

/**
 * The categories in the stream.
 *
 * Reading the chip setting inside a computed is what subscribes the page to it,
 * so pressing a chip redraws the stream.
 *
 * @type {import('vue').ComputedRef<import('../../helpers/exploreCategories').ExploreCategory[]>}
 */
const shownCategories = computed(() => {
  return categories.value.filter(category => exploreCategoryIsShown(category.id))
})

/** @type {import('vue').ComputedRef<any[]>} */
const stream = computed(() => {
  return mergeByRank(shownCategories.value.map(category => category.videos))
})

/** @type {import('vue').ComputedRef<string>} */
const lastRefreshTimestamp = computed(() => {
  const fetchedAt = found.value?.fetchedAt

  return fetchedAt ? getRelativeTimeFromDate(fetchedAt, true) : ''
})

/**
 * Ask YouTube what it has, unless this region has already been asked in this
 * session.
 *
 * @param {boolean} refetch ignore what we have and ask again
 */
async function discover(refetch = false) {
  if (!process.env.SUPPORTS_LOCAL_API || !(backendFallback.value || backendPreference.value === 'local')) {
    return
  }

  if (found.value && !refetch) { return }

  isLoading.value = true

  try {
    // The language the guide's titles come back in. YouTube names its own
    // destinations, since they are its destinations and it has words for them
    // in every language we ship.
    const categories = await discoverExploreCategories(region.value, locale.value)

    store.commit('setExploreCache', {
      region: region.value,
      value: { fetchedAt: new Date(), categories }
    })
  } catch (error) {
    console.error(error)
    const errorMessage = t('Local API Error (Click to copy)')
    showToast(`${errorMessage}: ${error}`, 10000, () => {
      copyToClipboard(error)
    })
  } finally {
    isLoading.value = false
  }
}

/** Throw away what is shown and ask again. */
function refresh() {
  store.commit('clearExploreCache', region.value)

  discover(true)
}

/**
 * @param {string} id
 */
function categoryIsShown(id) {
  return exploreCategoryIsShown(id)
}

/**
 * @param {string} id
 */
function toggleCategory(id) {
  setExploreCategoryShown(id, !exploreCategoryIsShown(id))
}

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
      if (!isLoading.value) {
        refresh()
      }
      break
  }
}

/**
 * A new region is a different page: different destinations on offer, and
 * different videos behind each of them. Nothing watched this setting before,
 * so changing it did nothing until the next visit; now the page follows it
 * wherever it was changed, here or in the settings.
 *
 * Nothing is thrown away. The cache is keyed by region, so going back to one
 * looked at earlier in this session is instant, and a refresh is what asks
 * YouTube again.
 */
watch(region, () => discover())

onMounted(() => {
  discover()
  document.addEventListener('keydown', keyboardShortcutHandler)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboardShortcutHandler)
})
</script>

<style scoped src="../../components/FtToggleChip/chipRow.css" />
<style scoped src="./Explore.css" />
