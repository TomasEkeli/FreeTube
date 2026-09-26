import { createHash } from 'node:crypto'
import path from 'node:path'

import { extractFiles } from './extract'
import { runCapture } from './runCapture'
import { managedToolPath, TOOLS } from './toolDetection'

/**
 * The tool installer: fetches what detection reports missing from each
 * project's own releases, checks it against the checksums the project
 * publishes, and puts it in FreeTube's tools folder. It relies on nothing
 * already being installed: no Python, no `unzip`, no `xz`.
 */

const YT_DLP_NIGHTLY = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download'
const FFMPEG_BUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest'
const DENO = 'https://github.com/denoland/deno/releases/latest/download'

/**
 * @typedef {object} Asset
 * @property {string} url
 * @property {'binary' | 'zip' | 'tar.xz'} kind a plain executable, or an archive to take files out of
 * @property {{ url: string, name: string | null }} sums the published SHA-256 sums, and the line to look for; `null` for a file that sums only this asset
 * @property {{ entry: string, name: string }[]} [files] for an archive: which files to take out (see `extract.js`), and their names in the tools folder
 */

/**
 * What each project publishes, per platform and architecture, as checked on
 * 2026-09-26. yt-dlp from the nightly channel, which yt-dlp recommends for
 * regular users, since YouTube breaks the stable channel between releases.
 * On Linux the standalone `yt-dlp_linux`, never the zipimport `yt-dlp`, which
 * needs a Python interpreter. ffmpeg from yt-dlp's own FFmpeg builds, with
 * ffprobe beside it since yt-dlp uses both. Deno from Deno's releases, the
 * `deno` archive rather than the `denort` runtime-only one.
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
  ffmpeg: {
    'win32-x64': {
      url: `${FFMPEG_BUILDS}/ffmpeg-master-latest-win64-gpl.zip`,
      kind: 'zip',
      sums: { url: `${FFMPEG_BUILDS}/checksums.sha256`, name: 'ffmpeg-master-latest-win64-gpl.zip' },
      files: [{ entry: 'bin/ffmpeg.exe', name: 'ffmpeg.exe' }, { entry: 'bin/ffprobe.exe', name: 'ffprobe.exe' }],
    },
    'linux-x64': {
      url: `${FFMPEG_BUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
      kind: 'tar.xz',
      sums: { url: `${FFMPEG_BUILDS}/checksums.sha256`, name: 'ffmpeg-master-latest-linux64-gpl.tar.xz' },
      files: [{ entry: 'bin/ffmpeg', name: 'ffmpeg' }, { entry: 'bin/ffprobe', name: 'ffprobe' }],
    },
  },
  deno: {
    'win32-x64': {
      url: `${DENO}/deno-x86_64-pc-windows-msvc.zip`,
      kind: 'zip',
      sums: { url: `${DENO}/deno-x86_64-pc-windows-msvc.zip.sha256sum`, name: null },
      files: [{ entry: 'deno.exe', name: 'deno.exe' }],
    },
    'linux-x64': {
      url: `${DENO}/deno-x86_64-unknown-linux-gnu.zip`,
      kind: 'zip',
      sums: { url: `${DENO}/deno-x86_64-unknown-linux-gnu.zip.sha256sum`, name: null },
      files: [{ entry: 'deno', name: 'deno' }],
    },
  },
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

// A request that goes this long without a byte is given up on: fetch itself
// would wait forever on a proxy or network that swallows connections
const STALL_MS = 30_000

/**
 * @param {object} deps
 * @param {typeof globalThis.fetch} deps.fetch
 * @param {import('./nodeFileSystem').FileSystem} deps.fs
 * @param {ReturnType<typeof import('./toolDetection').createToolDetector>} deps.detector
 * @param {string} deps.managedDir
 * @param {string} deps.platform
 * @param {string} deps.arch
 * @param {typeof import('node:child_process').spawn} [deps.spawn] for updating yt-dlp
 * @param {(progress: InstallProgress) => void} [deps.onProgress]
 * @param {number} [deps.stallMs]
 */
