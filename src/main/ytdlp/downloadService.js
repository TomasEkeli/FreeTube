import path from 'node:path'

import { parseProgressLine, progressArgs } from './progressProtocol'
import { ytDlpProxy } from './proxy'
import { parseCustomArgs } from './settings'
import { createToolDetector, TOOLS } from './toolDetection'

/**
 * The download service: hands a video to yt-dlp, follows it through its
 * stages, and reports what became of it.
 *
 * Everything it touches outside itself is injected, so that it can be driven
 * in tests with a scripted child process and no real spawning.
 */

const VIDEO_ID_PATTERN = /^[\w-]{11}$/

/**
 * @param {unknown} videoId
 * @returns {videoId is string}
 */
export function isValidVideoId(videoId) {
  return typeof videoId === 'string' && VIDEO_ID_PATTERN.test(videoId)
}

/**
 * Only the id: no playlist, no timestamp.
 * @param {string} videoId
 */
export function buildWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * @typedef {object} DownloadRequest
 * @property {string} videoId
 * @property {string} title shown in toasts and the downloads panel only, never passed to yt-dlp
 */

/**
 * @typedef {'preparing' | 'downloading' | 'merging' | 'processing' | 'finished' | 'failed' | 'cancelled'} DownloadStatus
 */

/**
 * Where a download stands, as the renderer shows it. Anything not known yet
 * is null.
 *
 * @typedef {object} DownloadSnapshot
 * @property {string} videoId
 * @property {string} title
 * @property {DownloadStatus} status
 * @property {string} folder where yt-dlp was told to put it
 * @property {string | null} destination the file, once yt-dlp has said
 * @property {boolean} resuming earlier partial files are being carried on from
 * @property {number | null} part which part is downloading, from 1
 * @property {number | null} parts how many there are: 2 for separate video and audio
 * @property {'video' | 'audio' | 'both' | null} partKind
 * @property {number | null} downloadedBytes of the current part
 * @property {number | null} totalBytes of the current part, or yt-dlp's estimate
 * @property {number | null} speed bytes per second
 * @property {number | null} eta seconds left for the current part
 * @property {string | null} reason why it failed, in yt-dlp's words
 * @property {number | null} exitCode
 * @property {number | null} endedAt when it finished, failed or was cancelled
 */

/**
 * @typedef {(
 *   { type: 'progress', videoId: string, title: string, download: DownloadSnapshot } |
 *   { type: 'started', videoId: string, title: string, download: DownloadSnapshot } |
 *   { type: 'already-running', videoId: string, title: string } |
 *   { type: 'finished', videoId: string, title: string, path: string | null, download: DownloadSnapshot } |
 *   { type: 'failed', videoId: string, title: string, reason: string | null, exitCode: number | null, download?: DownloadSnapshot } |
 *   { type: 'cancelled', videoId: string, title: string, download: DownloadSnapshot } |
 *   { type: 'not-found', videoId: string, title: string } |
 *   { type: 'tools-missing', videoId: string, title: string, missing: import('./toolDetection').Tool[] }
 * )} DownloadOutcome
 */

// The started toast waits for yt-dlp to say where the file will go, so that
// it can say so; but not forever
const STARTED_FALLBACK_MS = 5000

// Progress goes to the renderer at most this often per download, apart from
// changes of stage or part
const PROGRESS_INTERVAL_MS = 900

// How long an ended download stays listed, for a window opened afterwards
const ENDED_KEPT_MS = 5 * 60 * 1000

// A part whose first progress line already has this much is a resumed one
const RESUMED_BYTES = 64 * 1024

/**
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {(id: keyof typeof import('./settings').SETTING_DEFAULTS) => Promise<any>} deps.readSetting
 * @param {(filePath: string) => Promise<boolean>} deps.isExecutableFile
 * @param {(dir: string) => Promise<string[]>} [deps.listDirectory] for telling a resumed download from a fresh one
 * @param {string} deps.managedDir the folder FreeTube installs the tools into
 * @param {() => string} deps.defaultDownloadFolder the system Downloads folder
 * @param {string} deps.platform
 * @param {Record<string, string | undefined>} deps.env
 * @param {ReturnType<typeof createToolDetector>} [deps.detector] shared with the installer; made from the rest when not given
 * @param {() => number} [deps.now]
 * @param {number} [deps.startedFallbackMs]
 */
