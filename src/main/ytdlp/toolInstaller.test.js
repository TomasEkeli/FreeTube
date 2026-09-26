import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { chooseAsset, createToolInstaller, findChecksum, installCoverage } from './toolInstaller'
import { managedToolPath, TOOLS } from './toolDetection'
import { createFakeFetch, createMemoryFileSystem } from './testing/memoryFileSystem'

const MANAGED_DIR = '/data/FreeTube/bin'
const NIGHTLY = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download'

const YT_DLP_LINUX = new TextEncoder().encode('#!standalone yt-dlp for linux')
const YT_DLP_EXE = new TextEncoder().encode('MZ standalone yt-dlp for windows')

/**
 * @param {Uint8Array | string} data
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

const SUMS = [
  `${sha256('zipimport')}  yt-dlp`,
  `${sha256(YT_DLP_EXE)}  yt-dlp.exe`,
  `${sha256(YT_DLP_LINUX)}  yt-dlp_linux`,
  `${sha256('aarch64')}  yt-dlp_linux_aarch64`,
  '',
].join('\n')

/**
 * A detector that finds a tool when it is in the memory filesystem's managed
 * folder, or when it is listed as found elsewhere.
 *
 * @param {ReturnType<typeof createMemoryFileSystem>} fs
 * @param {string} platform
 * @param {string[]} elsewhere tools found on PATH
 */
function createFakeDetector(fs, platform, elsewhere) {
  let detections = 0

  return {
    get detections() { return detections },
    invalidate: () => {},
    detect: async () => {
      detections++
      return Object.fromEntries(TOOLS.map((tool) => {
        const managed = managedToolPath(MANAGED_DIR, tool, platform)
        if (fs.files.has(managed)) {
          return [tool, { tool, found: true, source: 'managed', path: managed, version: '1' }]
        }
        if (elsewhere.includes(tool)) {
          return [tool, { tool, found: true, source: 'path', path: `/usr/bin/${tool}`, version: '1' }]
        }
        return [tool, { tool, found: false, source: null, path: null, version: null }]
      }))
    },
  }
}

/**
 * @param {object} options
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {Record<string, string | Uint8Array>} [options.responses]
 * @param {string[]} [options.elsewhere]
 */
function setup({
  platform = 'linux',
  arch = 'x64',
  responses = { [`${NIGHTLY}/SHA2-256SUMS`]: SUMS, [`${NIGHTLY}/yt-dlp_linux`]: YT_DLP_LINUX, [`${NIGHTLY}/yt-dlp.exe`]: YT_DLP_EXE },
  elsewhere = ['ffmpeg', 'deno'],
} = {}) {
  const fs = createMemoryFileSystem()
  const fetch = createFakeFetch(responses)
  const detector = createFakeDetector(fs, platform, elsewhere)
  const progress = []

  const installer = createToolInstaller({
    fetch: fetch.fetch,
    fs,
    detector,
    managedDir: MANAGED_DIR,
    platform,
    arch,
    onProgress: p => progress.push(p),
  })

  return { installer, fs, fetch, detector, progress }
}

