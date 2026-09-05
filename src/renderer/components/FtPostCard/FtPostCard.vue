<!--
  A post as a card in the grid, standing beside the video cards.

  The whole post — the carousel, the poll, the full text, the share button —
  belongs to the Post page and to the channel's community tab, and those two
  keep FtCommunityPost. A stream of mixed kinds needs something else: enough of
  the post to decide whether to open it, at the size of everything around it,
  with nothing to click but the post itself.
-->
<template>
  <div
    class="ft-list-post ft-list-item grid"
    :class="{ noThumbnail: thumbnail === '' }"
  >
    <div
      v-if="thumbnail !== ''"
      class="videoThumbnail"
    >
      <!--
        The text below is the card's link, as a video card's title is, so the
        picture is a second route to the same place and stays out of the way of
        a keyboard. A post that is only a picture has no text to carry that job,
        and then this is the link.
      -->
      <component
        :is="postLink ? 'RouterLink' : 'div'"
        class="thumbnailLink"
        :to="postLink"
        :tabindex="bodyText === '' ? undefined : -1"
        :aria-hidden="bodyText === '' ? undefined : 'true'"
        :aria-label="bodyText === '' ? $t('Channel.Posts.View Full Post') : undefined"
      >
        <img
          :src="thumbnail"
          class="thumbnailImage"
          :class="{ blur: blurThumbnails }"
          alt=""
          loading="lazy"
        >
      </component>
    </div>
    <div class="postInfo">
      <div class="markers">
        <FtKindMarker kind="post" />
        <FtKindMarker
          v-if="attachmentKind !== null"
          :kind="attachmentKind"
        />
      </div>
      <div class="postHeader">
        <component
          :is="authorId && enableChannelLinks ? 'RouterLink' : 'bdi'"
          v-if="author"
          class="channelName"
          dir="auto"
          :to="authorId ? `/channel/${authorId}` : undefined"
        >
          {{ author }}
        </component>
        <span v-if="publishedText !== ''">
          <template v-if="author"> • </template>{{ publishedText }}
        </span>
      </div>
      <component
        :is="postLink ? 'RouterLink' : 'div'"
        v-if="bodyText !== ''"
        class="postBody"
        :to="postLink"
      >
        <p
          class="postSnippet"
          dir="auto"
        >
          {{ bodyText }}
        </p>
      </component>
      <div class="counts">
        <span
          class="count"
          :title="$t('Global.Counts.Like Count', { count: formattedVoteCount }, voteCount)"
          :aria-label="$t('Global.Counts.Like Count', { count: formattedVoteCount }, voteCount)"
        >
          <FontAwesomeIcon
            :icon="['fas', 'thumbs-up']"
            aria-hidden="true"
          />
          {{ formattedVoteCount }}
        </span>
        <span
          v-if="commentCount != null"
          class="count"
          :title="$t('Global.Counts.Comment Count', { count: formattedCommentCount }, commentCount)"
          :aria-label="$t('Global.Counts.Comment Count', { count: formattedCommentCount }, commentCount)"
        >
          <FontAwesomeIcon
            :icon="['fas', 'comment']"
            aria-hidden="true"
          />
          {{ formattedCommentCount }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import FtKindMarker from '../FtKindMarker/FtKindMarker.vue'

import store from '../../store/index'

import { formatNumber, getRelativeTimeFromDate } from '../../helpers/utils'
import { youtubeImageUrlToInvidious } from '../../helpers/api/invidious'

import thumbnailPlaceholder from '../../assets/img/thumbnail_placeholder.svg'

const props = defineProps({
  data: {
    type: Object,
    required: true
  },
  hideForbiddenTitles: {
    type: Boolean,
    default: true
  },
})

/** The attachment kinds that say something a thumbnail cannot say for itself. */
const ATTACHMENT_MARKERS = new Set(['poll', 'quiz', 'video', 'playlist'])

const { t } = useI18n()

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<string>} */
const currentInvidiousInstanceUrl = computed(() => store.getters.getCurrentInvidiousInstanceUrl)

/** @type {import('vue').ComputedRef<'' | 'start' | 'middle' | 'end' | 'hidden' | 'blur'>} */
const thumbnailPreference = computed(() => store.getters.getThumbnailPreference)

/** @type {import('vue').ComputedRef<boolean>} */
const blurThumbnails = computed(() => store.getters.getBlurThumbnails)

const enableChannelLinks = computed(() => !store.getters.getDisableChannelLinks)

/** @type {import('vue').ComputedRef<string[]>} */
const forbiddenTitles = computed(() => {
  if (!props.hideForbiddenTitles) { return [] }
  return JSON.parse(store.getters.getForbiddenTitles)
})

// A shared post whose original is gone arrives as the raw renderer, with no id,
// no author and no attachment. It is rare, and the card degrades to its text.
const isSharedPost = computed(() => 'backstagePostThreadRenderer' in props.data)

const author = computed(() => (isSharedPost.value ? '' : props.data.author ?? ''))

const authorId = computed(() => (isSharedPost.value ? '' : props.data.authorId ?? ''))

const voteCount = computed(() => props.data.voteCount ?? 0)

