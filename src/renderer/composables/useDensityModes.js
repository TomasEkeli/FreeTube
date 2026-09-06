import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The density modes, narrowest first.
 *
 * The names are all that is shared: what each mode measures is in density.css,
 * keyed on `body[data-density]`, and which one is chosen is the `listDensity`
 * setting. Two controls write that setting, the switch over the subscriptions
 * stream and the entry in the general settings, and they read the modes and
 * their words from here so that they cannot come to disagree about either.
 */
export const DENSITY_MODES = ['tight', 'standard', 'spacious']

/**
 * The modes as the reader sees them, keyed by mode.
 *
 * A key at a time, with the locale strings written out: the i18n lint refuses
 * a computed key, and rightly, since a key built at runtime is a key nothing
 * can find.
 *
 * @returns {import('vue').ComputedRef<Record<string, string>>}
 */
export function useDensityModeNames() {
  const { t } = useI18n()

  return computed(() => ({
    tight: t('Global.Density.Tight'),
    standard: t('Global.Density.Standard'),
    spacious: t('Global.Density.Spacious')
  }))
}
