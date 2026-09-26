import { computed, onScopeDispose, ref, shallowRef, toRaw } from 'vue'

import store from '../store/index'
import { channelMemberships } from '../helpers/channelsOverview'
import { addKeep, proposeProfiles, pruneKeeps, watchedCategories } from '../helpers/profileSuggestions'

/** @import { Profile } from '../helpers/channelsOverview' */
/** @import { Proposals } from '../helpers/profileSuggestions' */

/**
 * Whether the suggestions are shown, and which were dismissed. Kept here,
 * outside the page, so that both last as long as the window does: leaving the
 * page and coming back finds them as they were. Neither is ever saved.
 */
const shown = ref(false)

/** @type {import('vue').ShallowRef<Set<string>>} */
const dismissed = shallowRef(new Set())

/** The mutations that change what is remembered of channels' tags */
const TAG_MUTATIONS = new Set(['updateChannelTagsByChannel', 'setChannelTags'])

/**
 * How long newly remembered tags wait before the suggestions are worked out
 * again. A refresh remembers them a channel at a time, hundreds in a minute,
 * and each one would otherwise mean working everything out again.
 */
const TAGS_SETTLE_MS = 1000

/**
 * The suggestions on the Channels page: proposed columns worked out from what
 * the app has seen of each channel, the channels no suggestion took, and how
 * much is known. Worked out again on every change to the profiles, to what is
 * remembered and to what was dismissed, and never stored, so a channel filed
 * leaves its suggestion at once.
 *
 * @param {object} options
 * @param {import('vue').ComputedRef<Profile[]>} options.profileList every profile, in order
 * @param {import('vue').ComputedRef<Intl.Collator>} options.collator
 */
export function useProfileSuggestions({ profileList, collator }) {
  /** Only worked out while shown: computed values are not, until read */
  const watched = computed(() => watchedCategories(store.getters.getHistoryCacheSorted))

  const tagsVersion = ref(0)
  let tagsTimeout = null

  const unsubscribe = store.subscribe((mutation) => {
    if (!TAG_MUTATIONS.has(mutation.type) || tagsTimeout !== null) { return }

    tagsTimeout = setTimeout(() => {
      tagsTimeout = null
      tagsVersion.value++
    }, TAGS_SETTLE_MS)
  })

  onScopeDispose(() => {
    unsubscribe()
    clearTimeout(tagsTimeout)
  })

  /**
   * What is remembered of the channels' tags, as a plain copy taken when
   * they last settled. Plain, so that reading two thousand of them is not two
   * thousand reactive reads.
   */
  const channelTags = computed(() => {
    // eslint-disable-next-line no-unused-expressions
    tagsVersion.value

    return { ...toRaw(store.getters.getChannelTags) }
  })

  /** @type {import('vue').ComputedRef<Record<string, string>>} */
  const keeps = computed(() => store.getters.getProfileSuggestionKeeps ?? {})

  /** @type {import('vue').ComputedRef<Proposals | null>} null while hidden */
  const suggestions = computed(() => {
    if (!shown.value) { return null }

    return proposeProfiles({
      profileList: profileList.value,
      channelTags: channelTags.value,
      watched: watched.value,
      keeps: keeps.value,
      collator: collator.value,
      dismissed: dismissed.value
    })
  })

  function toggleSuggestions() {
    shown.value = !shown.value
  }

  /**
   * For the rest of the session: its channels in the pool go back to the
   * pool, and are not grouped under another name.
   * @param {string} key
   */
  function dismiss(key) {
    dismissed.value = new Set([...dismissed.value, key])
  }

  /**
   * Tells the app a channel stays in the profile it is in, which it
   * remembers until the channel is moved.
   * @param {string} channelId
   * @param {string} profileId
   */
  function keepIn(channelId, profileId) {
    const next = addKeep(keeps.value, channelMemberships(profileList.value), channelId, profileId)

    store.dispatch('saveProfileSuggestionKeeps', next)
  }

  /**
   * Forgets the keeps of channels no longer where they were kept, so that
   * one moved away and back again is not kept a second time. For after a
   * change to the profiles.
   */
  function dropLapsedKeeps() {
    const current = keeps.value
    const next = pruneKeeps(current, channelMemberships(profileList.value))

    if (next !== current) {
      store.dispatch('saveProfileSuggestionKeeps', next)
    }
  }

  return { shown, suggestions, toggleSuggestions, dismiss, keepIn, dropLapsedKeeps }
}