/** @type {import('vue').ComputedRef<number?>} */
const commentCount = computed(() => props.data.commentCount ?? null)

const formattedVoteCount = computed(() => formatNumber(voteCount.value))

const formattedCommentCount = computed(() => formatNumber(commentCount.value ?? 0))

const publishedText = computed(() => {
  if (props.data.publishedTime) {
    return getRelativeTimeFromDate(props.data.publishedTime)
  }

  return ''
})

const postLink = computed(() => {
  if (!props.data.postId) { return undefined }

  return {
    path: `/post/${props.data.postId}`,
    query: authorId.value ? { authorId: authorId.value } : undefined
  }
})

/** @type {import('vue').ComputedRef<string?>} */
const attachmentKind = computed(() => {
  const type = props.data.postContent?.type

  return ATTACHMENT_MARKERS.has(type) ? type : null
})

const snippet = computed(() => {
  if (isSharedPost.value) { return 'Shared post' }

  return htmlToText(props.data.postText)
})

/**
 * A post with neither picture nor text — a poll whose question is in its
 * choices, an attachment the backend would not resolve — would otherwise be a
 * card with nothing to click, so it says where it leads instead.
 */
const bodyText = computed(() => {
  if (snippet.value !== '') { return snippet.value }

  return thumbnail.value === '' ? t('Channel.Posts.View Full Post') : ''
})

/**
 * An attached video the viewer has asked not to see should not smuggle itself
 * back in as a picture.
 */
const attachmentHidden = computed(() => {
  const title = props.data.postContent?.content?.title

  if (!title) { return false }

  const lowerCaseTitle = title.toLowerCase()

  return forbiddenTitles.value.some((text) => lowerCaseTitle.includes(text.toLowerCase()))
})

/**
 * The first picture the post has to offer, whatever kind of attachment it came
 * from. A plain text post has none, and then the text is the card.
 *
 * A poll's choices can carry pictures too, and they are left alone: they are
 * icons beside the answers rather than an image of the post, and a hundred
 * pixels of one cropped to the width of a card is not a thumbnail.
 */
const attachmentImage = computed(() => {
  const attachment = props.data.postContent

  if (!attachment || attachmentHidden.value) { return '' }

  let url = ''

  switch (attachment.type) {
    case 'image':
      url = bestQualityImage(attachment.content)
      break
    case 'multiImage':
      url = bestQualityImage(attachment.content[0])
      break
    case 'video':
      url = attachment.content?.videoId ? videoThumbnailUrl(attachment.content.videoId) : ''
      break
    case 'playlist':
      // Named one way by the Local parser and the other by Invidious.
      url = attachment.content?.thumbnail ?? attachment.content?.playlistThumbnail ?? ''
      break
  }

  if (url === '') { return '' }

  if (!process.env.SUPPORTS_LOCAL_API || backendPreference.value === 'invidious') {
    return youtubeImageUrlToInvidious(url)
  }

  return url.startsWith('//') ? `https:${url}` : url
})

/**
 * A viewer who has hidden thumbnails gets the same placeholder here as on every
 * other card, rather than a card that quietly changes shape: the picture is
 * what is hidden, not the fact that the post has one.
 */
const thumbnail = computed(() => {
  if (attachmentImage.value === '') { return '' }

  return thumbnailPreference.value === 'hidden' ? thumbnailPlaceholder : attachmentImage.value
})

/**
 * @param {string} videoId
 */
function videoThumbnailUrl(videoId) {
  const baseUrl = backendPreference.value === 'invidious' ? currentInvidiousInstanceUrl.value : 'https://i.ytimg.com'

  return `${baseUrl}/vi/${videoId}/mqdefault.jpg`
}

/**
 * @param {{ width: number, height: number, url: string }[]} imageArray
 */
function bestQualityImage(imageArray) {
  if (!Array.isArray(imageArray)) { return '' }

  const widest = imageArray.reduce((best, image) => {
    return best == null || Number.parseInt(image.width) > Number.parseInt(best.width) ? image : best
  }, null)

  // Remove cropping directives when applicable
  return widest?.url?.replace(/-c-fcrop64=[^-]+/i, '') ?? ''
}

/**
 * The post text arrives as HTML from both backends: links, channel mentions and
 * custom emoji all marked up. A snippet has to be text instead, because an
 * anchor inside the card's own link would be a link inside a link — invalid,
 * and a second thing to click where the card promises there is only one.
 *
 * The markup is read in an inert document, so nothing in it runs or loads.
 *
 * @param {string?} html
 */
function htmlToText(html) {
  if (!html) { return '' }

  const body = new DOMParser().parseFromString(html, 'text/html').body

  // Custom emoji are images, and an image contributes no text: take what it
  // stands for, so that a post written in emoji is not a blank card.
  for (const image of body.querySelectorAll('img')) {
    image.replaceWith(image.alt ?? '')
  }

  // The post's own line breaks would spend the snippet's few lines on
  // whitespace, so it reads as one paragraph.
  return body.textContent.replaceAll(/\s+/g, ' ').trim()
}
</script>

<style scoped src="./FtPostCard.scss" lang="scss" />
