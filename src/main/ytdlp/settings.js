/**
 * The settings download with yt-dlp reads in main, with the defaults the
 * renderer's settings store gives them, since a setting never changed is not
 * in the database at all.
 */
export const SETTING_DEFAULTS = Object.freeze({
  ytDlpEnabled: false,
  ytDlpExecutablePath: '',
  ytDlpDownloadFolder: '',
  ytDlpCustomArgs: '[]',
  useProxy: false,
  proxyProtocol: 'socks5',
  proxyHostname: '127.0.0.1',
  proxyPort: '9050',
  proxyUsername: '',
  proxyPassword: '',
})

/**
 * Locations, which only main's pickers may set: a path the renderer can write
 * is a program, or a place to write to, that a compromised renderer can choose.
 * Clearing one is allowed, since empty means the default.
 */
const PICKER_ONLY_SETTINGS = new Set(['ytDlpExecutablePath', 'ytDlpDownloadFolder'])

/**
 * @param {string} settingId
 * @param {unknown} value
 */
export function isRendererWritableYtDlpSetting(settingId, value) {
  return !PICKER_ONLY_SETTINGS.has(settingId) || value === ''
}

/**
 * @param {(id: string) => Promise<{ value: any } | null | undefined>} findOne
 * @returns {(id: keyof typeof SETTING_DEFAULTS) => Promise<any>}
 */
export function createSettingsReader(findOne) {
  return async (id) => {
    const doc = await findOne(id)
    return doc == null || doc.value === undefined ? SETTING_DEFAULTS[id] : doc.value
  }
}

/**
 * The custom arguments, stored as a JSON array of strings like the external
 * player's. Anything else is ignored rather than guessed at.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
export function parseCustomArgs(stored) {
  if (typeof stored !== 'string') {
    return []
  }

  try {
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) && parsed.every(arg => typeof arg === 'string') ? parsed : []
  } catch {
    return []
  }
}