export function createDownloadService(deps) {
  const {
    spawn,
    readSetting,
    managedDir,
    defaultDownloadFolder,
    platform,
    env,
    listDirectory = async () => [],
    now = Date.now,
    startedFallbackMs = STARTED_FALLBACK_MS,
  } = deps
  const detector = deps.detector ?? createToolDetector(deps)
  const pathModule = platform === 'win32' ? path.win32 : path.posix

  /**
   * Keyed by video id. Holds `null` between accepting a request and having a
   * child, so that a second click in that window is still turned away.
   * @type {Map<string, import('node:child_process').ChildProcess | null>}
   */
  const running = new Map()

  /**
   * Children stopped on purpose, and why: on quit there is nobody left to
   * tell; on cancel the viewer is told it was cancelled, not that it failed.
   * @type {Map<import('node:child_process').ChildProcess, 'quit' | 'cancel'>}
   */
  const stopped = new Map()

  /** Downloads cancelled before they had a child */
  const cancelledEarly = new Set()

  /** Set on quit, so that a download still being prepared is never started */
  let stopping = false

  /**
   * Every download this session, running or recently ended, for the
   * downloads panel of a window opened later.
   * @type {Map<string, DownloadSnapshot>}
   */
  const downloads = new Map()

  /**
   * The last finished file per video id, so that "show in folder" can be asked
   * for by id and never by a path the renderer supplies.
   * @type {Map<string, { path: string | null, folder: string }>}
   */
  const finished = new Map()

  /**
   * @param {DownloadRequest} request
   * @param {(outcome: DownloadOutcome) => void} report
   */
  async function start({ videoId, title }, report) {
    if (running.has(videoId)) {
      report({ type: 'already-running', videoId, title })
      return
    }

    running.set(videoId, null)
    cancelledEarly.delete(videoId)

    /** @type {DownloadSnapshot} */
    const download = {
      videoId,
      title,
      status: 'preparing',
      folder: '',
      destination: null,
      resuming: false,
      part: null,
      parts: null,
      partKind: null,
      downloadedBytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      reason: null,
      exitCode: null,
      endedAt: null,
    }

    let tools
    let command
    try {
      download.folder = (await readSetting('ytDlpDownloadFolder')) || defaultDownloadFolder()
      downloads.set(videoId, download)
      report({ type: 'progress', videoId, title, download: { ...download } })

      tools = await detector.detect()
      command = await buildCommand({ videoId, folder: download.folder, tools })
    } catch (error) {
      running.delete(videoId)
      end(download, 'failed', { reason: String(error?.message ?? error) })
      report({ type: 'failed', videoId, title, reason: download.reason, exitCode: null, download: { ...download } })
      return
    }

    // Without yt-dlp there is nothing to run, and without ffmpeg or Deno a
    // YouTube download comes out at low quality or not at all. Either way
    // the remedy is an install, not a retry, so nothing is spawned.
    const missing = TOOLS.filter(tool => !tools[tool].found)
    if (missing.length > 0) {
      running.delete(videoId)
      downloads.delete(videoId)
      report({ type: 'tools-missing', videoId, title, missing })
      return
    }

    if (stopping) {
      running.delete(videoId)
      return
    }

    if (cancelledEarly.delete(videoId)) {
      running.delete(videoId)
      end(download, 'cancelled')
      report({ type: 'cancelled', videoId, title, download: { ...download } })
      return
    }

    run(download, tools['yt-dlp'].path, command, report)
  }

  /**
   * yt-dlp's own defaults, plus only what FreeTube needs, then the user's own
   * arguments, then the end-of-options marker and the URL.
   *
   * @param {{ videoId: string, folder: string, tools: import('./toolDetection').ToolStatuses }} options
   * @returns {Promise<{ args: string[], extraEnv: Record<string, string> }>}
   */
  async function buildCommand({ videoId, folder, tools }) {
    const args = [
      '--paths', `home:${folder}`,
      // Where it will go, how it is getting on, and where it went
      ...progressArgs(),
    ]

    // yt-dlp finds these itself on PATH, but not in FreeTube's tools folder.
    // The folder rather than the file for ffmpeg, so that ffprobe is found too.
    if (tools.ffmpeg.found && tools.ffmpeg.source === 'managed') {
      args.push('--ffmpeg-location', managedDir)
    }

    if (tools.deno.found && tools.deno.source === 'managed') {
      args.push('--js-runtimes', `deno:${tools.deno.path}`)
    }

    // Through the same proxy as the rest of FreeTube, so that downloading
    // does not step around the privacy setup
    const proxy = await ytDlpProxy(readSetting)

    const customArgs = parseCustomArgs(await readSetting('ytDlpCustomArgs'))

    args.push(...proxy.args, ...customArgs, '--', buildWatchUrl(videoId))

    return { args, extraEnv: proxy.env }
  }

  /**
   * @param {DownloadSnapshot} download
   * @param {string} executable
   * @param {{ args: string[], extraEnv: Record<string, string> }} command
   * @param {(outcome: DownloadOutcome) => void} report
   */
  function run(download, executable, { args, extraEnv }, report) {
    const { videoId, title } = download

    let child
    try {
      child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group on POSIX, so that stopping it reaches the
        // ffmpeg it may have started as well.
        detached: platform !== 'win32',
        env: { ...env, ...extraEnv, PYTHONIOENCODING: 'utf-8' },
      })
    } catch {
      running.delete(videoId)
      downloads.delete(videoId)
      report({ type: 'not-found', videoId, title })
      return
    }

    running.set(videoId, child)

    let settled = false
    let announced = false
    let finalPath = null
    let lastErrorLine = null
    let lastSent = 0
    /** Parts seen so far, by format id, in the order they started */
    const partOrder = []

    const snapshot = () => ({ ...download })

    // The first toast: once yt-dlp has said where the file goes, or after a
    // few seconds without
    const announce = () => {
      if (!announced && !settled) {
        announced = true
        clearTimeout(fallbackTimer)
        report({ type: 'started', videoId, title, download: snapshot() })
      }
    }

    const fallbackTimer = setTimeout(announce, startedFallbackMs)

    /**
     * @param {boolean} force a change of stage or part, sent straight away
     */
    const sendProgress = (force) => {
      if (settled) {
        return
      }
      const time = now()
      if (force || time - lastSent >= PROGRESS_INTERVAL_MS) {
        lastSent = time
        report({ type: 'progress', videoId, title, download: snapshot() })
      }
    }

    /**
     * @param {string} line
     */
    const handleLine = (line) => {
      if (line.startsWith('ERROR:')) {
        lastErrorLine = line.slice('ERROR:'.length).trim()
        return
      }

      const parsed = parseProgressLine(line)
      if (parsed === null) {
        return
      }

      switch (parsed.kind) {
        case 'dest':
          download.destination = parsed.path
          download.parts = parsed.formatIds.length > 0 ? parsed.formatIds.length : null
          detectResume(parsed.path).then((resuming) => {
            download.resuming ||= resuming
            sendProgress(true)
            announce()
          })
          break

        case 'progress': {
          let index = partOrder.indexOf(parsed.formatId)
          const newPart = index === -1
          if (newPart) {
            partOrder.push(parsed.formatId)
            index = partOrder.length - 1

            // A part that starts with bytes already there was carried on
            // from an earlier attempt
            if (parsed.status === 'downloading' && (parsed.downloadedBytes ?? 0) >= RESUMED_BYTES) {
              download.resuming = true
            }
          }

          const stageChanged = download.status !== 'downloading'
          download.status = 'downloading'
          download.part = index + 1
          download.parts = Math.max(download.parts ?? 0, partOrder.length)
          download.partKind = parsed.partKind
          download.downloadedBytes = parsed.downloadedBytes
          download.totalBytes = parsed.totalBytes
          download.speed = parsed.status === 'finished' ? null : parsed.speed
          download.eta = parsed.status === 'finished' ? 0 : parsed.eta
          sendProgress(newPart || stageChanged || parsed.status === 'finished')
          break
        }

        case 'post':
          if (parsed.status !== 'started' || parsed.postprocessor === 'MoveFiles') {
            break
          }
          download.status = parsed.postprocessor === 'Merger' ? 'merging' : 'processing'
          download.speed = null
          download.eta = null
          sendProgress(true)
          break

        case 'done':
          finalPath = parsed.path
          break
      }
    }

    readLines(child.stdout, handleLine)
    readLines(child.stderr, handleLine)

    child.once('error', () => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(fallbackTimer)
      running.delete(videoId)
      downloads.delete(videoId)
      report({ type: 'not-found', videoId, title })
    })

    child.once('close', (code) => {
      if (running.get(videoId) === child) {
        running.delete(videoId)
      }

      if (settled) {
        return
      }

      settled = true
      clearTimeout(fallbackTimer)

      const why = stopped.get(child)
      stopped.delete(child)

      // Stopped on quit: there is nobody left to tell
      if (why === 'quit') {
        return
      }

      if (why === 'cancel') {
        end(download, 'cancelled')
        report({ type: 'cancelled', videoId, title, download: snapshot() })
      } else if (code === 0) {
        const filePath = finalPath ?? download.destination
        download.destination = filePath
        end(download, 'finished')
        finished.set(videoId, { path: filePath, folder: download.folder })
        report({ type: 'finished', videoId, title, path: filePath, download: snapshot() })
      } else {
        end(download, 'failed', { reason: lastErrorLine, exitCode: code })
        report({ type: 'failed', videoId, title, reason: lastErrorLine, exitCode: code, download: snapshot() })
      }
    })
  }

  /**
   * Whether earlier partial files for this destination are there: the final
   * file's own `.part`, or the per-format files yt-dlp merges from, finished
   * or not.
   *
   * @param {string} destination
   */
  async function detectResume(destination) {
    try {
      const dir = pathModule.dirname(destination)
      const base = pathModule.basename(destination)
      const stem = base.slice(0, base.length - pathModule.extname(base).length)
      const names = await listDirectory(dir)

      return names.some((name) => {
        if (name === base || !name.startsWith(`${stem}.`)) {
          return false
        }
        const tail = name.slice(stem.length)
        return tail.endsWith('.part') || /^\.f[\w-]+\.\w+$/.test(tail)
      })
    } catch {
      return false
    }
  }

  /**
   * @param {DownloadSnapshot} download
   * @param {'finished' | 'failed' | 'cancelled'} status
   * @param {{ reason?: string | null, exitCode?: number | null }} [details]
   */
  function end(download, status, { reason = null, exitCode = null } = {}) {
    download.status = status
    download.reason = reason
    download.exitCode = exitCode
    download.speed = null
    download.eta = null
    download.endedAt = now()
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   */
  function terminate(child) {
    if (platform === 'win32' && child.pid) {
      // The whole tree, since yt-dlp may be running ffmpeg. By its full path,
      // rather than whatever PATH offers under that name.
      const taskkill = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }

    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
        return
      } catch {}
    }

    child.kill('SIGTERM')
  }

  /**
   * Stops a download. yt-dlp keeps its partial files, so pressing download
   * again resumes. One still being prepared is never started.
   *
   * @param {string} videoId
   * @returns {boolean} whether there was one to stop
   */
  function cancel(videoId) {
    if (!running.has(videoId)) {
      return false
    }

    const child = running.get(videoId)

    if (child) {
      stopped.set(child, 'cancel')
      terminate(child)
    } else {
      cancelledEarly.add(videoId)
    }

    return true
  }

  /**
   * Terminates every running download. yt-dlp keeps its partial files, so the
   * next attempt at the same video resumes rather than starting over.
   */
  function stopAll() {
    stopping = true

    for (const child of running.values()) {
      if (child) {
        stopped.set(child, 'quit')
        terminate(child)
      }
    }
  }

  function isBusy() {
    return running.size > 0
  }

  /**
   * @param {string} videoId
   */
  function getFinished(videoId) {
    return finished.get(videoId)
  }

  /**
   * The downloads this session that are running or ended recently, and the
   * videos with a finished file, for a window to start from.
   */
  function list() {
    const cutoff = now() - ENDED_KEPT_MS

    for (const [videoId, download] of downloads) {
      if (download.endedAt !== null && download.endedAt < cutoff) {
        downloads.delete(videoId)
      }
    }

    return {
      downloads: [...downloads.values()].map(download => ({ ...download })),
      finished: Object.fromEntries([...finished].map(([videoId, { path: filePath }]) => [videoId, filePath])),
    }
  }

  /**
   * Takes an ended download off the list. Its finished file is still
   * remembered for "show in folder".
   *
   * @param {string} videoId
   */
  function dismiss(videoId) {
    if (downloads.get(videoId)?.endedAt != null) {
      downloads.delete(videoId)
    }
  }

  return { start, cancel, stopAll, isBusy, getFinished, list, dismiss, detector }
}

const MAX_LINE_LENGTH = 64 * 1024

/**
 * @param {import('node:stream').Readable | null} stream
 * @param {(line: string) => void} onLine
 */
function readLines(stream, onLine) {
  if (!stream) {
    return
  }

  let buffered = ''
  stream.setEncoding('utf8')

  stream.on('data', (chunk) => {
    // A carriage return alone ends a line too: progress output, should custom
    // arguments turn yt-dlp's own back on, is a stream of them
    const lines = (buffered + chunk).split(/\r\n|\r|\n/)
    // Bounded, in case something writes on and on without ending a line
    buffered = lines.pop().slice(-MAX_LINE_LENGTH)

    for (const line of lines) {
      if (line.trim().length > 0) {
        onLine(line.trim())
      }
    }
  })

  stream.on('end', () => {
    if (buffered.trim().length > 0) {
      onLine(buffered.trim())
    }
    buffered = ''
  })
}
