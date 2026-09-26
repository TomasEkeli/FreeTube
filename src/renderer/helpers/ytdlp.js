import { reactive } from 'vue'

import i18n from '../i18n/index'
import { showToast } from './utils'

/**
 * The renderer's half of download with yt-dlp: asking main to download, and
 * turning what main reports back into toasts. Electron only.
 */

// Long enough to read a yt-dlp error line, and to get to the finished toast
// before it goes
const LONG_TOAST_MS = 10_000

// Product names, the same in every language
export const TOOL_NAMES = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'ffmpeg',
  deno: 'Deno',
}

/**
 * @param {string} videoId
 * @param {string} title
 */
export function downloadWithYtDlp(videoId, title) {
  if (process.env.IS_ELECTRON) {
    window.ftElectron.ytDlpDownload({ videoId, title })
  }
}

/**
 * The install as this window knows it, for the settings section to show.
 * Progress arrives for installs started from any window.
 */
export const ytDlpInstallState = reactive({
  /** @type {import('../../main/ytdlp/toolInstaller').InstallProgress | null} */
  progress: null,
  installing: false,
})

/**
 * Registered once, at startup.
 */
export function setupYtDlpOutcomeToasts() {
  if (!process.env.IS_ELECTRON) {
    return
  }

  window.ftElectron.handleYtDlpDownloadOutcome(showOutcome)

  window.ftElectron.handleYtDlpInstallProgress((progress) => {
    ytDlpInstallState.progress = progress
  })
}

/**
 * Installs whatever is missing. Joins an install already running, here or in
 * main.
 *
 * @returns {Promise<import('../../main/ytdlp/toolInstaller').InstallResult | undefined>}
 */
export async function installYtDlpTools() {
  ytDlpInstallState.installing = true
  try {
    return await window.ftElectron.ytDlpInstallTools()
  } finally {
    ytDlpInstallState.installing = false
    ytDlpInstallState.progress = null
  }
}

/**
 * @param {import('../../main/ytdlp/toolInstaller').InstallProgress} progress
 */
export function formatInstallProgress(progress) {
  const t = i18n.global.t
  const tool = TOOL_NAMES[progress.tool]

  switch (progress.stage) {
    case 'downloading':
      if (progress.total) {
        return t('Settings.yt-dlp Settings.Install Progress.Downloading with size', {
          tool,
          percent: Math.floor((progress.received / progress.total) * 100),
          received: toMegabytes(progress.received),
          total: toMegabytes(progress.total),
        })
      }
      return t('Settings.yt-dlp Settings.Install Progress.Downloading', { tool })
    case 'verifying':
      return t('Settings.yt-dlp Settings.Install Progress.Verifying', { tool })
    case 'extracting':
      return t('Settings.yt-dlp Settings.Install Progress.Extracting', { tool })
    case 'done':
      return t('Settings.yt-dlp Settings.Install Progress.Done', { tool })
  }
  return ''
}

/**
 * @param {import('../../main/ytdlp/toolInstaller').InstallResult} result
 */
export function formatInstallResult(result) {
  const t = i18n.global.t

  if (result.ok) {
    return result.installed.length > 0
      ? t('Settings.yt-dlp Settings.Install Result.Installed', { tools: formatToolList(result.installed) })
      : t('Settings.yt-dlp Settings.Install Result.Nothing to install')
  }

  if (result.error === 'unsupported') {
    return t('Settings.yt-dlp Settings.Install Result.Unsupported', { tools: formatToolList(result.notCovered) })
  }

  return result.tool
    ? t('Settings.yt-dlp Settings.Install Result.Failed', { tool: TOOL_NAMES[result.tool], reason: result.reason })
    : t('Settings.yt-dlp Settings.Install Result.Failed without tool', { reason: result.reason })
}

/**
 * @param {number} bytes
 */
function toMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0)
}

/**
 * @param {import('../../main/ytdlp/downloadService').DownloadOutcome} outcome
 */
function showOutcome(outcome) {
  const t = i18n.global.t
  const title = outcome.title

  switch (outcome.type) {
    case 'started':
      showToast(t('Video.yt-dlp.Download started', { title }))
      break

    case 'already-running':
      showToast(t('Video.yt-dlp.Already downloading', { title }))
      break

    case 'finished':
      showToast(
        t('Video.yt-dlp.Download finished', { title }),
        LONG_TOAST_MS,
        () => window.ftElectron.ytDlpReveal(outcome.videoId)
      )
      break

    case 'failed':
      showToast(
        outcome.reason
          ? t('Video.yt-dlp.Download failed', { title, reason: outcome.reason })
          : t('Video.yt-dlp.Download failed with exit code', { title, exitCode: outcome.exitCode ?? '?' }),
        LONG_TOAST_MS
      )
      break

    case 'not-found':
      showToast(t('Video.yt-dlp.yt-dlp could not be started'), LONG_TOAST_MS)
      break

    case 'tools-missing':
      showToast(
        t('Video.yt-dlp.Tools missing', { tools: formatToolList(outcome.missing) }),
        LONG_TOAST_MS
      )
      break
  }
}

/**
 * @param {import('../../main/ytdlp/toolDetection').Tool[]} tools
 */
export function formatToolList(tools) {
  const names = tools.map(tool => TOOL_NAMES[tool])

  try {
    return new Intl.ListFormat(i18n.global.locale.value, { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}
