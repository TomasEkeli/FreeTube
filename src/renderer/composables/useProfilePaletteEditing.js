import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../store/index'
import { calculateColorLuminance, colors } from '../helpers/colors'
import { pickUnusedColour } from '../helpers/channelsOverview'
import { showToast } from '../helpers/utils'

/** @import { Profile } from '../helpers/channelsOverview' */

const COLOUR_VALUES = colors.map(colour => colour.value)

/**
 * Puts the focus on a profile's bubble in the palette, if it has one.
 * @param {string} profileId
 */
export function focusBubble(profileId) {
  document.querySelector(`.palette [data-profile-id="${CSS.escape(profileId)}"] [role="button"]`)?.focus()
}

/**
 * Making, renaming, recolouring and reordering profiles from the palette on
 * the Channels page. The palette says what was done to it; this works out what
 * that means for the store, and holds what is half done: a new profile being
 * named, a profile being renamed, a menu open over a bubble.
 *
 * @param {object} options
 * @param {import('vue').ComputedRef<Profile[]>} options.profileList every profile, in order
 * @param {<T>(change: () => Promise<T>) => Promise<T>} options.afterPendingChanges the page's queue of profile writes
 * @param {(profileId: string) => void} options.openColumn
 */
export function useProfilePaletteEditing({ profileList, afterPendingChanges, openColumn }) {
  const { t } = useI18n()

  /**
   * The new profile being named, at the end of the palette. Null while there
   * is none; never more than one.
   * @type {import('vue').Ref<{ bgColor: string, saving: boolean } | null>}
   */
  const draft = ref(null)

  function startDraft() {
    if (draft.value !== null) { return }

    draft.value = { bgColor: pickUnusedColour(COLOUR_VALUES, profileList.value), saving: false }
  }

  function cancelDraft() {
    if (draft.value?.saving) { return }

    draft.value = null
  }

  /**
   * @param {string} name
   * @param {boolean} hadFocus
   */
  async function commitDraft(name, hadFocus) {
    if (draft.value === null || draft.value.saving) { return }

    const { bgColor } = draft.value
    draft.value = { bgColor, saving: true }

    const created = await store.dispatch('createProfile', {
      name,
      bgColor,
      textColor: calculateColorLuminance(bgColor),
      subscriptions: []
    })

    // Gone whether it worked or not: a draft stuck saving could never be
    // given up
    draft.value = null

    if (!created) { return }

    showToast(t('Profile.Profile has been created'))
    openColumn(created._id)

    // Only when the name was finished in the field: one finished by clicking
    // somewhere else leaves the focus where that click put it
    if (hadFocus) {
      await nextTick()
      focusBubble(created._id)
    }
  }

  return {
    draft,
    startDraft,
    commitDraft,
    cancelDraft
  }
}
