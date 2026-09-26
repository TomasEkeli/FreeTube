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
    <div class="tools">
      <h4 class="toolsHeading">
        {{ t('Settings.yt-dlp Settings.Tools') }}
      </h4>
      <ul class="toolList">
        <li
          v-for="tool in TOOLS"
          :key="tool"
          class="toolRow"
        >
          <span class="toolName">{{ TOOL_NAMES[tool] }}</span>
          <span
            v-if="statuses === null"
            class="toolStatus"
          >
            {{ t('Settings.yt-dlp Settings.Looking') }}
          </span>
          <span
            v-else-if="statuses[tool].found"
            class="toolStatus"
          >
            {{ statuses[tool].version }}
            <span class="toolSource">
              {{ sourceText(statuses[tool]) }}
            </span>
          </span>
          <span
            v-else
            class="toolStatus toolMissing"
          >
            {{ t('Settings.yt-dlp Settings.Not found') }}
          </span>
        </li>
      </ul>
      <p
        v-if="statuses !== null && !statuses['yt-dlp'].found"
        class="toolWarning"
      >
        {{ t('Settings.yt-dlp Settings.yt-dlp Missing Warning') }}
      </p>
      <p
        v-if="statuses !== null && !statuses.ffmpeg.found"
        class="toolWarning"
      >
        {{ t('Settings.yt-dlp Settings.ffmpeg Missing Warning') }}
      </p>
      <p
        v-if="statuses !== null && !statuses.deno.found"
        class="toolWarning"
      >
        {{ t('Settings.yt-dlp Settings.Deno Missing Warning') }}
      </p>
    </div>
    <FtFlexBox class="pathRow">
      <p class="pathLabel">
        {{ t('Settings.yt-dlp Settings.yt-dlp Executable') }}
      </p>
      <FtInput
        class="pathValue"
        :placeholder="executablePath || t('Settings.yt-dlp Settings.Found Automatically')"
        :show-action-button="false"
        :show-label="false"
        :disabled="true"
      />
      <FtButton
        :label="t('Settings.yt-dlp Settings.Choose File')"
        class="pathButton"
        @click="chooseExecutable"
      />
      <FtButton
        v-if="executablePath !== ''"
        :label="t('Settings.yt-dlp Settings.Find Automatically')"
        class="pathButton"
        text-color="var(--text-with-main-color)"
        background-color="var(--primary-color)"
        @click="clearExecutable"
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
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import FtSettingsSection from '../FtSettingsSection/FtSettingsSection.vue'
import FtToggleSwitch from '../FtToggleSwitch/FtToggleSwitch.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtInput from '../FtInput/FtInput.vue'
import FtButton from '../FtButton/FtButton.vue'
import FtInputTags from '../FtInputTags/FtInputTags.vue'

import store from '../../store/index'
import { TOOL_NAMES } from '../../helpers/ytdlp'

const { t } = useI18n()

const TOOLS = /** @type {const} */ (['yt-dlp', 'ffmpeg', 'deno'])

/** @type {import('vue').Ref<import('../../../main/ytdlp/toolDetection').ToolStatuses | null>} */
const statuses = ref(null)

async function detectTools() {
  statuses.value = null
  statuses.value = (await window.ftElectron.ytDlpDetectTools()).tools
}

onMounted(detectTools)

/**
 * @param {import('../../../main/ytdlp/toolDetection').ToolStatus} status
 */
function sourceText(status) {
  switch (status.source) {
    case 'picked':
      return t('Settings.yt-dlp Settings.Source Picked', { path: status.path })
    case 'managed':
      return t('Settings.yt-dlp Settings.Source Managed')
    default:
      return t('Settings.yt-dlp Settings.Source Path', { path: status.path })
  }
}

/** @type {import('vue').ComputedRef<string>} */
const executablePath = computed(() => store.getters.getYtDlpExecutablePath)

async function chooseExecutable() {
  // Main shows the picker and saves the choice, the settings sync brings it here
  const chosen = await window.ftElectron.ytDlpChooseExecutable()

  if (chosen) {
    await detectTools()
  }
}

async function clearExecutable() {
  await store.dispatch('updateYtDlpExecutablePath', '')
  await detectTools()
}

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
