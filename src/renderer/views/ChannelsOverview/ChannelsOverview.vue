<!--
  The Channels page: where subscriptions are sorted into profiles.

  Every profile is a bubble in the strip at the top, where profiles are also
  made, renamed, recoloured and put in order, and a few of them at a time are
  open as columns below. The primary profile is never a column, as it holds
  every subscription. Its place, pinned leftmost, goes to the channels no other
  profile has claimed, and that column is there to be emptied: once it is, it
  goes away, and it only comes back when something new lands in it.

  Suggest profiles adds proposed columns after the pool: channels the app
  thinks belong in one of the profiles, or together in a new one, from what
  it has seen of them. The pool then holds only what no suggestion took.
  Nothing changes until a suggestion is acted on, from the menu on its
  heading or by dragging its channels out.
-->
<template>
  <div class="channelsOverview">
    <h2 class="visuallyHidden">
      {{ t('Channels.Title') }}
    </h2>
    <FtCard
      v-if="allChannels.length === 0"
      class="emptyCard"
    >
      <p class="message">
        {{ t('Channels.Empty') }}
      </p>
    </FtCard>
    <template v-else>
      <FtCard class="paletteCard">
        <ChannelsOverviewPalette
          :profiles="profiles"
          :open-profile-ids="openProfileIds"
          :match-counts="matchCounts"
          :duplicate-counts="duplicateCountsByProfile"
          :draft="draft"
          :renaming-profile-id="renamingProfileId"
          @toggle="toggleColumn"
          @drop-channels="fileChannelsFromPalette"
          @new-profile="startDraft"
          @commit-draft="commitDraft"
          @cancel-draft="cancelDraft"
          @rename="finishRename"
          @menu="openProfileMenu"
          @reorder="reorder"
        />
        <p
          v-if="profiles.length === 0 && draft === null"
          class="message"
        >
          {{ t('Channels.Overview.No Profiles Yet') }}
        </p>
      </FtCard>
      <div
        ref="toolbar"
        class="toolbar"
        role="toolbar"
        :aria-label="t('Channels.Overview.Selection')"
      >
        <FtInput
          ref="searchInput"
          class="channelSearch"
          :placeholder="t('Channels.Search bar placeholder')"
          :value="query"
          :show-clear-text-button="true"
          :show-action-button="false"
          :maxlength="255"
          @input="(value) => query = value"
          @clear="query = ''"
        />
        <FtButton
          class="suggestButton"
          :label="suggestionsShown ? t('Channels.Overview.Suggestions.Hide Suggestions') : t('Channels.Overview.Suggestions.Suggest Profiles')"
          @click="toggleSuggestions"
        />
        <!-- Always there, so that a screen reader is listening before the count changes -->
        <span
          class="selectedCount"
          aria-live="polite"
        >
          <template v-if="selectedCount > 0">
            {{ t('Channels.Overview.Selected Count', { count: selectedCount }, selectedCount) }}
            <span
              v-if="hiddenSelectedCount > 0"
              class="hiddenSelected"
            >
              {{ t('Channels.Overview.Hidden by Search', { count: hiddenSelectedCount }, hiddenSelectedCount) }}
            </span>
          </template>
        </span>
        <template v-if="selectedCount > 0">
          <!-- The same as dragging the selection, for the keyboard -->
          <ChannelsOverviewMenuButton
            variant="button"
            :label="t('Channels.Overview.Move Selection To')"
            :items="moveTargets"
            @choose="(target) => fileSelection(target, false)"
          >
            {{ t('Channels.Overview.Move Selection To') }}
          </ChannelsOverviewMenuButton>
          <ChannelsOverviewMenuButton
            variant="button"
            :label="t('Channels.Overview.Copy Selection To')"
            :items="copyTargets"
            @choose="(target) => fileSelection(target, true)"
          >
            {{ t('Channels.Overview.Copy Selection To') }}
          </ChannelsOverviewMenuButton>
          <FtButton
            :label="t('Channels.Overview.Clear Selection')"
            @click="clearSelection"
          />
        </template>
        <span
          v-else
          class="toolbarHint"
        >
          {{ isMac ? t('Channels.Overview.Selection Hint Mac') : t('Channels.Overview.Selection Hint') }}
        </span>
        <ChannelsOverviewTrash
          v-if="!hideUnsubscribeButton"
          class="trash"
          :has-selection="selectedCount > 0"
          @drop-channels="askToUnsubscribe"
          @unsubscribe-selection="askToUnsubscribe(draggedSelection())"
        />
      </div>
      <p
        v-if="suggestions !== null"
        class="coverage"
      >
        {{ t('Channels.Overview.Suggestions.Coverage', suggestions.coverage) }}
      </p>
      <!-- Opened and closed columns grow in and fade, fade and fold away -->
      <TransitionGroup
        tag="div"
        class="columns"
        name="column"
      >
        <ChannelsOverviewColumn
          v-for="column in columns"
          :key="column.key"
          :class="{ poolColumn: column.kind === 'pool' }"
          :data-proposal-key="column.kind === 'proposal' ? column.key : null"
          :is-pool="column.kind === 'pool'"
          :proposed="column.kind === 'proposal'"
          :active="column.kind === 'profile' && column.profile._id === activeProfileId"
          :title="columnTitle(column)"
          :count-label="countLabel(column)"
          :empty-label="searching ? t('Channels.Overview.No Matches') : t('Channels.Overview.Empty Profile')"
          :background-color="columnColour(column)"
          :menu-items="column.kind === 'proposal' ? proposalMenuItems(column.proposal) : []"
          :menu-label="column.kind === 'proposal' ? t('Channels.Overview.Suggestions.Actions', { suggestion: columnTitle(column) }) : ''"
          :badges="proposalDetails.get(column.key)?.badges"
          :evidence="proposalDetails.get(column.key)?.evidence"
          :channels="column.channels"
          :animate="animatingChange"
          :reset-key="normalisedQuery"
          :selected-ids="selection.get(column.id)"
          :duplicate-profiles="duplicateProfiles"
          :callout-colours="calloutColours"
          @thumbnail-error="updateThumbnail"
          @select="(channel, extend) => selectChannel(column, channel, extend)"
          @select-all="selectColumn(column)"
          @activate="activateProfile(column.profile)"
          @select-none="deselectColumn(column)"
          @drag-start="(event, channel) => dragChannel(event, channel, column)"
          @drop-channels="(dragged, copy) => fileChannels(dragged, column.id, copy)"
          @remove-here="(channel) => removeDuplicate(channel, column.id)"
          @keep-here="(channel) => keepOnlyIn(channel, column.id)"
          @context-menu="(event, channel) => openContextMenu(event, channel, column)"
          @menu="(value, anchor) => chooseProposalAction(column.proposal, value, anchor)"
        />
        <p
          v-if="openColumns.length === 0 && profiles.length > 0"
          key="hint"
          class="message columnsHint"
        >
          {{ t('Channels.Overview.Open a Profile') }}
        </p>
      </TransitionGroup>
    </template>
    <ChannelsOverviewMenu
      v-if="contextMenu !== null"
      :label="contextMenu.channel.name ?? contextMenu.channel.id"
      :items="contextMenuItems"
      :anchor="contextMenu.anchor"
      focus-first
      @choose="chooseFromContextMenu"
      @close="closeContextMenu"
    />
    <ChannelsOverviewMenu
      v-if="profileMenu !== null"
      :label="profileMenu.name"
      :items="profileMenuItems"
      :anchor="profileMenu.anchor"
      focus-first
      @choose="chooseFromProfileMenu"
      @close="closeProfileMenu"
    />
    <ChannelsOverviewMenu
      v-if="sendMenu !== null"
      :label="t('Channels.Overview.Suggestions.Send To Profile Menu', { count: sendMenu.count }, sendMenu.count)"
      :items="sendTargets"
      :anchor="sendMenu.anchor"
      focus-first
      @choose="chooseSendTarget"
      @close="closeSendMenu"
    />
    <ChannelsOverviewColourMenu
      v-if="colourMenu !== null"
      :label="t('Channels.Overview.Profile Colours', { profile: colourMenu.name })"
      :current="colourMenu.bgColor"
      :anchor="colourMenu.anchor"
      @choose="chooseColour"
      @close="closeColourMenu"
    />
    <FtPrompt
      v-if="unsubscribeChannelIds.length > 0"
      :label="t('Channels.Overview.Unsubscribe Prompt', { count: unsubscribeChannelIds.length }, unsubscribeChannelIds.length)"
      :extra-labels="[t('Channels.Overview.Unsubscribe Prompt Detail')]"
      :option-names="[t('Channel.Unsubscribe'), t('Cancel')]"
      :option-values="['unsubscribe', 'cancel']"
      :is-first-option-destructive="true"
      @click="handleUnsubscribePrompt"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import FtButton from '../../components/FtButton/FtButton.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtInput from '../../components/FtInput/FtInput.vue'
