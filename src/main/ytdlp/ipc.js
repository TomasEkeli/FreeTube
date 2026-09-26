import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'

import { IpcChannels } from '../../constants'
import { isFreeTubeUrl } from '../utils'
import { createDownloadService, isValidVideoId } from './downloadService'

/**
 * The IPC surface of download with yt-dlp. The handlers are thin: check the
 * sender, check the payload, call a module, forward what it says.
 */
export function registerYtDlpHandlers() {
  const downloadService = createDownloadService({
    spawn,
    isExecutableFile,
    defaultDownloadFolder: () => app.getPath('downloads'),
    platform: process.platform,
    env: process.env,
  })

  ipcMain.on(IpcChannels.YTDLP_DOWNLOAD, (event, payload) => {
    // Only from FreeTube, and only from the window the viewer is using: the
    // preload has already required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused()) {
      return
    }

    if (payload == null || typeof payload !== 'object' || !isValidVideoId(payload.videoId)) {
      return
    }

    // For the toasts only; it never reaches the command line
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 300) : ''
    const sender = event.sender

    downloadService.start({ videoId: payload.videoId, title }, (outcome) => {
      sendToFreeTube(sender, IpcChannels.YTDLP_DOWNLOAD_OUTCOME, outcome)
    })
  })

  ipcMain.on(IpcChannels.YTDLP_REVEAL, async (event, videoId) => {
    if (!isFreeTubeUrl(event.senderFrame.url) || !isValidVideoId(videoId)) {
      return
    }

    const finished = downloadService.getFinished(videoId)

    if (!finished) {
      return
    }

    if (finished.path && await fileExists(finished.path)) {
      shell.showItemInFolder(finished.path)
    } else {
      // yt-dlp did not say where it put the file, or it has moved since
      await shell.openPath(finished.folder)
    }
  })

  app.on('will-quit', () => {
    downloadService.stopAll()
  })

  return { downloadService }
}

/**
 * Sends to the window that asked, or, when that one has closed since, to
 * another FreeTube window, so that a download finishing after its window has
 * gone is still reported.
 *
 * @param {import('electron').WebContents} preferred
 * @param {string} channel
 * @param {any} payload
 */
function sendToFreeTube(preferred, channel, payload) {
  if (!preferred.isDestroyed() && isFreeTubeUrl(preferred.getURL())) {
    preferred.send(channel, payload)
    return
  }

  const window = BrowserWindow.getAllWindows()
    .find(window => !window.webContents.isDestroyed() && isFreeTubeUrl(window.webContents.getURL()))

  window?.webContents.send(channel, payload)
}

/**
 * @param {string} filePath
 */
async function isExecutableFile(filePath) {
  try {
    await fs.access(filePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} filePath
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
