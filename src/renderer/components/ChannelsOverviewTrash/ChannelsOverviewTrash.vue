<!--
  Where channels are dropped to unsubscribe from them. The one thing on the
  Channels page that loses anything: an unsubscribed channel leaves every
  profile it was in. So a drop here only asks; the page confirms first.
-->
<template>
  <div
    class="trash"
    :class="{ dropTarget: dragOver }"
    :title="t('Channels.Overview.Trash Hint')"
    v-on="dropHandlers"
  >
    <FontAwesomeIcon
      class="trashIcon"
      :icon="['fas', 'trash']"
      aria-hidden="true"
    />
    <span class="trashLabel">
      {{ t('Channels.Overview.Trash') }}
    </span>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

const emit = defineEmits(['drop-channels'])

const { t } = useI18n()

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged) => emit('drop-channels', dragged),
  canCopy: () => false
})
</script>

<style scoped src="./ChannelsOverviewTrash.css" />
