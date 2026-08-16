<template>
  <FtSettingsSection
    :title="$t('Settings.Experimental Settings.Experimental Settings')"
  >
    <p class="experimental-warning">
      {{ $t('Settings.Experimental Settings.Warning') }}
    </p>
    <FtFlexBox>
      <FtToggleSwitch
        tooltip-position="top"
        :label="$t('Settings.Experimental Settings.Replace HTTP Cache')"
        compact
        :default-value="replaceHttpCache"
        :disabled="replaceHttpCacheLoading"
        :tooltip="$t('Tooltips.Experimental Settings.Replace HTTP Cache')"
        @change="handleRestartPrompt"
      />
      <FtToggleSwitch
        v-if="supportsLocalApi"
        tooltip-position="top"
        :label="$t('Settings.Experimental Settings.Regulated Streaming')"
        compact
        :default-value="regulatedStreaming"
        :tooltip="$t('Tooltips.Experimental Settings.Regulated Streaming')"
        @change="handleRegulatedStreaming"
      />
    </FtFlexBox>
    <FtPrompt
      v-if="showRestartPrompt"
      :label="$t('Settings[\'The app needs to restart for changes to take effect. Restart and apply change?\']')"
      :option-names="[$t('Yes, Restart'), $t('Cancel')]"
      :option-values="['restart', 'cancel']"
      @click="handleReplaceHttpCache"
    />
  </FtSettingsSection>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'

import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import FtPrompt from '../FtPrompt/FtPrompt.vue'

import store from '../../store/index'

const replaceHttpCacheLoading = ref(true)
const replaceHttpCache = ref(false)
const showRestartPrompt = ref(false)

/**
 * SABR is the local API's transport, so there is nothing here to regulate on a
 * build that cannot use it.
 */
const supportsLocalApi = process.env.SUPPORTS_LOCAL_API

/** @type {import('vue').ComputedRef<boolean>} */
const regulatedStreaming = computed(() => store.getters.getEnableRegulatedStreaming)

/**
 * @param {boolean} value
 */
function handleRegulatedStreaming(value) {
  store.dispatch('updateEnableRegulatedStreaming', value)
}

onMounted(async () => {
  if (process.env.IS_ELECTRON) {
    replaceHttpCache.value = await window.ftElectron.getReplaceHttpCache()
  }

  replaceHttpCacheLoading.value = false
})

/**
 * @param {boolean} value
 */
function handleRestartPrompt(value) {
  replaceHttpCache.value = value
  showRestartPrompt.value = true
}

/**
 * @param {'restart' | 'cancel' | null} value
 */
function handleReplaceHttpCache(value) {
  showRestartPrompt.value = false

  if (value === null || value === 'cancel') {
    replaceHttpCache.value = !replaceHttpCache.value
    return
  }

  if (process.env.IS_ELECTRON) {
    window.ftElectron.toggleReplaceHttpCache()
  }
}
</script>

<style scoped src="./ExperimentalSettings.css" />
