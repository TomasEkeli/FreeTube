import path from 'node:path'

import { findOnPath } from './findOnPath'
import { runCapture } from './runCapture'

/**
 * Detection of the three tools a download needs: yt-dlp itself, ffmpeg to
 * merge audio and video, and Deno for the JavaScript yt-dlp must run for
 * YouTube. Shared by the download service, the installer and the settings.
 */

/** @typedef {'yt-dlp' | 'ffmpeg' | 'deno'} Tool */
/** @typedef {'picked' | 'managed' | 'path'} ToolSource */

/**
 * @typedef {object} ToolStatus
 * @property {Tool} tool
 * @property {boolean} found
 * @property {ToolSource | null} source
 * @property {string | null} path
 * @property {string | null} version
 */

/** @typedef {Record<Tool, ToolStatus>} ToolStatuses */

/** @type {Tool[]} */
export const TOOLS = ['yt-dlp', 'ffmpeg', 'deno']

/** @type {Record<Tool, string[]>} */
const VERSION_ARGS = {
  'yt-dlp': ['--version'],
  ffmpeg: ['-version'],
  deno: ['--version'],
}

// A successful detection is reused for this long by the download service, so
// that every press does not wait on three version probes. Anything missing is
// looked for afresh every time.
const CACHE_MS = 5 * 60 * 1000

/**
 * @param {string} managedDir
 * @param {Tool} tool
 * @param {string} platform
 */
export function managedToolPath(managedDir, tool, platform) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  return pathModule.join(managedDir, platform === 'win32' ? `${tool}.exe` : tool)
}

/**
 * The version from what a tool prints when asked for it.
 *
 * @param {Tool} tool
 * @param {string} output
 * @returns {string | null}
 */
export function parseVersion(tool, output) {
  const firstLine = output.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? ''

  switch (tool) {
    case 'yt-dlp':
      // "2026.09.16.232951"
      return /^(\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?)/.exec(firstLine)?.[1] ?? null
    case 'ffmpeg':
      // "ffmpeg version N-121067-g0e0ebfe5b9-20260925 Copyright (c) ..."
      return /^ffmpeg version (\S+)/.exec(firstLine)?.[1] ?? null
    case 'deno':
      // "deno 2.5.1 (stable, release, x86_64-unknown-linux-gnu)"
      return /^deno (\S+)/.exec(firstLine)?.[1] ?? null
  }
  return null
}

/**
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {(filePath: string) => Promise<boolean>} deps.isExecutableFile
 * @param {(id: 'ytDlpExecutablePath') => Promise<string>} deps.readSetting
 * @param {string} deps.managedDir the folder FreeTube installs the tools into
 * @param {string} deps.platform
 * @param {Record<string, string | undefined>} deps.env
 * @param {() => number} [deps.now]
 */
export function createToolDetector({ spawn, isExecutableFile, readSetting, managedDir, platform, env, now = Date.now }) {
  /** @type {{ at: number, picked: string, statuses: ToolStatuses } | null} */
  let cache = null

  /**
   * Candidates in order: the path the user picked (yt-dlp only), the managed
   * folder, then PATH. The first whose version command answers wins.
   *
   * @param {Tool} tool
   * @param {string} picked
   * @returns {Promise<ToolStatus>}
   */
  async function detectTool(tool, picked) {
    /** @type {{ source: ToolSource, path: string }[]} */
    const candidates = []

    if (tool === 'yt-dlp' && picked.length > 0) {
      candidates.push({ source: 'picked', path: picked })
    }

    candidates.push({ source: 'managed', path: managedToolPath(managedDir, tool, platform) })

    const onPath = await findOnPath(tool, { platform, env, isExecutableFile })
    if (onPath !== null) {
      candidates.push({ source: 'path', path: onPath })
    }

    for (const candidate of candidates) {
      if (!await isExecutableFile(candidate.path)) {
        continue
      }

      const { code, stdout } = await runCapture(spawn, candidate.path, VERSION_ARGS[tool])
      const version = code === 0 ? parseVersion(tool, stdout) : null

      if (version !== null) {
        return { tool, found: true, source: candidate.source, path: candidate.path, version }
      }
    }

    return { tool, found: false, source: null, path: null, version: null }
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.fresh] ignore a cached detection
   * @returns {Promise<ToolStatuses>}
   */
  async function detect({ fresh = false } = {}) {
    const storedPick = await readSetting('ytDlpExecutablePath')
    const picked = typeof storedPick === 'string' ? storedPick : ''

    // A different pick since is a different yt-dlp
    if (!fresh && cache !== null && cache.picked === picked && now() - cache.at < CACHE_MS) {
      return cache.statuses
    }

    const [ytDlp, ffmpeg, deno] = await Promise.all(TOOLS.map(tool => detectTool(tool, picked)))

    /** @type {ToolStatuses} */
    const statuses = { 'yt-dlp': ytDlp, ffmpeg, deno }

    cache = TOOLS.every(tool => statuses[tool].found) ? { at: now(), picked, statuses } : null

    return statuses
  }

  /**
   * After anything that changes which tools there are: an install, an update,
   * a newly picked executable.
   */
  function invalidate() {
    cache = null
  }

  return { detect, invalidate }
}
