import { useI18n } from 'vue-i18n'

/**
 * What each subscription feed is called.
 *
 * It labelled the tab strip, and now it labels the chips that replaced it: the
 * words a reader chooses a kind by are the same words whatever the control is
 * shaped like.
 *
 * Kept apart from the feed descriptors, which hold everything else about a feed,
 * because a translation key can only be looked up from a literal: the linter
 * refuses a dynamic one, and it is right to, since a key assembled at runtime
 * cannot be checked against the locale files. So the mapping is written out.
 */
export function useSubscriptionFeedTitle() {
  const { t } = useI18n()

  /**
   * @param {string} feed
   * @returns {string}
   */
  return function subscriptionFeedTitle(feed) {
    switch (feed) {
      case 'videos':
        return t('Global.Videos')
      case 'shorts':
        return t('Global.Shorts')
      case 'live':
        return t('Global.Live')
      case 'posts':
        return t('Global.Posts')
      default:
        return ''
    }
  }
}