import FtPrompt from '../../components/FtPrompt/FtPrompt.vue'
import ChannelsOverviewColourMenu from '../../components/ChannelsOverviewColourMenu/ChannelsOverviewColourMenu.vue'
import ChannelsOverviewColumn from '../../components/ChannelsOverviewColumn/ChannelsOverviewColumn.vue'
import ChannelsOverviewPalette from '../../components/ChannelsOverviewPalette/ChannelsOverviewPalette.vue'
import ChannelsOverviewMenu from '../../components/ChannelsOverviewMenu/ChannelsOverviewMenu.vue'
import ChannelsOverviewMenuButton from '../../components/ChannelsOverviewMenuButton/ChannelsOverviewMenuButton.vue'
import ChannelsOverviewTrash from '../../components/ChannelsOverviewTrash/ChannelsOverviewTrash.vue'

import store from '../../store/index'
import { invidiousGetChannelInfo } from '../../helpers/api/invidious'
import { getLocalChannel, parseLocalChannelHeader } from '../../helpers/api/local'
import { startChannelDrag } from '../../helpers/channelDragAndDrop'
import { useProfilePaletteEditing } from '../../composables/useProfilePaletteEditing'
import { useProfileSuggestions } from '../../composables/useProfileSuggestions'
import { calculateColorLuminance, colors } from '../../helpers/colors'
import { ctrlFHandler, deepCopy, showToast } from '../../helpers/utils'
import {
  assignCalloutColours,
  channelMemberships,
  countTransferred,
  deselectAll,
  duplicateCounts,
  filterChannels,
  isSelected,
  nonPrimaryProfiles,
  normaliseQuery,
  pickUnusedColour,
  planTransfer,
  planUnsubscribe,
  primaryProfile,
  profilesOutsideHome,
  pruneSelection,
  restoreOpenProfiles,
  selectAll,
  selectedChannels,
  selectionAfterTransfer,
  selectionSize,
  selectRange,
  sortChannels,
  sortColumn,
  toggleOpenProfile,
  toggleSelected,
  unassignedChannels,
  uniqueChannels,
} from '../../helpers/channelsOverview'

/** @import { Profile, Channel } from '../../helpers/channelsOverview' */
/** @import { DraggedChannel } from '../../helpers/channelDragAndDrop' */
/** @import { Evidence, Proposal } from '../../helpers/profileSuggestions' */

const { locale, t } = useI18n()
const route = useRoute()
const router = useRouter()

/** @type {import('vue').ComputedRef<Profile[]>} */
const profileList = computed(() => store.getters.getProfileList)

