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
      <p
        v-for="tool in notCovered"
        :key="tool"
        class="toolWarning"
      >
        {{ t('Settings.yt-dlp Settings.Install It Yourself', { tool: TOOL_NAMES[tool] }) }}
        <a
          :href="INSTRUCTIONS_URLS[tool]"
          target="_blank"
          rel="noopener noreferrer"
        >{{ INSTRUCTIONS_URLS[tool] }}</a>
      </p>
      <FtFlexBox
        v-if="statuses !== null"
        class="toolActions"
      >
        <FtButton
          v-if="installable.length > 0 && !installing"
          :label="t('Settings.yt-dlp Settings.Install Missing Tools', { tools: formatToolList(installable) })"
          :icon="['fas', 'download']"
          @click="install"
        />
        <FtButton
          v-if="statuses['yt-dlp'].found && !installing"
          :label="updating ? t('Settings.yt-dlp Settings.Updating yt-dlp') : t('Settings.yt-dlp Settings.Update yt-dlp')"
          :icon="['fas', 'sync']"
          :disabled="updating || downloading"
          :title="downloading ? t('Settings.yt-dlp Settings.Update Unavailable While Downloading') : null"
          @click="update"
        />
        <p
          v-if="installing"
          class="toolProgress"
          role="status"
        >
          {{ progressText }}
        </p>
        <p
          v-else-if="installMessage !== ''"
          class="toolProgress"
          role="status"
        >
          {{ installMessage }}
        </p>
        <p
          v-if="!installing && downloading && statuses['yt-dlp'].found"
          class="toolProgress"
        >
          {{ t('Settings.yt-dlp Settings.Update Unavailable While Downloading') }}
        </p>
      </FtFlexBox>
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
import {
  formatInstallProgress,
  formatInstallResult,
  formatToolList,
  formatUpdateResult,
  installYtDlpTools,
  TOOL_NAMES,
  ytDlpInstallState,
} from '../../helpers/ytdlp'

// Where each project says to install it by hand, for when FreeTube cannot
const INSTRUCTIONS_URLS = {
  'yt-dlp': 'https://github.com/yt-dlp/yt-dlp/wiki/Installation',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds',
  deno: 'https://docs.deno.com/runtime/getting_started/installation/',
}

const { t } = useI18n()

const TOOLS = /** @type {const} */ (['yt-dlp', 'ffmpeg', 'deno'])

/** @type {import('vue').Ref<import('../../../main/ytdlp/toolDetection').ToolStatuses | null>} */
const statuses = ref(null)

/** @type {import('vue').Ref<Record<string, boolean>>} */
const coverage = ref({})

/** Installing in main, whether started here or elsewhere */
const installingElsewhere = ref(false)

async function detectTools() {
  statuses.value = null
  const detected = await window.ftElectron.ytDlpDetectTools()
  statuses.value = detected.tools
  coverage.value = detected.coverage
  installingElsewhere.value = detected.installing
  downloading.value = detected.downloading
}

/** A download is running, so yt-dlp may not be replaced under it */
const downloading = ref(false)

const updating = ref(false)

async function update() {
  installMessage.value = ''
  updating.value = true
  try {
    const result = await window.ftElectron.ytDlpUpdate()

    if (result) {
      installMessage.value = formatUpdateResult(result)
    }
  } finally {
    updating.value = false
  }

  await detectTools()
}

const missing = computed(() => {
  return statuses.value === null ? [] : TOOLS.filter(tool => !statuses.value[tool].found)
})

// What FreeTube can fetch here, and what it has to leave to the viewer
const installable = computed(() => missing.value.filter(tool => coverage.value[tool]))
const notCovered = computed(() => missing.value.filter(tool => !coverage.value[tool]))

const installing = computed(() => ytDlpInstallState.installing || installingElsewhere.value)

const progressText = computed(() => {
  return ytDlpInstallState.progress
    ? formatInstallProgress(ytDlpInstallState.progress)
    : t('Settings.yt-dlp Settings.Install Progress.Starting')
})

const installMessage = ref('')

async function install() {
  installMessage.value = ''
  const result = await installYtDlpTools()

  if (result) {
    installMessage.value = formatInstallResult(result)
  }

  await detectTools()
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
