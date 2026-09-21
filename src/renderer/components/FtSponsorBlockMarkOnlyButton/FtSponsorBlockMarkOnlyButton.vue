<template>
  <FtIconButton
    v-if="visible"
    :title="title"
    :icon="['fas', 'eye-slash']"
    :theme="markOnly ? 'base' : 'primary'"
    @click="toggle"
  />
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtIconButton from '../FtIconButton/FtIconButton.vue'

import store from '../../store/index'

import {
  isSponsorBlockMarkOnlyChannel,
  toggleSponsorBlockMarkOnlyChannel
} from '../../helpers/sponsorblock'
import { showToast } from '../../helpers/utils'

const props = defineProps({
  channelId: {
    type: String,
    required: true
  },
  channelName: {
    type: String,
    default: ''
  }
})

const { t } = useI18n()

/** @type {import('vue').ComputedRef<boolean>} */
const useSponsorBlock = computed(() => store.getters.getUseSponsorBlock)

// Nothing to say about skipping when nothing is skipping, and nothing to store
// an entry under until we know whose channel this is.
const visible = computed(() => useSponsorBlock.value && props.channelId !== '')

const markOnly = computed(() => isSponsorBlockMarkOnlyChannel(props.channelId))

const title = computed(() => {
  return markOnly.value
    ? t('SponsorBlock.Resume Skipping On This Channel')
    : t('SponsorBlock.Never Skip On This Channel')
})

async function toggle() {
  const channelName = props.channelName || props.channelId
  const nowMarkOnly = await toggleSponsorBlockMarkOnlyChannel(props.channelId, channelName)

  showToast(
    nowMarkOnly
      ? t('SponsorBlock.Segments Will Be Marked Only', { channelName })
      : t('SponsorBlock.Segments Will Be Skipped Again', { channelName })
  )
}
</script>