/** @type {import('vue').ComputedRef<Profile[]>} */
const profiles = computed(() => nonPrimaryProfiles(profileList.value))

/** @type {import('vue').ComputedRef<Channel[]>} */
const allChannels = computed(() => primaryProfile(profileList.value)?.subscriptions ?? [])

const collator = computed(() => new Intl.Collator([locale.value, 'en'], { sensitivity: 'base', numeric: true }))

const memberships = computed(() => channelMemberships(profileList.value))

/** @type {import('vue').ComputedRef<Channel[]>} */
const pool = computed(() => sortChannels(unassignedChannels(profileList.value, memberships.value), collator.value))

/**
 * The open columns, which belong to the window: one window can be sorting
 * two profiles while another sorts three others. They are kept in the
 * window's session storage, which lasts through leaving the page and
 * reloading, and is the window's own.
 *
 * Every change is saved to the setting as well, where it is only read by a
 * window that has no columns of its own yet: a new one, or the first after a
 * restart, which so starts out as the last one left off.
 */
const WINDOW_OPEN_PROFILES_KEY = 'ChannelsOverview/openProfiles'

/** @returns {unknown} */
function readWindowOpenProfiles() {
  try {
    return JSON.parse(sessionStorage.getItem(WINDOW_OPEN_PROFILES_KEY))
  } catch {
    return null
  }
}

/** @type {import('vue').Ref<unknown>} */
const storedOpenProfileIds = ref(readWindowOpenProfiles() ?? store.getters.getChannelsOverviewOpenProfiles)

/** @type {import('vue').ComputedRef<string[]>} */
const openProfileIds = computed(() => restoreOpenProfiles(storedOpenProfileIds.value, profileList.value))

/**
 * @param {string[]} profileIds
 */
function saveOpenProfileIds(profileIds) {
  storedOpenProfileIds.value = profileIds
  sessionStorage.setItem(WINDOW_OPEN_PROFILES_KEY, JSON.stringify(profileIds))
  store.dispatch('updateChannelsOverviewOpenProfiles', profileIds)
}

/**
 * @typedef {object} Column
 * @property {'pool' | 'profile' | 'proposal'} kind
 * @property {string} key unique among the columns, to draw them by
 * @property {string | null} id where its selection is kept: the profile's
 * id, null for the pool, the proposal's key for a proposed column
 * @property {Profile | null} profile a profile column's
 * @property {Proposal | null} [proposal] a proposed column's
 * @property {Channel[]} channels shown, in the order shown
 * @property {Channel[]} allChannels every channel in the column, shown or not
 * @property {number} total how many channels the column has, shown or not
 */

/**
 * The search over the columns. Deliberately not kept anywhere: it is gone on
 * leaving the page.
 */
const query = ref('')

const normalisedQuery = computed(() => normaliseQuery(query.value))

const searching = computed(() => normalisedQuery.value !== '')

/**
 * The open columns in full and in order. Apart from the search, so that
 * typing only filters and never sorts again. In the palette's order, which
 * is the profiles' own, whatever order they were opened in, so that a
 * profile's column is always in the same place among the others.
 */
const sortedOpenColumns = computed(() => {
  const open = new Set(openProfileIds.value)

  return profiles.value
    .filter(profile => open.has(profile._id))
    .map(profile => ({
      profile,
      allChannels: sortColumn(uniqueChannels(profile.subscriptions), memberships.value, collator.value)
    }))
})

/** @type {import('vue').ComputedRef<Column[]>} */
const openColumns = computed(() => {
  return sortedOpenColumns.value.map(({ profile, allChannels }) => ({
    kind: 'profile',
    key: profile._id,
    id: profile._id,
    profile,
    channels: filterChannels(allChannels, normalisedQuery.value),
    allChannels,
    total: allChannels.length
  }))
})

const {
  shown: suggestionsShown,
  suggestions,
  toggleSuggestions,
  dismiss,
  keepIn
} = useProfileSuggestions({ profileList, collator })

/**
 * The pool as drawn: while suggestions are shown, only the channels no
 * suggestion took, so that every Unassigned channel is in one place.
 * @type {import('vue').ComputedRef<Channel[]>}
 */
const shownPool = computed(() => suggestions.value?.remainder ?? pool.value)

/** @type {import('vue').ComputedRef<Column[]>} */
const proposalColumns = computed(() => {
  if (suggestions.value === null) { return [] }

  return suggestions.value.proposals.map(proposal => {
    const allChannels = proposal.channels.map(suggested => suggested.channel)

    return {
      kind: 'proposal',
      key: proposal.key,
      id: proposal.key,
      profile: null,
      proposal,
      channels: filterChannels(allChannels, normalisedQuery.value),
      allChannels,
      total: allChannels.length
    }
  })
})

/**
 * Everything drawn, pool first, then any suggestions, then the open
 * profiles. The pool is left out once it is empty, and with it the one place
 * to drop a channel out of every profile. A search that matches nothing in
 * it leaves it in place, as it still has channels.
 * @type {import('vue').ComputedRef<Column[]>}
 */
const columns = computed(() => {
  if (shownPool.value.length === 0) {
    return [...proposalColumns.value, ...openColumns.value]
  }

  const poolColumn = {
    kind: 'pool',
    key: 'pool',
    id: null,
    profile: null,
    channels: filterChannels(shownPool.value, normalisedQuery.value),
    allChannels: shownPool.value,
    total: shownPool.value.length
  }

  return [poolColumn, ...proposalColumns.value, ...openColumns.value]
})

/** @type {import('vue').ComputedRef<Map<string, Profile>>} */
const profilesById = computed(() => new Map(profiles.value.map(profile => [profile._id, profile])))

/**
 * @param {Column} column
 * @returns {string}
 */
