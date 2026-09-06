<!--
  How much room a card gets, chosen on the page it is chosen for.

  The setting is global, so this writes it globally: every grid in the app
  answers to the same three modes, and a switch on one page moves them all.
  Seeing the stream while you change it is the whole difference between
  choosing a density and guessing at one, which is why the switch stands over
  the stream and the settings entry is only a second way in.

  Radio buttons under the paint, because exactly one mode is on at a time and
  the keyboard should say so: arrow keys move between them, as they do in any
  other group of radios. The subscription chips beside it are buttons instead,
  and rightly so, since any number of them may be pressed at once.

  Where it goes, on every grid surface that has one:

  - A page that already has a row of controls puts the switch in it. That is
    subscriptions and explore with their chips, history and your playlists with
    their search options, and a channel with its sorts.
  - A page with no such row puts the switch at the far end of its heading.
    That is most popular, search results and a hashtag.

  No page grows a second row to hold it, which is the rule the placements
  answer to: the switch is worth a corner of a row that exists and is not worth
  a band of its own above every grid in the app.

  One size, not a compact variant for the tighter headings. The three words are
  the control — a variant that shortened or dropped them would be a second
  control to learn, and the switch already wraps under the heading when a
  narrow window leaves no room beside it.
-->
<template>
  <div class="densitySwitch">
    <span
      :id="labelId"
      class="densityLabel"
    >
      {{ t('Global.Density.Label') }}
    </span>
    <div
      class="densityOptions"
      role="radiogroup"
      :aria-labelledby="labelId"
    >
      <label
        v-for="mode in DENSITY_MODES"
        :key="mode"
        class="densityOption"
      >
        <input
          v-model="listDensity"
          class="densityInput"
          type="radio"
          :name="groupName"
          :value="mode"
        >
        <span
          class="densityText"
          :class="{ densityTextChosen: mode === listDensity }"
        >
          {{ modeNames[mode] }}
        </span>
      </label>
    </div>
  </div>
</template>

<script setup>
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../../store/index'

import { DENSITY_MODES, useDensityModeNames } from '../../composables/useDensityModes'

const { t } = useI18n()

const labelId = useId()

// Named per instance: two switches on one page would otherwise be one group of
// six radios, and choosing in either would clear the other.
const groupName = useId()

const modeNames = useDensityModeNames()

/**
 * Reading and writing the one global setting, which is all the state there is
 * here. Writing it persists it, and every grid in the app follows as soon as
 * the write lands.
 *
 * @type {import('vue').WritableComputedRef<'tight' | 'standard' | 'spacious'>}
 */
const listDensity = computed({
  get: () => store.getters.getListDensity,
  set: (mode) => store.dispatch('updateListDensity', mode)
})
</script>

<style scoped src="./FtDensitySwitch.css" />
