<template>
  <FtSettingsSection
    :title="$t('Settings.SponsorBlock Settings.SponsorBlock Settings')"
  >
    <FtFlexBox class="settingsFlexStart500px">
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.Enable SponsorBlock')"
        :default-value="useSponsorBlock"
        @change="handleUpdateSponsorBlock"
      />
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.UseDeArrowTitles')"
        :default-value="useDeArrowTitles"
        :tooltip="$t('Tooltips.SponsorBlock Settings.UseDeArrowTitles')"
        @change="handleUpdateUseDeArrowTitles"
      />
      <FtToggleSwitch
        :label="$t('Settings.SponsorBlock Settings.UseDeArrowThumbnails')"
        :default-value="useDeArrowThumbnails"
        :tooltip="$t('Tooltips.SponsorBlock Settings.UseDeArrowThumbnails')"
        @change="handleUpdateUseDeArrowThumbnails"
      />
    </FtFlexBox>
    <template
      v-if="useSponsorBlock || useDeArrowTitles || useDeArrowThumbnails"
    >
      <FtFlexBox
        v-if="useSponsorBlock"
        class="settingsFlexStart500px"
      >
        <FtToggleSwitch
          :label="$t('Settings.SponsorBlock Settings.Notify when sponsor segment is skipped')"
          :default-value="sponsorBlockShowSkippedToast"
          @change="handleUpdateSponsorBlockShowSkippedToast"
        />
      </FtFlexBox>
      <FtFlexBox>
        <FtInput
          ref="sponsorBlockUrlInput"
          :placeholder="$t('Settings.SponsorBlock Settings[\'SponsorBlock API Url (Default is https://sponsor.ajay.app)\']')"
          :show-action-button="false"
          :show-label="true"
          :value="sponsorBlockUrl"
          @blur="handleUpdateSponsorBlockUrl"
        />
      </FtFlexBox>
      <FtFlexBox
        v-if="useDeArrowThumbnails"
      >
        <FtInput
          ref="deArrowThumbnailGeneratorUrl"
          :placeholder="$t('Settings.SponsorBlock Settings[\'DeArrow Thumbnail Generator API Url (Default is https://dearrow-thumb.ajay.app)\']')"
          :show-action-button="false"
          :show-label="true"
          :value="deArrowThumbnailGeneratorUrl"
          @blur="handleUpdateDeArrowThumbnailGeneratorUrl"
        />
      </FtFlexBox>

      <FtFlexBox
        v-if="useSponsorBlock"
      >
        <FtSponsorBlockCategory
          v-for="category in CATEGORIES"
          :key="category"
          :category-name="category"
        />
      </FtFlexBox>

      <details
        v-if="useSponsorBlock"
        class="markOnlyDetails"
      >
        <summary class="markOnlySummary">
          <h3 class="markOnlyTitle">
            {{ $t('SponsorBlock.Channels That Are Never Skipped') }}
            <span class="markOnlyCount">
              • {{ markOnlyChannels.length }}
            </span>

            <FontAwesomeIcon
              class="markOnlyChevron"
              :icon="['fas', 'chevron-right']"
            />
          </h3>
        </summary>

        <p class="markOnlyExplanation">
          {{ $t('SponsorBlock.Channels That Are Never Skipped Explanation') }}
        </p>

        <p
          v-if="markOnlyChannels.length === 0"
          class="markOnlyEmpty"
        >
          {{ $t('SponsorBlock.No Channels Are On The List') }}
        </p>

        <template v-else>
          <FtCheckboxList
            v-model="selectedChannelIds"
            :title="$t('SponsorBlock.Select Channels To Remove')"
            :labels="markOnlyChannelNames"
            :values="markOnlyChannelIds"
          />

          <FtFlexBox class="markOnlyActions">
            <FtButton
              :label="allSelected ? $t('SponsorBlock.Select None') : $t('SponsorBlock.Select All')"
              @click="toggleSelectAll"
            />
            <FtButton
              :label="$t('SponsorBlock.Remove Selected')"
              :disabled="selectedChannelIds.length === 0"
              @click="removeSelected"
            />
            <FtButton
              :label="$t('SponsorBlock.Remove All')"
              background-color="var(--destructive-color)"
              text-color="var(--destructive-text-color)"
              @click="removeAll"
            />
          </FtFlexBox>
        </template>
      </details>
    </template>
  </FtSettingsSection>
</template>

<script setup>
import { computed, ref, useTemplateRef, watch } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'

import FtSettingsSection from './FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from './FtToggleSwitch/FtToggleSwitch.vue'
import FtInput from './FtInput/FtInput.vue'
import FtButton from './FtButton/FtButton.vue'
import FtCheckboxList from './FtCheckboxList/FtCheckboxList.vue'
import FtFlexBox from './ft-flex-box/ft-flex-box.vue'
import FtSponsorBlockCategory from './FtSponsorBlockCategory/FtSponsorBlockCategory.vue'

import store from '../store/index'