function columnTitle(column) {
  switch (column.kind) {
    case 'pool':
      return t('Channels.Overview.Unassigned')
    case 'profile':
      return column.profile.name
    default: {
      const { kind, name } = column.proposal

      if (kind === 'profile') {
        return t('Channels.Overview.Suggestions.Profile Heading', { profile: name })
      }

      return kind === 'category'
        ? t('Channels.Overview.Suggestions.Category Heading', { category: name })
        : t('Channels.Overview.Suggestions.Tag Heading', { tag: name })
    }
  }
}

/**
 * A profile's colour on its column, and on a suggestion for it. A suggested
 * new profile has none yet.
 * @param {Column} column
 * @returns {string | null}
 */
function columnColour(column) {
  if (column.kind === 'profile') { return column.profile.bgColor }
  if (column.kind === 'proposal' && column.proposal.profileId !== null) {
    return profilesById.value.get(column.proposal.profileId)?.bgColor ?? null
  }

  return null
}

/**
 * Why a suggested channel is where it is, as its tooltip says it.
 * @param {Evidence} evidence
 * @param {Intl.NumberFormat} percent
 * @returns {string}
 */
function describeEvidence(evidence, percent) {
  const profileName = id => profilesById.value.get(id)?.name ?? ''

  switch (evidence.type) {
    case 'watched':
      return t('Channels.Overview.Suggestions.Evidence Watched', { category: evidence.category, count: evidence.count }, evidence.count)
    case 'artist':
      return t('Channels.Overview.Suggestions.Evidence Artist')
    case 'categoryShare':
      return t('Channels.Overview.Suggestions.Evidence Category Share', {
        category: evidence.category,
        share: percent.format(evidence.share),
        profile: profileName(evidence.profileId)
      })
    case 'tagShare':
      return t('Channels.Overview.Suggestions.Evidence Tag Share', {
        tag: evidence.tag,
        count: evidence.count,
        total: evidence.total,
        profile: profileName(evidence.profileId)
      })
    case 'tagged':
      return t('Channels.Overview.Suggestions.Evidence Tag Names Profile', { tag: evidence.tag })
    case 'tags':
      return t('Channels.Overview.Suggestions.Evidence Tags', { tags: evidence.tags.join(', ') })
    default:
      return ''
  }
}

/**
 * For each proposed column, by its key: where each of its channels is now,
 * the badge on those in a profile, and why each is there.
 * @type {import('vue').ComputedRef<Map<string, { sources: Map<string, string | null>, badges: Map<string, { label: string, bgColor: string }>, evidence: Map<string, string> }>>}
 */
const proposalDetails = computed(() => {
  const details = new Map()

  if (suggestions.value === null) { return details }

  const percent = new Intl.NumberFormat([locale.value, 'en'], { style: 'percent', maximumFractionDigits: 0 })

  for (const proposal of suggestions.value.proposals) {
    const sources = new Map()
    const badges = new Map()
    const evidence = new Map()

    for (const suggested of proposal.channels) {
      const channelId = suggested.channel.id
      const source = suggested.sourceProfileId === null ? null : profilesById.value.get(suggested.sourceProfileId)

      sources.set(channelId, suggested.sourceProfileId)
      evidence.set(channelId, describeEvidence(suggested.evidence, percent))

      if (source) {
        badges.set(channelId, { label: t('Channels.Overview.Suggestions.Now In', { profile: source.name }), bgColor: source.bgColor })
      }
    }

    details.set(proposal.key, { sources, badges, evidence })
  }

  return details
})

/**
 * Where a channel drags from: its column's profile, or for a proposed column,
 * the profile the channel is in now, null for the pool. A suggested move
 * therefore drags as it would from its own profile's column.
 * @param {Column} column
 * @param {string} channelId
 * @returns {string | null}
 */
function dragSource(column, channelId) {
  if (column.kind !== 'proposal') { return column.id }

  return proposalDetails.value.get(column.key)?.sources.get(channelId) ?? null
}

/**
 * The names of every profile each duplicated channel is in, for the mark on
 * its rows. Only channels in more than one profile have an entry.
 * @type {import('vue').ComputedRef<Map<string, string[]>>}
 */
const duplicateProfiles = computed(() => {
  const names = new Map(profiles.value.map(profile => [profile._id, profile.name]))
  const duplicates = new Map()

  for (const [channelId, profileIds] of memberships.value) {
    if (profileIds.length > 1) {
      duplicates.set(channelId, profileIds.map(id => names.get(id)))
    }
  }

  return duplicates
})

/**
 * Callout colours for the channels duplicated across the open columns. Taken
 * from the columns in full, so a search does not change a channel's colour.
 */
const calloutColours = computed(() => {
  return assignCalloutColours(sortedOpenColumns.value.map(column => column.allChannels.map(channel => channel.id)))
})

const duplicateCountsByProfile = computed(() => duplicateCounts(profileList.value, memberships.value))

/**
 * How many channels in each profile match the search, so that a profile whose
 * column is closed still shows it has something. Null while not searching.
 * @type {import('vue').ComputedRef<Map<string, number> | null>}
 */
const matchCounts = computed(() => {
  if (!searching.value) { return null }

  return new Map(profiles.value.map(profile => {
    return [profile._id, filterChannels(uniqueChannels(profile.subscriptions), normalisedQuery.value).length]
  }))
})

/**
 * @param {Column} column
 * @returns {string}
 */
function countLabel(column) {
  const shown = column.channels.length

  if (column.kind === 'pool') {
    return searching.value
      ? t('Channels.Overview.Unassigned Match Count', { matches: shown, count: column.total }, column.total)
      : t('Channels.Overview.Unassigned Count', { count: column.total }, column.total)
  }

  return searching.value
    ? t('Channels.Overview.Match Count', { matches: shown, count: column.total })
    : String(column.total)
}

/** @type {import('vue').ShallowRef<import('../../helpers/channelsOverview').Selection>} */
const selection = shallowRef(new Map())

