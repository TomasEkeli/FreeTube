<!--
  Where channels are dropped to unsubscribe from them. The one thing on the
  Channels page that loses anything: an unsubscribed channel leaves every
  profile it was in. So a drop here only asks; the page confirms first.

  It is a button as well, for the keyboard: pressed, it asks the same about
  the selected channels. Not `disabled` without a selection, as a disabled
  button takes no drops either.
-->
<template>
  <button
    type="button"
    class="trash"
    :class="{ dropTarget: dragOver }"
    :title="t('Channels.Overview.Trash Hint')"
    :aria-disabled="hasSelection ? 'false' : 'true'"
    v-on="dropHandlers"
    @click="hasSelection && emit('unsubscribe-selection')"
  >
    <FontAwesomeIcon
      class="trashIcon"
      :icon="['fas', 'trash']"
      aria-hidden="true"
    />
    <span class="trashLabel">
      {{ t('Channels.Overview.Trash') }}
    </span>
  </button>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { useI18n } from 'vue-i18n'

import { useChannelDropTarget } from '../../composables/useChannelDropTarget'

defineProps({
  /** Whether there is a selection for the button to unsubscribe from */
  hasSelection: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['drop-channels', 'unsubscribe-selection'])

const { t } = useI18n()

const { dragOver, handlers: dropHandlers } = useChannelDropTarget({
  onDrop: (dragged) => emit('drop-channels', dragged),
  canCopy: () => false
})
</script>

<style scoped src="./ChannelsOverviewTrash.css" />
