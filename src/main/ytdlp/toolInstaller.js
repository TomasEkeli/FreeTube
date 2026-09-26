import { createHash } from 'node:crypto'
import path from 'node:path'

import { managedToolPath, TOOLS } from './toolDetection'

/**
 * The tool installer: fetches what detection reports missing from each
 * project's own releases, checks it against the checksums the project
 * publishes, and puts it in FreeTube's tools folder. It relies on nothing
 * already being installed: no Python, no `unzip`, no `xz`.
 */

const YT_DLP_NIGHTLY = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download'

/**
 * @typedef {object} Asset
 * @property {string} url
 * @property {'binary'} kind a plain executable
 * @property {{ url: string, name: string | null }} sums the published SHA-256 sums, and the line to look for; `null` for a file that sums only this asset
 */

/**
 * What each project publishes, per platform and architecture, as checked on
 * 2026-09-26. yt-dlp from the nightly channel, which yt-dlp recommends for
 * regular users, since YouTube breaks the stable channel between releases.
 * On Linux the standalone `yt-dlp_linux`, never the zipimport `yt-dlp`, which
 * needs a Python interpreter.
 *
 * @type {Record<import('./toolDetection').Tool, Record<string, Asset>>}
 */
export const ASSETS = {
  'yt-dlp': {
    'win32-x64': {
      url: `${YT_DLP_NIGHTLY}/yt-dlp.exe`,
      kind: 'binary',
      sums: { url: `${YT_DLP_NIGHTLY}/SHA2-256SUMS`, name: 'yt-dlp.exe' },
    },
    'linux-x64': {
      url: `${YT_DLP_NIGHTLY}/yt-dlp_linux`,
      kind: 'binary',
      sums: { url: `${YT_DLP_NIGHTLY}/SHA2-256SUMS`, name: 'yt-dlp_linux' },
    },
  },
  ffmpeg: {},
  deno: {},
}

/**
 * Where each project says to get it by hand, for platforms the installer
 * does not cover.
 */
export const INSTRUCTIONS_URLS = {
  'yt-dlp': 'https://github.com/yt-dlp/yt-dlp/wiki/Installation',
  ffmpeg: 'https://github.com/yt-dlp/FFmpeg-Builds',
  deno: 'https://docs.deno.com/runtime/getting_started/installation/',
}

/**
 * @param {import('./toolDetection').Tool} tool
 * @param {string} platform
 * @param {string} arch
 * @returns {Asset | null}
 */
export function chooseAsset(tool, platform, arch) {
  return ASSETS[tool][`${platform}-${arch}`] ?? null
}

/**
 * Which tools the installer can fetch on this platform and architecture.
 *
 * @param {string} platform
 * @param {string} arch
 * @returns {Record<import('./toolDetection').Tool, boolean>}
 */
export function installCoverage(platform, arch) {
  return Object.fromEntries(TOOLS.map(tool => [tool, chooseAsset(tool, platform, arch) !== null]))
}

/**
 * The expected SHA-256 from a sums file: the line naming the file in a
 * `sha256sum` style list, or, for a file that sums only one asset, the one
 * hash in it (Deno's Windows ones are PowerShell's `Get-FileHash` output).
 *
 * @param {string} text
 * @param {string | null} fileName
 * @returns {string | null}
 */
export function findChecksum(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())

    if (match && (fileName === null || match[2].trim() === fileName)) {
      return match[1].toLowerCase()
    }
  }

  if (fileName === null) {
    return /\b([a-f0-9]{64})\b/i.exec(text)?.[1].toLowerCase() ?? null
  }

  return null
}

/**
 * @typedef {object} InstallProgress
 * @property {import('./toolDetection').Tool} tool
 * @property {'downloading' | 'verifying' | 'extracting' | 'done'} stage
 * @property {number} [received] bytes, while downloading
 * @property {number | null} [total] bytes, when the server says
 */

/**
 * @typedef {(
 *   { ok: true, installed: import('./toolDetection').Tool[], notCovered: import('./toolDetection').Tool[], statuses: import('./toolDetection').ToolStatuses } |
 *   { ok: false, error: 'unsupported', notCovered: import('./toolDetection').Tool[] } |
 *   { ok: false, error: 'failed', tool: import('./toolDetection').Tool | null, reason: string }
 * )} InstallResult
 */

