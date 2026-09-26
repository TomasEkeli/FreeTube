<template>
  <FtSettingsSection
    :title="t('Settings.yt-dlp Settings.yt-dlp Settings')"
  >
    <FtFlexBox>
      <FtToggleSwitch
        :label="t('Settings.yt-dlp Settings.Enable Download Button')"
        :default-value="ytDlpEnabled"
        :compact="true"
        :tooltip="t('Tooltips.yt-dlp Settings.Enable Download Button')"
        @change="updateYtDlpEnabled"
      />
    </FtFlexBox>
  </FtSettingsSection>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'

import store from '../../store/index'

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const ytDlpEnabled = computed(() => store.getters.getYtDlpEnabled)

/**
 * @param {boolean} value
 */
function updateYtDlpEnabled(value) {
  store.dispatch('updateYtDlpEnabled', value)
}
</script>