export function createToolInstaller({ fetch, fs, detector, managedDir, platform, arch, spawn, onProgress = () => {}, stallMs = STALL_MS }) {
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

      // Never opened, let alone written into place, unless it is exactly
      // what was published
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${assetName}. It may have been truncated, or a new release came out mid-download; try again`)
      }

      if (asset.kind === 'binary') {
        await placeExecutables([{ temporary: download, destination }])
      } else {
        onProgress({ tool, stage: 'extracting' })

        const extracted = await extractFiles({
          fs,
          archivePath: download,
          kind: asset.kind,
          files: asset.files.map(file => ({ entry: file.entry, destination: pathModule.join(managedDir, file.name) })),
        })

        await placeExecutables(extracted)
      }
    } finally {
      await fs.rm(download)
    }

    onProgress({ tool, stage: 'done' })
  }

  /**
   * Gives each file its executable bit and moves it into place, only once
   * they are all ready, so that a failure leaves no partial set behind.
   *
   * @param {{ temporary: string, destination: string }[]} files
   */
  async function placeExecutables(files) {
    try {
      for (const { temporary } of files) {
        await fs.chmod(temporary, 0o755)
      }

      for (const { temporary, destination } of files) {
        await fs.rename(temporary, destination)
      }
    } finally {
      await Promise.all(files.map(({ temporary }) => fs.rm(temporary)))
    }
  }

  /**
   * Fetches with a watchdog that gives up once nothing has arrived for a
   * while. `alive` is to be called whenever something does arrive.
   *
   * @template T
   * @param {string} url
   * @param {(response: Response, alive: () => void) => Promise<T>} consume
   * @returns {Promise<T>}
   */
  async function request(url, consume) {
    const controller = new AbortController()
    let timer

    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        controller.abort(new Error(`No response from ${new URL(url).host} for ${Math.round(stallMs / 1000)} seconds`))
      }, stallMs)
    }

    alive()
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} fetching ${url}`)
      }
      return await consume(response, alive)
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {string} url
   */
  function fetchText(url) {
    return request(url, response => response.text())
  }

  /**
   * Streams a download to a file, hashing it on the way.
   *
   * @param {string} url
   * @param {string} filePath
   * @param {import('./toolDetection').Tool} tool
   * @returns {Promise<string>} the SHA-256 of what was written
   */
  function downloadTo(url, filePath, tool) {
    return request(url, async (response, alive) => {
      const lengthHeader = Number(response.headers.get('content-length'))
      const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null

      const hash = createHash('sha256')
      const file = await fs.openWrite(filePath)
      let received = 0
      let reported = 0

      try {
        for await (const chunk of response.body) {
          alive()
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
    })
  }

  /**
   * Runs yt-dlp's own self-update on the yt-dlp that downloads use, which
   * keeps the channel it came from: nightly, for the managed copy.
   *
   * @returns {Promise<UpdateResult>}
   */
  async function updateYtDlp() {
    const ytDlp = (await detector.detect({ fresh: true }))['yt-dlp']

    if (!ytDlp.found) {
      return { status: 'missing' }
    }

    const { code, stdout, stderr, error } = await runCapture(spawn, ytDlp.path, ['-U'], { timeoutMs: UPDATE_TIMEOUT_MS })
    detector.invalidate()

    const outcome = interpretUpdate({ code, stdout, stderr, error })

    if (outcome.status === 'updated' || outcome.status === 'current') {
      const after = (await detector.detect({ fresh: true }))['yt-dlp']
      return { ...outcome, version: after.version ?? outcome.version }
    }

    return outcome
  }

  return { install, isInstalling, updateYtDlp }
}

// The self-update downloads the whole binary again
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * @typedef {(
 *   { status: 'updated', version: string | null } |
 *   { status: 'current', version: string | null } |
 *   { status: 'package-manager' } |
 *   { status: 'failed', reason: string } |
 *   { status: 'missing' } |
 *   { status: 'busy' }
 * )} UpdateResult
 */

/**
 * What yt-dlp's `-U` said, in yt-dlp's words where it has any.
 *
 * @param {{ code: number | null, stdout: string, stderr: string, error: Error | null }} run
 * @returns {UpdateResult}
 */
export function interpretUpdate({ code, stdout, stderr, error }) {
  if (error) {
    return { status: 'failed', reason: error.message }
  }

  const output = `${stdout}\n${stderr}`

  // "Updated yt-dlp to nightly@2026.09.16.232951 from yt-dlp/yt-dlp-nightly-builds"
  const updated = /Updated yt-dlp to (?:\w+@)?(\S+)/.exec(output)
  if (code === 0 && updated) {
    return { status: 'updated', version: updated[1] }
  }

  // "yt-dlp is up to date (nightly@2026.09.16.232951 from ...)"
  const current = /yt-dlp is up to date \((?:\w+@)?([^\s)]+)/.exec(output)
  if (code === 0 && current) {
    return { status: 'current', version: current[1] }
  }

  // Installed with pip, or a package manager, which yt-dlp leaves to update it:
  // "You installed yt-dlp with pip or using the wheel from PyPi; Use that to update"
  if (/Use that to update/i.test(output)) {
    return { status: 'package-manager' }
  }

  const errorLines = output.split(/\r?\n/).filter(line => line.startsWith('ERROR:'))
  const reason = errorLines.length > 0
    ? errorLines.at(-1).slice('ERROR:'.length).trim()
    : `yt-dlp exited with code ${code}`

  return { status: 'failed', reason }
}
