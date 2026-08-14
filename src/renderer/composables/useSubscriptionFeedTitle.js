import { useI18n } from 'vue-i18n'

/**
 * What each subscription feed is called.
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