/**
 * The last row clicked in each column, where a Shift-click range starts from.
 * @type {Map<string | null, string>}
 */
const selectionAnchors = new Map()

const selectedCount = computed(() => selectionSize(selection.value))

/**
 * Selected channels the search is hiding. They stay selected, so that a
 * selection can be gathered over several searches, and go along with a drag;
 * the count over the columns says how many of them there are.
 */
const hiddenSelectedCount = computed(() => {
  if (!searching.value) { return 0 }

  const shown = pruneSelection(selection.value, columnContents(columns.value, 'channels'))

  return selectedCount.value - selectionSize(shown)
})

/**
 * The selection as a drag payload, each channel with where it drags from. A
 * channel selected in a proposed column drags from where it is now, and one
 * selected there and in its own profile's column as well is dragged once.
 * @returns {DraggedChannel[]}
 */
function draggedSelection() {
  const dragged = []
  const seen = new Set()

  for (const { channelId, profileId: columnId } of selectedChannels(selection.value)) {
    const sources = typeof columnId === 'string' ? proposalDetails.value.get(columnId)?.sources : undefined

    if (sources && !sources.has(channelId)) { continue }

    const profileId = sources ? sources.get(channelId) : columnId
    const key = `${channelId}\n${profileId}`

    if (seen.has(key)) { continue }

    seen.add(key)
    dragged.push({ channelId, profileId })
  }

  return dragged
}

/**
 * @param {Column[]} columns
 * @param {'channels' | 'allChannels'} which shown, or all of them
 * @returns {Map<string | null, Set<string>>}
 */
function columnContents(columns, which) {
  return new Map(columns.map(column => [column.id, new Set(column[which].map(channel => channel.id))]))
}

/**
 * Only what is in the open columns: a channel that leaves its column, or a
 * column that closes, is no longer selected, and a Shift-click range no
 * longer starts from it. A search hiding a channel leaves it selected.
 * @param {import('../../helpers/channelsOverview').Selection} next
 */
function setPrunedSelection(next) {
  const contents = columnContents(columns.value, 'allChannels')

  selection.value = pruneSelection(next, contents)

  for (const [columnId, channelId] of selectionAnchors) {
    if (!contents.get(columnId)?.has(channelId)) {
      selectionAnchors.delete(columnId)
    }
  }
}

watch(columns, () => setPrunedSelection(selection.value))

/**
 * @param {Column} column
 * @param {Channel} channel
 * @param {boolean} extend Shift was held: select from the last clicked row
 */
function selectChannel(column, channel, extend) {
  const anchor = selectionAnchors.get(column.id)

  // A range runs through the rows as shown; an anchor the search now hides
  // has no place in that, and the click toggles the row instead
  const range = extend && anchor !== undefined && anchor !== channel.id
    ? selectRange(selection.value, column.id, column.channels.map(channel => channel.id), anchor, channel.id)
    : selection.value

  selection.value = range !== selection.value
    ? range
    : toggleSelected(selection.value, column.id, channel.id)

  selectionAnchors.set(column.id, channel.id)
}

/**
 * Everything the column shows: with a search, exactly its matches.
 * @param {Column} column
 */
function selectColumn(column) {
  selection.value = selectAll(selection.value, new Map([[column.id, column.channels.map(channel => channel.id)]]))
}

/**
 * @param {Column} column
 */
function deselectColumn(column) {
  selection.value = deselectAll(selection.value, new Map([[column.id, column.channels.map(channel => channel.id)]]))
}

function clearSelection() {
  selection.value = new Map()
  selectionAnchors.clear()
}

const searchInput = useTemplateRef('searchInput')
const toolbar = useTemplateRef('toolbar')

/**
 * @param {KeyboardEvent} event
 */
function handleKeydown(event) {
  ctrlFHandler(event, searchInput.value)

  if (event.key === 'Escape' && selectedCount.value > 0 && !event.defaultPrevented) {
    clearSelection()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))

/**
 * A link here can ask for a profile's column to be open, as the one from that
 * profile's settings does. The request is taken off the address once met, so
 * that closing the column afterwards sticks.
 */
watch(() => route.query.open, (profileId) => {
  if (typeof profileId !== 'string' || profileId === '') { return }

  if (profiles.value.some(profile => profile._id === profileId) && !openProfileIds.value.includes(profileId)) {
    saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
  }

  router.replace({ query: { ...route.query, open: undefined } })
}, { immediate: true })

/**
 * @param {string} profileId
 */
function toggleColumn(profileId) {
  saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
}

/**
 * @param {DragEvent} event
 * @param {Channel} channel
 * @param {Column} column the column it is dragged out of
 */
function dragChannel(event, channel, column) {
  // A selected row carries the whole selection with it; any other row only itself
  if (isSelected(selection.value, column.id, channel.id)) {
    const dragged = draggedSelection()
    const label = dragged.length === 1
      ? channel.name ?? channel.id
      : t('Channels.Overview.Channel Count', { count: dragged.length }, dragged.length)

    startChannelDrag(event, dragged, label)
  } else {
    startChannelDrag(event, [{ channelId: channel.id, profileId: dragSource(column, channel.id) }], channel.name ?? channel.id)
  }
}

/** Changes to more channels than this at once are not animated: too much moving at once */
const ANIMATED_CHANGE_LIMIT = 60

/** Whether the change being made now is shown happening, in the columns */
const animatingChange = ref(false)
let animatingChangeTimeout = null

/**
 * Lets the columns animate the change about to be made, for as long as the
 * animation takes.
 * @param {number} count how many channels it moves
 */
function animateChange(count) {
  if (count === 0 || count > ANIMATED_CHANGE_LIMIT) { return }

  clearTimeout(animatingChangeTimeout)
  animatingChange.value = true
  animatingChangeTimeout = setTimeout(() => { animatingChange.value = false }, 400)
}

