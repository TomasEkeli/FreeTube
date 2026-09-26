import { app, BrowserWindow, ipcMain, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { IpcChannels } from '../../constants'
import { settings } from '../../datastores/handlers/base'
import { isFreeTubeUrl } from '../utils'
import { createDownloadService, isValidVideoId } from './downloadService'
import { createSettingsReader } from './settings'
import { createToolDetector } from './toolDetection'
import { createToolInstaller, installCoverage } from './toolInstaller'
import { nodeFileSystem } from './nodeFileSystem'

export { isRendererWritableYtDlpSetting } from './settings'

/**
 * The IPC surface of download with yt-dlp. The handlers are thin: check the
 * sender, check the payload, call a module, forward what it says.
 *
 * @param {object} deps
 * @param {(webContents: import('electron').WebContents, currentPath: string | undefined, options: object) => Promise<string | undefined>} deps.chooseDefaultFolder
 *   main's picker for settings the renderer may not write
 */
export function registerYtDlpHandlers({ chooseDefaultFolder }) {
  const readSetting = createSettingsReader(id => settings._findOne(id))

  // Under the user data directory: no administrator rights needed, and gone
  // with the profile
  const managedDir = path.join(app.getPath('userData'), 'bin')

  const detector = createToolDetector({
    spawn,
    isExecutableFile,
    readSetting,
    managedDir,
    platform: process.platform,
    env: process.env,
  })

  const downloadService = createDownloadService({
    spawn,
    readSetting,
    isExecutableFile,
    managedDir,
    detector,
    defaultDownloadFolder: () => app.getPath('downloads'),
    platform: process.platform,
    env: process.env,
  })

  const installer = createToolInstaller({
    // Electron's own fetch, so that the tools come through FreeTube's proxy
    fetch: url => net.fetch(url),
    fs: nodeFileSystem,
    detector,
    managedDir,
    platform: process.platform,
    arch: process.arch,
    spawn,
    onProgress: (progress) => {
      broadcastToFreeTube(IpcChannels.YTDLP_INSTALL_PROGRESS, progress)
    },
  })

  ipcMain.on(IpcChannels.YTDLP_DOWNLOAD, async (event, payload) => {
    // Only from FreeTube, and only from the window the viewer is using: the
    // preload has already required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused()) {
      return
    }

    if (payload == null || typeof payload !== 'object' || !isValidVideoId(payload.videoId)) {
      return
    }

    // The button is not there while the feature is off, so neither is this
    if (!await readSetting('ytDlpEnabled')) {
      return
    }

    startDownload(event.sender, payload.videoId, payload.title)
  })

  const coverage = installCoverage(process.platform, process.arch)

  /**
   * @param {import('electron').WebContents} sender
   * @param {string} videoId validated
   * @param {unknown} title
   */
  async function startDownload(sender, videoId, title) {
    const request = {
      videoId,
      // For the toasts only; it never reaches the command line
      title: typeof title === 'string' ? title.slice(0, 300) : '',
    }

    /**
     * @param {import('./downloadService').DownloadOutcome | { type: 'waiting-for-install', videoId: string, title: string }} outcome
     */
    const report = (outcome) => {
      // Whether the renderer can offer to install what is missing
      const payload = outcome.type === 'tools-missing'
        ? { ...outcome, installable: outcome.missing.every(tool => coverage[tool]) }
        : outcome

      sendToFreeTube(sender, IpcChannels.YTDLP_DOWNLOAD_OUTCOME, payload)
    }

    // A press during an install waits for it rather than being told the
    // tools are missing, then goes ahead
    if (installer.isInstalling()) {
      report({ type: 'waiting-for-install', ...request })
      await installer.install()
    }

    await downloadService.start(request, report)
  }

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

  ipcMain.handle(IpcChannels.YTDLP_CHOOSE_FOLDER, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return
    }

    return await chooseDefaultFolder(event.sender, await readSetting('ytDlpDownloadFolder'), {
      settingId: 'ytDlpDownloadFolder',
      defaultPathName: 'downloads',
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  ipcMain.handle(IpcChannels.YTDLP_CHOOSE_EXECUTABLE, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return
    }

    const chosen = await chooseDefaultFolder(event.sender, await readSetting('ytDlpExecutablePath'), {
      settingId: 'ytDlpExecutablePath',
      defaultPathName: 'home',
      properties: ['openFile'],
    })

    detector.invalidate()
    return chosen
  })

  ipcMain.handle(IpcChannels.YTDLP_DETECT_TOOLS, async (event) => {
    if (!isFreeTubeUrl(event.senderFrame.url)) {
      return
    }

    return {
      tools: await detector.detect({ fresh: true }),
      coverage: installCoverage(process.platform, process.arch),
      installing: installer.isInstalling(),
      downloading: downloadService.isBusy(),
    }
  })

  ipcMain.handle(IpcChannels.YTDLP_UPDATE, async (event) => {
    // The preload has required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused()) {
      return
    }

    // Replacing the binary under a running yt-dlp fails on Windows
    if (downloadService.isBusy() || installer.isInstalling()) {
      return { status: 'busy' }
    }

    return await installer.updateYtDlp()
  })

  ipcMain.handle(IpcChannels.YTDLP_INSTALL_TOOLS, async (event, payload) => {
    // The preload has required a recent click
    if (!isFreeTubeUrl(event.senderFrame.url) || !event.sender.isFocused()) {
      return
    }

    const result = await installer.install()

    // Offered from the download button: go on with the download that was
    // asked for, once the install has succeeded
    const download = payload?.thenDownload
    if (result.ok && download != null && isValidVideoId(download.videoId) && await readSetting('ytDlpEnabled')) {
      startDownload(event.sender, download.videoId, download.title)
    }

    return result
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
 * @param {string} channel
 * @param {any} payload
 */
function broadcastToFreeTube(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed() && isFreeTubeUrl(window.webContents.getURL())) {
      window.webContents.send(channel, payload)
    }
  }
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