import { removeSponsorBlockMarkOnlyChannels } from '../helpers/sponsorblock'

const CATEGORIES = [
  'sponsor',
  'self-promotion',
  'interaction',
  'intro',
  'outro',
  'recap',
  'music offtopic',
  'filler'
]

/** @type {import('vue').ComputedRef<boolean>} */
const useSponsorBlock = computed(() => store.getters.getUseSponsorBlock)

/** @type {import('vue').ComputedRef<string>} */
const sponsorBlockUrl = computed(() => store.getters.getSponsorBlockUrl)

/** @type {import('vue').ComputedRef<boolean>} */
const sponsorBlockShowSkippedToast = computed(() => store.getters.getSponsorBlockShowSkippedToast)

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowTitles = computed(() => store.getters.getUseDeArrowTitles)

/** @type {import('vue').ComputedRef<boolean>} */
const useDeArrowThumbnails = computed(() => store.getters.getUseDeArrowThumbnails)

/** @type {import('vue').ComputedRef<string>} */
const deArrowThumbnailGeneratorUrl = computed(() => store.getters.getDeArrowThumbnailGeneratorUrl)

const sponsorBlockUrlInputRef = useTemplateRef('sponsorBlockUrlInput')
const deArrowThumbnailGeneratorUrlRef = useTemplateRef('deArrowThumbnailGeneratorUrl')

/**
 * @param {boolean} value
 */
function handleUpdateSponsorBlock(value) {
  store.dispatch('updateUseSponsorBlock', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateUseDeArrowTitles(value) {
  store.dispatch('updateUseDeArrowTitles', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateUseDeArrowThumbnails(value) {
  store.dispatch('updateUseDeArrowThumbnails', value)
}

/**
 * @param {boolean} value
 */
function handleUpdateSponsorBlockShowSkippedToast(value) {
  store.dispatch('updateSponsorBlockShowSkippedToast', value)
}

/**
 * @param {string} value
 */
function handleUpdateSponsorBlockUrl(value) {
  const cleanValue = cleanupUrl(value)
  store.dispatch('updateSponsorBlockUrl', cleanValue)

  if (cleanValue !== value) {
    sponsorBlockUrlInputRef.value?.setText(cleanValue)
  }
}

/**
 * @param {string} value
 */
function handleUpdateDeArrowThumbnailGeneratorUrl(value) {
  const cleanValue = cleanupUrl(value)
  store.dispatch('updateDeArrowThumbnailGeneratorUrl', cleanValue)

  if (cleanValue !== value) {
    deArrowThumbnailGeneratorUrlRef.value?.setText(cleanValue)
  }
}

/**
 * @param {string} url
 */
function cleanupUrl(url) {
  return url
    .replace(/\/+$/, '')
    .replace(/\/api$/, '')
}

/** @type {import('vue').ComputedRef<{ id: string, name: string }[]>} */
const markOnlyChannels = computed(() => store.getters.getSponsorBlockMarkOnlyChannels)

const markOnlyChannelIds = computed(() => markOnlyChannels.value.map(channel => channel.id))

const markOnlyChannelNames = computed(() => markOnlyChannels.value.map(channel => channel.name))

/** @type {import('vue').Ref<string[]>} */
const selectedChannelIds = ref([])

// A selection only means anything while the channels it names are still listed,
// so drop any that leave, whether they left from here or from a channel page.
watch(markOnlyChannelIds, (ids) => {
  selectedChannelIds.value = selectedChannelIds.value.filter(id => ids.includes(id))
})

const allSelected = computed(() => {
  return markOnlyChannels.value.length > 0 &&
    selectedChannelIds.value.length === markOnlyChannels.value.length
})

function toggleSelectAll() {
  selectedChannelIds.value = allSelected.value ? [] : [...markOnlyChannelIds.value]
}

function removeSelected() {
  if (selectedChannelIds.value.length === 0) {
    return
  }

  removeSponsorBlockMarkOnlyChannels(selectedChannelIds.value)
}

function removeAll() {
  removeSponsorBlockMarkOnlyChannels(markOnlyChannelIds.value)
}
</script>

<style scoped>
.markOnlyDetails {
  inline-size: 100%;
  margin-block-start: 10px;
}

.markOnlySummary {
  cursor: pointer;
  list-style: none;
}

.markOnlyTitle {
  margin-block: 0;
}

.markOnlyCount {
  font-size: 15px;
  font-weight: normal;
  opacity: 0.7;
}

.markOnlyChevron {
  vertical-align: middle;
}

.markOnlyDetails[open] .markOnlyChevron {
  transform: translateX(4px) rotate(90deg);
}

.markOnlyDetails[open]:dir(rtl) .markOnlyChevron {
  transform: translateX(-4px) rotate(90deg);
}

.markOnlyExplanation,
.markOnlyEmpty {
  opacity: 0.7;
}

.markOnlyActions {
  margin-block-start: 10px;
}

.markOnlyActions :deep(button:disabled) {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