onBeforeUnmount(() => clearTimeout(animatingChangeTimeout))

/**
 * Takes channels out of profiles, shown at once and then saved, as a drop is.
 * One removal, however many channels and profiles, which the other windows
 * hear of once.
 * @param {string[]} channelIds
 * @param {string[]} profileIds
 */
async function removeChannels(channelIds, profileIds) {
  animateChange(channelIds.length)
  store.commit('removeChannelsFromProfiles', { channelIds, profileIds })

  await store.dispatch('removeChannelsFromProfiles', { channelIds, profileIds })
}

let pendingChanges = Promise.resolve()

/**
 * Runs a change to the profiles once every earlier one from this page has
 * landed. A drop saves whole profiles worked out from the profile list as it
 * stands, and two drops in quick succession would otherwise both start from
 * the list before either, the second putting back what the first took out.
 * @template T
 * @param {() => Promise<T>} change
 * @returns {Promise<T>}
 */
function afterPendingChanges(change) {
  const run = pendingChanges.then(change)
  pendingChanges = run.catch(error => console.error(error))

  return run
}

/**
 * @param {string} profileId
 */
function openColumn(profileId) {
  if (!openProfileIds.value.includes(profileId)) {
    saveOpenProfileIds(toggleOpenProfile(openProfileIds.value, profileId))
  }
}

const {
  draft,
  startDraft,
  commitDraft,
  cancelDraft,
  renamingProfileId,
  finishRename,
  profileMenu,
  profileMenuItems,
  openProfileMenu,
  chooseFromProfileMenu,
  closeProfileMenu,
  colourMenu,
  chooseColour,
  closeColourMenu,
  reorder
} = useProfilePaletteEditing({ profileList, afterPendingChanges, openColumn })

/**
 * Files dropped channels into a profile, or back into the pool with
 * `targetProfileId` null, saving each changed profile once. Through the
 * store, so the database write happens in the main process and every other
 * window hears about it.
 * @param {DraggedChannel[]} dragged
 * @param {string | null} targetProfileId
 * @param {boolean} copy
 * @returns {Promise<number>} how many channels were filed
 */
function fileChannels(dragged, targetProfileId, copy) {
  return afterPendingChanges(() => transferChannels(dragged, targetProfileId, copy))
}

/**
 * The filing itself, for a change already in the queue.
 * @param {DraggedChannel[]} dragged
 * @param {string | null} targetProfileId
 * @param {boolean} copy
 * @returns {Promise<number>} how many channels were filed
 */
async function transferChannels(dragged, targetProfileId, copy) {
  const updated = planTransfer(profileList.value, dragged, targetProfileId, copy)

  if (updated.length === 0) { return 0 }

  // Counted before saving, as saving changes the profile list in place
  const count = countTransferred(profileList.value, updated, targetProfileId)
  const selectionAfter = selectionAfterTransfer(selection.value, dragged, targetProfileId, copy)
  const saved = updated.map(profile => deepCopy(profile))

  // Shown at once, before the database has it, so the channel does not sit
  // where it was for as long as the save takes. The save then writes the
  // same again, and tells the other windows.
  animateChange(count)
  saved.forEach(profile => store.commit('upsertProfileToList', deepCopy(profile)))
  setPrunedSelection(selectionAfter)

  await Promise.all(saved.map(profile => store.dispatch('updateProfile', profile)))

  return count
}

/** The pool's place in the move menu, as a profile id can never be empty */
const POOL_TARGET = ''

/**
 * Where the move menu can send the selection: every profile, and while it is
 * there, the pool, the same places a drag can.
 */
const moveTargets = computed(() => {
  const targets = profiles.value.map(profile => ({ value: profile._id, label: profile.name }))

  if (pool.value.length > 0) {
    targets.push({ value: POOL_TARGET, label: t('Channels.Overview.Unassigned') })
  }

  return targets
})

/** A copy into the pool means nothing, so only the profiles */
const copyTargets = computed(() => profiles.value.map(profile => ({ value: profile._id, label: profile.name })))

const isMac = process.platform === 'darwin'

/**
 * The selection filed from the menus: what a drag of it onto a bubble does,
 * or onto the pool.
 * @param {string} target a profile id, or `POOL_TARGET`
 * @param {boolean} copy
 */
async function fileSelection(target, copy) {
  const dragged = draggedSelection()

  if (target === POOL_TARGET) {
    await fileChannels(dragged, null, false)
  } else {
    await fileChannelsFromPalette(target, dragged, copy)
  }

  // Moved into a closed column, the selection is gone and the menu button
  // with it, taking the focus along; it goes to where the channels went
  await nextTick()

  if (!document.activeElement || document.activeElement === document.body) {
    const bubble = target === POOL_TARGET
      ? null
      : document.querySelector(`[data-profile-id="${CSS.escape(target)}"] [role="button"]`)
    const fallback = toolbar.value?.querySelector('input')

    if (bubble) {
      bubble.focus()
    } else {
      fallback?.focus()
    }
  }
}

/**
 * A drop on a bubble does what a drop on its column does. The column may not
 * be open to show the channels arriving, so a toast says what happened.
 * @param {string} profileId
 * @param {DraggedChannel[]} dragged
 * @param {boolean} copy
 */
async function fileChannelsFromPalette(profileId, dragged, copy) {
  const profile = profiles.value.find(profile => profile._id === profileId)

  if (!profile) { return }

  const count = await fileChannels(dragged, profileId, copy)

  if (count === 0) {
    showToast(t('Channels.Overview.Already in Profile', { profile: profile.name }))
  } else if (copy) {
    showToast(t('Channels.Overview.Copied to Profile', { count, profile: profile.name }, count))
  } else {
    showToast(t('Channels.Overview.Moved to Profile', { count, profile: profile.name }, count))
  }
}

