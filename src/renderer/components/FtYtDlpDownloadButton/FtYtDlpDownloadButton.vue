<template>
  <span
    v-if="visible"
    class="ytDlpDownloadButton"
  >
    <!-- Finished: the way to the file, with downloading again a right click or long press away -->
    <FtIconButton
      v-if="state === 'finished'"
      :title="finishedTitle"
      :icon="['fas', 'folder-open']"
      theme="secondary"
      :dropdown-options="finishedOptions"
      open-on-right-or-long-click
      @click="handleFinishedClick"
    />
    <template v-else>
      <FtIconButton
        :title="buttonTitle"
        :icon="['fas', 'download']"
        theme="secondary"
        @click="handleClick"
      />
      <FtProgressRing
        v-if="state === 'running'"
        class="ring"
        :fraction="fraction"
      />
    </template>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons'

import FtIconButton from '../FtIconButton/FtIconButton.vue'
import FtProgressRing from '../FtProgressRing/FtProgressRing.vue'

import store from '../../store/index'
import { library } from '../../fontawesome-minimal'
import { downloadWithYtDlp } from '../../helpers/ytdlp'
import {
  detailsText,
  isRunning,
  progressFraction,
  revealYtDlpDownload,
  statusText,
  whereText,
  ytDlpDownloads,
} from '../../helpers/ytdlpDownloads'

// Registered here rather than in main.js, to keep the fork out of upstream's list
library.add(faFolderOpen)

const props = defineProps({
  videoId: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: ''
  },
  isLive: {
    type: Boolean,
    default: false
  },
  isUpcoming: {
    type: Boolean,
    default: false
  }
})

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const enabled = computed(() => store.getters.getYtDlpEnabled)

// Nothing to download yet from an upcoming video, and no end to a live one
const visible = computed(() => {
  return !!process.env.IS_ELECTRON && enabled.value && !props.isLive && !props.isUpcoming
})

const download = computed(() => ytDlpDownloads.byId[props.videoId])

/**
 * Running while a download of this video is under way; finished once this
 * session has a file for it, until it is downloaded again; otherwise idle,
 * which covers a failed or cancelled attempt, since pressing again resumes.
 */
const state = computed(() => {
  if (isRunning(download.value)) {
    return 'running'
  }

  if (props.videoId in ytDlpDownloads.finished && download.value?.status !== 'failed' && download.value?.status !== 'cancelled') {
    return 'finished'
  }

  return 'idle'
})

const fraction = computed(() => (download.value ? progressFraction(download.value) : null))

const buttonTitle = computed(() => {
  if (state.value !== 'running') {
    return t('Video.yt-dlp.Download with yt-dlp')
  }

  // Stage, progress and where it is going, one per line
  return [statusText(download.value), detailsText(download.value), whereText(download.value)]
    .filter(line => line !== '')
    .join('\n')
})

const finishedPath = computed(() => ytDlpDownloads.finished[props.videoId] ?? download.value?.folder ?? '')

const finishedTitle = computed(() => t('Video.yt-dlp.Show in folder', { path: finishedPath.value }))

const finishedOptions = computed(() => [
  { label: t('Video.yt-dlp.Downloads.Show in folder'), value: 'reveal' },
  { label: t('Video.yt-dlp.Download again'), value: 'download' },
])

function handleClick() {
  if (state.value === 'running') {
    // Rather than being told it is already downloading: see how it is doing
    ytDlpDownloads.panelOpen = true
    return
  }

  downloadWithYtDlp(props.videoId, props.title)
}

/**
 * @param {'reveal' | 'download' | undefined} choice from the dropdown, or nothing for a plain click
 */
function handleFinishedClick(choice) {
  if (choice === 'download') {
    downloadWithYtDlp(props.videoId, props.title)
  } else {
    revealYtDlpDownload(props.videoId)
  }
}
</script>

<style scoped src="./FtYtDlpDownloadButton.css" />
