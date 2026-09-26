<template>
  <FtIconButton
    v-if="visible"
    :title="t('Video.yt-dlp.Download with yt-dlp')"
    :icon="['fas', 'download']"
    theme="secondary"
    @click="download"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'
import { downloadWithYtDlp } from '../../helpers/ytdlp'

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

function download() {
  downloadWithYtDlp(props.videoId, props.title)
}
</script>