/**
 * Takes a duplicated channel out of this one profile, leaving it in the rest.
 * @param {Channel} channel
 * @param {string} profileId
 */
function removeDuplicate(channel, profileId) {
  afterPendingChanges(() => removeChannels([channel.id], [profileId]))
}

/**
 * Makes this profile a duplicated channel's only one, apart from the primary
 * profile: out of every other in one removal.
 * @param {Channel} channel
 * @param {string} homeProfileId
 */
function keepOnlyIn(channel, homeProfileId) {
  afterPendingChanges(async () => {
    const profileIds = profilesOutsideHome(memberships.value, channel.id, homeProfileId)

    if (profileIds.length > 0) {
      await removeChannels([channel.id], profileIds)
    }
  })
}

/**
 * The menu a right-click on a channel opens, with everything that can be done
 * to that one channel: going to it, and for a duplicate the two ways out of
 * being one, and unsubscribing. Null while it is closed.
 * @type {import('vue').ShallowRef<{ anchor: { x: number, y: number }, channel: Channel, column: Column, returnTo: HTMLElement | null } | null>}
 */
const contextMenu = shallowRef(null)

/**
 * @param {MouseEvent} event
 * @param {Channel} channel
 * @param {Column} column
 */
function openContextMenu(event, channel, column) {
  const square = event.currentTarget instanceof HTMLElement ? event.currentTarget : null

  contextMenu.value = {
    anchor: { x: event.clientX, y: event.clientY },
    channel,
    column,
    returnTo: square?.querySelector('.selectArea') ?? null
  }
}

/**
 * @param {boolean} returnFocus
 */
function closeContextMenu(returnFocus) {
  const returnTo = contextMenu.value?.returnTo
  contextMenu.value = null

  if (returnFocus && returnTo?.isConnected) {
    returnTo.focus()
  }
}

const contextMenuItems = computed(() => {
  if (contextMenu.value === null) { return [] }

  const { channel, column } = contextMenu.value
  const items = []

  if (!store.getters.getDisableChannelLinks) {
    items.push({ value: 'open', label: t('Channels.Overview.Open Channel') })
  }

  if (column.kind === 'profile' && duplicateProfiles.value.has(channel.id)) {
    items.push(
      { value: 'remove-here', label: t('Channels.Overview.Remove This Duplicate') },
      { value: 'keep-here', label: t('Channels.Overview.Keep Here Only') }
    )
  }

  // A suggested move can be told to stay where it is
  const source = column.kind === 'proposal' ? profilesById.value.get(dragSource(column, channel.id)) : undefined

  if (source) {
    items.push({ value: 'keep-suggested', label: t('Channels.Overview.Suggestions.Keep In', { profile: source.name }) })
  }

  if (!hideUnsubscribeButton.value) {
    items.push({ value: 'unsubscribe', label: t('Channels.Overview.Unsubscribe Channel'), destructive: true })
  }

  return items
})

/**
 * @param {string} value
 */
function chooseFromContextMenu(value) {
  if (contextMenu.value === null) { return }

  const { channel, column } = contextMenu.value

  switch (value) {
    case 'open':
      router.push(`/channel/${channel.id}`)
      break
    case 'remove-here':
      removeDuplicate(channel, column.id)
      break
    case 'keep-here':
      keepOnlyIn(channel, column.id)
      break
    case 'keep-suggested': {
      const source = dragSource(column, channel.id)

      if (source !== null) {
        keepIn(channel.id, source)
      }
      break
    }
    case 'unsubscribe':
      askToUnsubscribe([{ channelId: channel.id, profileId: column.id }])
      break
  }
}

const COLOUR_VALUES = colors.map(colour => colour.value)

/**
 * Every channel of a suggestion, each as dragged from where it is now: the
 * whole of it, whatever the search is showing, which is why the menu says
 * how many.
 * @param {Proposal} proposal
 * @returns {DraggedChannel[]}
 */
function proposalDragged(proposal) {
  return proposal.channels.map(suggested => ({ channelId: suggested.channel.id, profileId: suggested.sourceProfileId }))
}

/**
 * @param {Proposal} proposal
 */
function proposalMenuItems(proposal) {
  const count = proposal.channels.length
  const items = []

  if (proposal.kind === 'profile') {
    const moved = proposal.channels.filter(suggested => suggested.sourceProfileId !== null).length

    items.push({
      value: 'file',
      label: moved > 0
        ? t('Channels.Overview.Suggestions.File In Profile With Moves', { count, profile: proposal.name, moved }, count)
        : t('Channels.Overview.Suggestions.File In Profile', { count, profile: proposal.name }, count)
    })
  } else {
    items.push({ value: 'create', label: t('Channels.Overview.Suggestions.Create Profile', { count }, count) })
  }

  if (profiles.value.length > 0) {
    items.push({ value: 'send', label: t('Channels.Overview.Suggestions.Send To Profile') })
  }

  items.push({ value: 'dismiss', label: t('Channels.Overview.Suggestions.Dismiss') })

  return items
}

/**
 * A suggestion acted on goes, and its menu button with it, which leaves the
 * focus nowhere; it goes to the search, as it does after a move. The column
 * fades out before it goes, with the focus still in it, so that counts too.
 */
async function keepFocusOnPage() {
  await nextTick()

  const focused = document.activeElement

  if (!focused || focused === document.body || focused.closest('.column-leave-active') !== null) {
    toolbar.value?.querySelector('input')?.focus()
  }
}

/**
 * @param {Proposal} proposal
 * @param {string} value
 * @param {{ rect: DOMRect } | null} anchor where its menu was
 */
