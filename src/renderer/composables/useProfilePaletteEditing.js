import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import store from '../store/index'
import { calculateColorLuminance, colors } from '../helpers/colors'
import { pickUnusedColour } from '../helpers/channelsOverview'
import { deepCopy, showToast } from '../helpers/utils'

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

  /** @type {import('vue').Ref<string | null>} */
  const renamingProfileId = ref(null)

  /**
   * Saves a change to one profile, shown at once and then written, as a drop
   * is. In the page's queue, and reading the profile when its turn comes: the
   * whole profile is written, subscriptions and all, and one read before an
   * earlier drop had landed would put back what the drop changed.
   * @param {string} profileId
   * @param {Partial<Profile>} changes
   * @returns {Promise<void>}
   */
  function saveProfile(profileId, changes) {
    return afterPendingChanges(async () => {
      const profile = profileList.value.find(candidate => candidate._id === profileId)

      if (!profile) { return }

      const saved = { ...deepCopy(profile), ...changes }

      store.commit('upsertProfileToList', deepCopy(saved))
      await store.dispatch('updateProfile', saved)
    })
  }

  /**
   * @param {string} profileId
   * @param {string | null} name null when it was given up
   */
  function finishRename(profileId, name) {
    renamingProfileId.value = null

    const profile = profileList.value.find(candidate => candidate._id === profileId)

    if (name === null || !profile || name === profile.name) { return }

    saveProfile(profileId, { name })
  }

  /**
   * The menu a right-click on a bubble opens. Null while it is closed.
   * @type {import('vue').ShallowRef<{ profileId: string, name: string, anchor: object } | null>}
   */
  const profileMenu = shallowRef(null)

  /**
   * @param {string} profileId
   * @param {{ rect: DOMRect } | { x: number, y: number }} anchor
   */
  function openProfileMenu(profileId, anchor) {
    const profile = profileList.value.find(candidate => candidate._id === profileId)

    if (profile) {
      profileMenu.value = { profileId, name: profile.name, anchor }
    }
  }

  const profileMenuItems = computed(() => [
    { value: 'rename', label: t('Channels.Overview.Rename Profile') }
  ])

  /**
   * @param {string} value
   */
  function chooseFromProfileMenu(value) {
    if (profileMenu.value === null) { return }

    const { profileId } = profileMenu.value

    if (value === 'rename') {
      renamingProfileId.value = profileId
    }
  }

  /**
   * @param {boolean} returnFocus
   */
  function closeProfileMenu(returnFocus) {
    const profileId = profileMenu.value?.profileId
    profileMenu.value = null

    if (returnFocus && profileId) {
      focusBubble(profileId)
    }
  }

  return {
    draft,
    startDraft,
    commitDraft,
    cancelDraft,
    renamingProfileId,
    saveProfile,
    finishRename,
    profileMenu,
    profileMenuItems,
    openProfileMenu,
    chooseFromProfileMenu,
    closeProfileMenu
  }
}
