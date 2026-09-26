import { buildProxyUrl } from '../utils'
import { parseCustomArgs } from './settings'
import { createToolDetector, TOOLS } from './toolDetection'

/**
 * The download service: hands a video to yt-dlp and reports what became of it.
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
 * @property {string} title shown in toasts only, never passed to yt-dlp
 */

/**
 * @typedef {(
 *   { type: 'started', videoId: string, title: string } |
 *   { type: 'already-running', videoId: string, title: string } |
 *   { type: 'finished', videoId: string, title: string, path: string | null } |
 *   { type: 'failed', videoId: string, title: string, reason: string | null, exitCode: number | null } |
 *   { type: 'not-found', videoId: string, title: string } |
 *   { type: 'tools-missing', videoId: string, title: string, missing: import('./toolDetection').Tool[] }
 * )} DownloadOutcome
 */

/**
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {(id: keyof typeof import('./settings').SETTING_DEFAULTS) => Promise<any>} deps.readSetting
 * @param {(filePath: string) => Promise<boolean>} deps.isExecutableFile
 * @param {string} deps.managedDir the folder FreeTube installs the tools into
 * @param {() => string} deps.defaultDownloadFolder the system Downloads folder
 * @param {string} deps.platform
 * @param {Record<string, string | undefined>} deps.env
 * @param {ReturnType<typeof createToolDetector>} [deps.detector] shared with the installer; made from the rest when not given
 */
export function createDownloadService(deps) {
  const { spawn, readSetting, managedDir, defaultDownloadFolder, platform, env } = deps
  const detector = deps.detector ?? createToolDetector(deps)

  /**
   * Keyed by video id. Holds `null` between accepting a request and having a
   * child, so that a second click in that window is still turned away.
   * @type {Map<string, import('node:child_process').ChildProcess | null>}
   */
  const running = new Map()

  /** @type {Set<import('node:child_process').ChildProcess>} */
  const stopped = new Set()

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

    let tools
    let args
    let folder
    try {
      tools = await detector.detect()
      folder = (await readSetting('ytDlpDownloadFolder')) || defaultDownloadFolder()
      args = await buildArgs({ videoId, folder, tools })
    } catch (error) {
      running.delete(videoId)
      report({ type: 'failed', videoId, title, reason: String(error?.message ?? error), exitCode: null })
      return
    }

    // Without yt-dlp there is nothing to run, and without ffmpeg or Deno a
    // YouTube download comes out at low quality or not at all. Either way
    // the remedy is an install, not a retry, so nothing is spawned.
    const missing = TOOLS.filter(tool => !tools[tool].found)
    if (missing.length > 0) {
      running.delete(videoId)
      report({ type: 'tools-missing', videoId, title, missing })
      return
    }

    const executable = tools['yt-dlp'].path

    run({ videoId, title, executable, args, folder }, report)
  }

  /**
   * yt-dlp's own defaults, plus only what FreeTube needs, then the user's own
   * arguments, then the end-of-options marker and the URL.
   *
   * @param {{ videoId: string, folder: string, tools: import('./toolDetection').ToolStatuses }} options
   */
  async function buildArgs({ videoId, folder, tools }) {
    const args = [
      '--paths', `home:${folder}`,
      // Printed once the file is in its final place, so that the finished
      // outcome can say where it is. yt-dlp is quiet otherwise.
      '--print', 'after_move:filepath',
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
    if (await readSetting('useProxy')) {
      const protocol = await readSetting('proxyProtocol')
      const withCredentials = protocol === 'http' || protocol === 'https'

      args.push('--proxy', buildProxyUrl({
        protocol,
        hostname: await readSetting('proxyHostname'),
        port: await readSetting('proxyPort'),
        username: withCredentials ? await readSetting('proxyUsername') : '',
        password: withCredentials ? await readSetting('proxyPassword') : '',
      }))
    }

    const customArgs = parseCustomArgs(await readSetting('ytDlpCustomArgs'))

    args.push(...customArgs, '--', buildWatchUrl(videoId))

    return args
  }

  /**
   * @param {{ videoId: string, title: string, executable: string, args: string[], folder: string }} job
   * @param {(outcome: DownloadOutcome) => void} report
   */
  function run({ videoId, title, executable, args, folder }, report) {
    let child
    try {
      child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group on POSIX, so that stopping it on quit reaches
        // the ffmpeg it may have started as well.
        detached: platform !== 'win32',
        env: { ...env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch {
      running.delete(videoId)
      report({ type: 'not-found', videoId, title })
      return
    }

    running.set(videoId, child)

    let settled = false
    let lastStdoutLine = null
    let lastErrorLine = null

    readLines(child.stdout, (line) => {
      lastStdoutLine = line
    })

    readLines(child.stderr, (line) => {
      if (line.startsWith('ERROR:')) {
        lastErrorLine = line.slice('ERROR:'.length).trim()
      }
    })

    child.once('spawn', () => {
      report({ type: 'started', videoId, title })
    })

    child.once('error', () => {
      if (settled) {
        return
      }

      settled = true
      running.delete(videoId)
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

      // Stopped on quit: there is nobody left to tell
      if (stopped.has(child)) {
        stopped.delete(child)
        return
      }

      if (code === 0) {
        finished.set(videoId, { path: lastStdoutLine, folder })
        report({ type: 'finished', videoId, title, path: lastStdoutLine })
      } else {
        report({ type: 'failed', videoId, title, reason: lastErrorLine, exitCode: code })
      }
    })
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   */
  function terminate(child) {
    if (platform === 'win32' && child.pid) {
      // The whole tree, since yt-dlp may be running ffmpeg
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
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
   * Terminates every running download. yt-dlp keeps its partial files, so the
   * next attempt at the same video resumes rather than starting over.
   */
  function stopAll() {
    for (const child of running.values()) {
      if (child) {
        stopped.add(child)
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

  return { start, stopAll, isBusy, getFinished, detector }
}

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
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop()

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
