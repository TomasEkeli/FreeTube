import i18n from '../i18n/index'
import { showToast } from './utils'

/**
 * The renderer's half of download with yt-dlp: asking main to download, and
 * turning what main reports back into toasts. Electron only.
 */

// Long enough to read a yt-dlp error line, and to get to the finished toast
// before it goes
const LONG_TOAST_MS = 10_000

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
 * Registered once, at startup.
 */
export function setupYtDlpOutcomeToasts() {
  if (!process.env.IS_ELECTRON) {
    return
  }

  window.ftElectron.handleYtDlpDownloadOutcome(showOutcome)
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
  }
}