describe('tool installer', () => {
  describe('asset choice', () => {
    it('takes the standalone yt-dlp_linux on Linux x64, never the zipimport build', () => {
      expect(chooseAsset('yt-dlp', 'linux', 'x64')).toMatchObject({
        url: `${NIGHTLY}/yt-dlp_linux`,
        kind: 'binary',
        sums: { url: `${NIGHTLY}/SHA2-256SUMS`, name: 'yt-dlp_linux' },
      })
    })

    it('takes yt-dlp.exe on Windows x64', () => {
      expect(chooseAsset('yt-dlp', 'win32', 'x64')).toMatchObject({
        url: `${NIGHTLY}/yt-dlp.exe`,
        sums: { name: 'yt-dlp.exe' },
      })
    })

    it('has nothing for platforms it does not cover', () => {
      expect(chooseAsset('yt-dlp', 'darwin', 'arm64')).toBeNull()
      expect(chooseAsset('yt-dlp', 'linux', 'arm64')).toBeNull()
      expect(installCoverage('darwin', 'x64')).toEqual({ 'yt-dlp': false, ffmpeg: false, deno: false })
    })
  })

  describe('installing yt-dlp', () => {
    it('places a verified yt-dlp in the managed folder with its executable bit', async () => {
      const { installer, fs } = setup()

      const result = await installer.install()

      expect(result).toMatchObject({ ok: true, installed: ['yt-dlp'] })
      expect(result.statuses['yt-dlp']).toMatchObject({ found: true, source: 'managed' })

      const placed = fs.files.get(`${MANAGED_DIR}/yt-dlp`)
      expect(placed.data).toEqual(YT_DLP_LINUX)
      expect(placed.mode & 0o111).toBe(0o111)
      // and nothing left over beside it
      expect([...fs.files.keys()]).toEqual([`${MANAGED_DIR}/yt-dlp`])
    })

    it('names it yt-dlp.exe on Windows', async () => {
      const { installer, fs } = setup({ platform: 'win32' })

      await installer.install()

      expect(fs.files.get('\\data\\FreeTube\\bin\\yt-dlp.exe')?.data).toEqual(YT_DLP_EXE)
    })

    it('aborts on a checksum mismatch and leaves nothing executable behind', async () => {
      const { installer, fs } = setup({
        responses: {
          [`${NIGHTLY}/SHA2-256SUMS`]: SUMS,
          [`${NIGHTLY}/yt-dlp_linux`]: new TextEncoder().encode('#!tampered'),
        },
      })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: false, error: 'failed', tool: 'yt-dlp' })
      expect(result.reason).toMatch(/checksum mismatch/i)
      expect(fs.files.size).toBe(0)
    })

    it('fails cleanly when the download itself fails', async () => {
      const { installer, fs } = setup({ responses: { [`${NIGHTLY}/SHA2-256SUMS`]: SUMS } })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: false, error: 'failed', tool: 'yt-dlp' })
      expect(result.reason).toMatch(/404/)
      expect(fs.files.size).toBe(0)
    })

    it('fetches nothing when yt-dlp is already there', async () => {
      const { installer, fetch } = setup({ elsewhere: ['yt-dlp', 'ffmpeg', 'deno'] })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: true, installed: [] })
      expect(fetch.requested).toEqual([])
    })

    it('reports progress per tool', async () => {
      const { installer, progress } = setup()

      await installer.install()

      expect(progress[0]).toMatchObject({ tool: 'yt-dlp', stage: 'downloading' })
      expect(progress.at(-1)).toEqual({ tool: 'yt-dlp', stage: 'done' })
      expect(progress.map(p => p.stage)).toContain('verifying')
    })

    it('says it cannot install on a platform it does not cover', async () => {
      const { installer, fetch } = setup({ platform: 'darwin', arch: 'arm64' })

      const result = await installer.install()

      expect(result).toEqual({ ok: false, error: 'unsupported', notCovered: ['yt-dlp'] })
      expect(fetch.requested).toEqual([])
    })

    it('joins an install already running instead of starting another', async () => {
      const { installer, fetch } = setup()

      const [first, second] = await Promise.all([installer.install(), installer.install()])

      expect(first).toBe(second)
      expect(fetch.requested.filter(url => url.endsWith('/yt-dlp_linux'))).toHaveLength(1)
    })
  })

  describe('checksum files', () => {
    it('finds the line for the named file', () => {
      expect(findChecksum(SUMS, 'yt-dlp_linux')).toBe(sha256(YT_DLP_LINUX))
      expect(findChecksum(SUMS, 'yt-dlp_macos')).toBeNull()
    })

    it('reads a file that sums one asset, in either format Deno publishes', () => {
      const hash = 'c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490'
      expect(findChecksum(`${hash}  deno-x86_64-unknown-linux-gnu.zip\n`, null)).toBe(hash)
      expect(findChecksum(`\r\nAlgorithm : SHA256\r\nHash      : ${hash.toUpperCase()}\r\nPath      : C:\\a\\deno.zip\r\n`, null)).toBe(hash)
    })
  })
})
