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
    <FtFlexBox class="pathRow">
      <p class="pathLabel">
        {{ t('Settings.yt-dlp Settings.Download Folder') }}
      </p>
      <FtInput
        class="pathValue"
        :placeholder="downloadFolder || t('Settings.yt-dlp Settings.System Downloads Folder')"
        :show-action-button="false"
        :show-label="false"
        :disabled="true"
      />
      <FtButton
        :label="t('Settings.yt-dlp Settings.Choose Folder')"
        class="pathButton"
        @click="chooseFolder"
      />
      <FtButton
        v-if="downloadFolder !== ''"
        :label="t('Settings.yt-dlp Settings.Use Downloads Folder')"
        class="pathButton"
        text-color="var(--text-with-main-color)"
        background-color="var(--primary-color)"
        @click="clearFolder"
      />
    </FtFlexBox>
    <FtFlexBox>
      <FtInputTags
        :label="t('Settings.yt-dlp Settings.Custom Arguments')"
        :tag-name-placeholder="t('Settings.yt-dlp Settings.Custom Arguments')"
        :tag-list="customArgs"
        :tooltip="t('Tooltips.yt-dlp Settings.Custom Arguments')"
        :show-tags="showCustomArgs"
        @change="updateCustomArgs"
        @toggle-show-tags="showCustomArgs = !showCustomArgs"
      />
    </FtFlexBox>
  </FtSettingsSection>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtInput from '../FtInput/FtInput.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtInputTags from '../FtInputTags/FtInputTags.vue'

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

/** @type {import('vue').ComputedRef<string>} */
const downloadFolder = computed(() => store.getters.getYtDlpDownloadFolder)

function chooseFolder() {
  // Main shows the picker and saves the choice, the settings sync brings it here
  window.ftElectron.ytDlpChooseFolder()
}

function clearFolder() {
  store.dispatch('updateYtDlpDownloadFolder', '')
}

/** @type {import('vue').ComputedRef<string[]>} */
const customArgs = computed(() => JSON.parse(store.getters.getYtDlpCustomArgs))

const showCustomArgs = ref(true)

/**
 * @param {string[]} args
 */
function updateCustomArgs(args) {
  store.dispatch('updateYtDlpCustomArgs', JSON.stringify(args))
}
</script>

<style scoped src="./YtDlpSettings.css" />