async function chooseProposalAction(proposal, value, anchor) {
  switch (value) {
    case 'file':
      await fileChannelsFromPalette(proposal.profileId, proposalDragged(proposal), false)
      break
    case 'create':
      await createFromProposal(proposal)
      break
    case 'send':
      if (anchor !== null) {
        sendMenu.value = { key: proposal.key, count: proposal.channels.length, anchor }
      }
      return
    case 'dismiss':
      dismiss(proposal.key)
      break
  }

  await keepFocusOnPage()
}

/**
 * Makes a profile of a suggested new group, named after it and in a colour no
 * profile has, at the end of the order as New profile makes one, and files
 * the group's channels in it. One change in the queue, so that a rename or a
 * drop straight after cannot come between the two. Its column is not opened:
 * the bubble says where the channels went.
 * @param {Proposal} proposal
 */
function createFromProposal(proposal) {
  const dragged = proposalDragged(proposal)

  return afterPendingChanges(async () => {
    const bgColor = pickUnusedColour(COLOUR_VALUES, profileList.value)
    const created = await store.dispatch('createProfile', {
      name: proposal.name,
      bgColor,
      textColor: calculateColorLuminance(bgColor),
      subscriptions: []
    })

    if (!created) { return }

    showToast(t('Profile.Profile has been created'))

    await transferChannels(dragged, created._id, false)
  })
}

/**
 * The list of profiles Send to profile opens, where its menu was. Null while
 * it is closed.
 * @type {import('vue').ShallowRef<{ key: string, count: number, anchor: { rect: DOMRect } } | null>}
 */
const sendMenu = shallowRef(null)

const sendTargets = computed(() => profiles.value.map(profile => ({ value: profile._id, label: profile.name })))

/**
 * @param {string} profileId
 */
async function chooseSendTarget(profileId) {
  const key = sendMenu.value?.key
  const proposal = suggestions.value?.proposals.find(candidate => candidate.key === key)

  if (!proposal) { return }

  await fileChannelsFromPalette(profileId, proposalDragged(proposal), false)
  await keepFocusOnPage()
}

/**
 * @param {boolean} returnFocus
 */
function closeSendMenu(returnFocus) {
  const key = sendMenu.value?.key
  sendMenu.value = null

  if (returnFocus && key) {
    const button = document.querySelector(`[data-proposal-key="${CSS.escape(key)}"] .proposalMenu button`)

    if (button) {
      button.focus()
    } else {
      toolbar.value?.querySelector('input')?.focus()
    }
  }
}

/** The profile the rest of the app shows, as picked in the top bar */
const activeProfileId = computed(() => store.getters.getActiveProfile?._id)

/**
 * Makes a profile the active one, as picking it in the top bar does.
 * @param {Profile} profile
 */
function activateProfile(profile) {
  if (profile._id === activeProfileId.value) { return }

  store.commit('setActiveProfile', profile._id)
  showToast(t('Profile.{profile} is now the active profile', { profile: profile.name }))
}

/**
 * The trash follows the setting that hides the unsubscribe button everywhere
 * else, as unsubscribing is all it does.
 */
const hideUnsubscribeButton = computed(() => store.getters.getHideUnsubscribeButton)

/**
 * The channels a drop on the trash wants unsubscribed from, waiting on the
 * prompt. Empty while no prompt is showing.
 * @type {import('vue').ShallowRef<string[]>}
 */
const unsubscribeChannelIds = shallowRef([])

/**
 * @param {DraggedChannel[]} dragged
 */
function askToUnsubscribe(dragged) {
  unsubscribeChannelIds.value = [...new Set(dragged.map(channel => channel.channelId))]
}

/**
 * Unsubscribes as the subscribe button does, out of every profile at once,
 * but for all the channels in one removal, so other windows hear of it once.
 * Cancelling leaves everything as it was, the selection included.
 * @param {'unsubscribe' | 'cancel' | null} value
 */
async function handleUnsubscribePrompt(value) {
  const channelIds = unsubscribeChannelIds.value
  unsubscribeChannelIds.value = []

  if (value !== 'unsubscribe') { return }

  const count = await afterPendingChanges(async () => {
    const removal = planUnsubscribe(profileList.value, channelIds)

    if (removal === null) { return 0 }

    await removeChannels(removal.channelIds, removal.profileIds)

    return removal.channelIds.length
  })

  if (count > 0) {
    showToast(t('Channels.Overview.Unsubscribed', { count }, count))
  }
}

/**
 * Channels whose thumbnail has been fetched again already. A row is drawn
 * again every time a search hides and shows it, and its broken image would
 * ask again each time.
 * @type {Set<string>}
 */
const thumbnailsRefetched = new Set()

/**
 * A stored thumbnail that no longer loads is fetched again from the channel
 * and saved, as the old channel list did. Spaced out, so that a column full of
 * stale thumbnails does not fire a request for each of them at once.
 * @param {Channel} channel
 */
function updateThumbnail(channel) {
  if (thumbnailsRefetched.has(channel.id)) { return }

  thumbnailsRefetched.add(channel.id)

  setTimeout(async () => {
    try {
      let thumbnailUrl

      if (store.getters.getBackendPreference === 'local') {
        const response = await getLocalChannel(channel.id)

        if (response.alert) { return }

        thumbnailUrl = parseLocalChannelHeader(response).thumbnailUrl
      } else {
        const response = await invidiousGetChannelInfo(channel.id)

        thumbnailUrl = response.authorThumbnails[0].url
      }

      // It saves whole profiles too, so it waits its turn with the page's own changes
      await afterPendingChanges(() => store.dispatch('updateSubscriptionDetails', {
        channelThumbnailUrl: thumbnailUrl,
        channelName: channel.name,
        channelId: channel.id
      }))
    } catch (error) {
      console.error(error)
    }
  }, thumbnailsRefetched.size * 500)
}
</script>

<style scoped src="./ChannelsOverview.css" />