// How often a download reports its progress
const PROGRESS_EVERY_BYTES = 512 * 1024

/**
 * @param {object} deps
 * @param {typeof globalThis.fetch} deps.fetch
 * @param {import('./nodeFileSystem').FileSystem} deps.fs
 * @param {ReturnType<typeof import('./toolDetection').createToolDetector>} deps.detector
 * @param {string} deps.managedDir
 * @param {string} deps.platform
 * @param {string} deps.arch
 * @param {(progress: InstallProgress) => void} [deps.onProgress]
 */
export function createToolInstaller({ fetch, fs, detector, managedDir, platform, arch, onProgress = () => {} }) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix

  /** @type {Promise<InstallResult> | null} */
  let running = null

  /**
   * Installs whatever detection reports missing. A tool found anywhere, on
   * PATH included, is used as it is and not duplicated. While an install
   * runs, asking again joins it rather than starting another.
   *
   * @returns {Promise<InstallResult>}
   */
  function install() {
    if (running === null) {
      running = installMissing().finally(() => {
        running = null
      })
    }

    return running
  }

  function isInstalling() {
    return running !== null
  }

  /**
   * @returns {Promise<InstallResult>}
   */
  async function installMissing() {
    const before = await detector.detect({ fresh: true })
    const missing = TOOLS.filter(tool => !before[tool].found)
    const installable = missing.filter(tool => chooseAsset(tool, platform, arch) !== null)
    const notCovered = missing.filter(tool => !installable.includes(tool))

    // Something is missing, and none of it can be fetched for this platform:
    // the viewer is told what to install instead
    if (missing.length > 0 && installable.length === 0) {
      return { ok: false, error: 'unsupported', notCovered }
    }

    let current = null
    try {
      if (installable.length > 0) {
        await fs.mkdir(managedDir)
      }

      for (const tool of installable) {
        current = tool
        await installTool(tool, chooseAsset(tool, platform, arch))
      }
    } catch (error) {
      return { ok: false, error: 'failed', tool: current, reason: String(error?.message ?? error) }
    } finally {
      detector.invalidate()
    }

    return { ok: true, installed: installable, notCovered, statuses: await detector.detect({ fresh: true }) }
  }

  /**
   * @param {import('./toolDetection').Tool} tool
   * @param {Asset} asset
   */
  async function installTool(tool, asset) {
    const assetName = asset.url.split('/').at(-1)
    const download = pathModule.join(managedDir, `.${assetName}.download`)
    const destination = managedToolPath(managedDir, tool, platform)

    onProgress({ tool, stage: 'downloading', received: 0, total: null })

    const expected = findChecksum(await fetchText(asset.sums.url), asset.sums.name)
    if (expected === null) {
      throw new Error(`No published checksum for ${assetName}`)
    }

    try {
      const actual = await downloadTo(asset.url, download, tool)

      onProgress({ tool, stage: 'verifying' })

      // Never written into place unless it is exactly what was published
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${assetName}. It may have been truncated, or a new release came out mid-download; try again`)
      }

      await fs.chmod(download, 0o755)
      await fs.rename(download, destination)
    } finally {
      await fs.rm(download)
    }

    onProgress({ tool, stage: 'done' })
  }

  /**
   * @param {string} url
   */
  async function fetchText(url) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`)
    }
    return await response.text()
  }

  /**
   * Streams a download to a file, hashing it on the way.
   *
   * @param {string} url
   * @param {string} filePath
   * @param {import('./toolDetection').Tool} tool
   * @returns {Promise<string>} the SHA-256 of what was written
   */
  async function downloadTo(url, filePath, tool) {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} fetching ${url}`)
    }

    const lengthHeader = Number(response.headers.get('content-length'))
    const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null

    const hash = createHash('sha256')
    const file = await fs.openWrite(filePath)
    let received = 0
    let reported = 0

    try {
      for await (const chunk of response.body) {
        hash.update(chunk)
        await file.write(chunk)
        received += chunk.length

        if (received - reported >= PROGRESS_EVERY_BYTES) {
          reported = received
          onProgress({ tool, stage: 'downloading', received, total })
        }
      }
    } finally {
      await file.close()
    }

    return hash.digest('hex')
  }

  return { install, isInstalling }
}
