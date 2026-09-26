import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { chooseAsset, createToolInstaller, findChecksum, installCoverage } from './toolInstaller'
import { managedToolPath, TOOLS } from './toolDetection'
import { createFakeFetch, createMemoryFileSystem } from './testing/memoryFileSystem'
import { createFakeSpawn } from './testing/fakeProcess'

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

const FFMPEG_BUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest'
const DENO = 'https://github.com/denoland/deno/releases/latest/download'

// The extraction fixture happens to be laid out like the ffmpeg builds:
// a folder holding bin/ffmpeg and bin/ffprobe
const FFMPEG_TAR_XZ = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'archive.tar.xz')))
const DENO_BINARY = new TextEncoder().encode('\x7fELF deno')
const DENO_ZIP = zipSync({ deno: DENO_BINARY })

const FFMPEG_SUMS = `${sha256('win')}  ffmpeg-master-latest-win64-gpl.zip\n${sha256(FFMPEG_TAR_XZ)}  ffmpeg-master-latest-linux64-gpl.tar.xz\n`
const DENO_SUMS = `${sha256(DENO_ZIP)}  deno-x86_64-unknown-linux-gnu.zip\n`

const ALL_LINUX = {
  [`${NIGHTLY}/SHA2-256SUMS`]: null,
  [`${NIGHTLY}/yt-dlp_linux`]: YT_DLP_LINUX,
  [`${FFMPEG_BUILDS}/checksums.sha256`]: FFMPEG_SUMS,
  [`${FFMPEG_BUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`]: FFMPEG_TAR_XZ,
  [`${DENO}/deno-x86_64-unknown-linux-gnu.zip.sha256sum`]: DENO_SUMS,
  [`${DENO}/deno-x86_64-unknown-linux-gnu.zip`]: DENO_ZIP,
}

const SUMS = [
  `${sha256('zipimport')}  yt-dlp`,
  `${sha256(YT_DLP_EXE)}  yt-dlp.exe`,
  `${sha256(YT_DLP_LINUX)}  yt-dlp_linux`,
  `${sha256('aarch64')}  yt-dlp_linux_aarch64`,
  '',
].join('\n')

ALL_LINUX[`${NIGHTLY}/SHA2-256SUMS`] = SUMS

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
 * @param {string[]} [options.hang] URLs that never answer
 */
function setup({
  platform = 'linux',
  arch = 'x64',
  responses = { [`${NIGHTLY}/SHA2-256SUMS`]: SUMS, [`${NIGHTLY}/yt-dlp_linux`]: YT_DLP_LINUX, [`${NIGHTLY}/yt-dlp.exe`]: YT_DLP_EXE },
  elsewhere = ['ffmpeg', 'deno'],
  hang = [],
} = {}) {
  const fs = createMemoryFileSystem()
  const fetch = createFakeFetch(responses, hang)
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
    stallMs: 50,
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

    it('takes the ffmpeg builds from yt-dlp, a tar.xz on Linux and a zip on Windows, with ffprobe', () => {
      expect(chooseAsset('ffmpeg', 'linux', 'x64')).toEqual({
        url: `${FFMPEG_BUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
        kind: 'tar.xz',
        sums: { url: `${FFMPEG_BUILDS}/checksums.sha256`, name: 'ffmpeg-master-latest-linux64-gpl.tar.xz' },
        files: [{ entry: 'bin/ffmpeg', name: 'ffmpeg' }, { entry: 'bin/ffprobe', name: 'ffprobe' }],
      })
      expect(chooseAsset('ffmpeg', 'win32', 'x64')).toMatchObject({
        url: `${FFMPEG_BUILDS}/ffmpeg-master-latest-win64-gpl.zip`,
        kind: 'zip',
        files: [{ entry: 'bin/ffmpeg.exe', name: 'ffmpeg.exe' }, { entry: 'bin/ffprobe.exe', name: 'ffprobe.exe' }],
      })
    })

    it('takes Deno from its own releases, a zip with a sums file of its own on both', () => {
      expect(chooseAsset('deno', 'linux', 'x64')).toEqual({
        url: `${DENO}/deno-x86_64-unknown-linux-gnu.zip`,
        kind: 'zip',
        sums: { url: `${DENO}/deno-x86_64-unknown-linux-gnu.zip.sha256sum`, name: null },
        files: [{ entry: 'deno', name: 'deno' }],
      })
      expect(chooseAsset('deno', 'win32', 'x64')).toMatchObject({
        url: `${DENO}/deno-x86_64-pc-windows-msvc.zip`,
        sums: { name: null },
        files: [{ entry: 'deno.exe', name: 'deno.exe' }],
      })
    })

    it('covers all three on Windows x64 and Linux x64', () => {
      expect(installCoverage('linux', 'x64')).toEqual({ 'yt-dlp': true, ffmpeg: true, deno: true })
      expect(installCoverage('win32', 'x64')).toEqual({ 'yt-dlp': true, ffmpeg: true, deno: true })
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

    it('gives up on a request that never answers, rather than waiting forever', async () => {
      const { installer, fs } = setup({ hang: [`${NIGHTLY}/SHA2-256SUMS`] })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: false, error: 'failed', tool: 'yt-dlp' })
      expect(result.reason).toMatch(/no response from github\.com/i)
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
  })

  describe('installing from archives', () => {
    it('installs all three on a bare machine, each executable in the managed folder', async () => {
      const { installer, fs } = setup({ responses: ALL_LINUX, elsewhere: [] })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: true, installed: ['yt-dlp', 'ffmpeg', 'deno'] })
      expect([...fs.files.keys()].sort()).toEqual([
        `${MANAGED_DIR}/deno`,
        `${MANAGED_DIR}/ffmpeg`,
        `${MANAGED_DIR}/ffprobe`,
        `${MANAGED_DIR}/yt-dlp`,
      ])
      for (const file of fs.files.values()) {
        expect(file.mode & 0o111).toBe(0o111)
      }
      expect(new TextDecoder().decode(fs.files.get(`${MANAGED_DIR}/ffmpeg`).data)).toBe('stand-in for ffmpeg\n'.repeat(40))
      expect(fs.files.get(`${MANAGED_DIR}/deno`).data).toEqual(DENO_BINARY)
    })

    it('fetches only Deno when ffmpeg is on PATH', async () => {
      const { installer, fetch } = setup({ responses: ALL_LINUX, elsewhere: ['yt-dlp', 'ffmpeg'] })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: true, installed: ['deno'] })
      expect(fetch.requested).toEqual([
        `${DENO}/deno-x86_64-unknown-linux-gnu.zip.sha256sum`,
        `${DENO}/deno-x86_64-unknown-linux-gnu.zip`,
      ])
    })

    it('never opens an archive that fails its checksum, and leaves nothing behind', async () => {
      const { installer, fs, progress } = setup({
        responses: { ...ALL_LINUX, [`${FFMPEG_BUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`]: FFMPEG_TAR_XZ.slice(0, 100) },
        elsewhere: ['yt-dlp', 'deno'],
      })

      const result = await installer.install()

      expect(result).toMatchObject({ ok: false, error: 'failed', tool: 'ffmpeg' })
      expect(result.reason).toMatch(/checksum mismatch/i)
      expect(progress.map(p => p.stage)).not.toContain('extracting')
      expect(fs.files.size).toBe(0)
    })

    it('reports extracting for an archive', async () => {
      const { installer, progress } = setup({ responses: ALL_LINUX, elsewhere: ['yt-dlp', 'ffmpeg'] })

      await installer.install()

      expect(progress.map(p => p.stage)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'extracting', 'done']))
    })

    it('joins an install already running instead of starting another', async () => {
      const { installer, fetch } = setup()

      const [first, second] = await Promise.all([installer.install(), installer.install()])

      expect(first).toBe(second)
      expect(fetch.requested.filter(url => url.endsWith('/yt-dlp_linux'))).toHaveLength(1)
    })
  })

  describe('updating yt-dlp', () => {
    /**
     * @param {import('./testing/fakeProcess').Script | null} script what `yt-dlp -U` does; null for no yt-dlp at all
     * @param {string} [versionAfter]
     */
    function setupUpdate(script, versionAfter = '2026.09.16.232951') {
      let version = '2026.08.30.232658'
      const fake = createFakeSpawn(() => {
        if (script?.exitCode === 0 && /Updated/.test(script.stdout ?? '')) {
          version = versionAfter
        }
        return script
      })

      const found = () => ({ tool: 'yt-dlp', found: true, source: 'managed', path: `${MANAGED_DIR}/yt-dlp`, version })
      const absent = { tool: 'yt-dlp', found: false, source: null, path: null, version: null }

      const installer = createToolInstaller({
        fetch: createFakeFetch({}).fetch,
        fs: createMemoryFileSystem(),
        detector: {
          invalidate: () => {},
          detect: async () => ({ 'yt-dlp': script === null ? absent : found() }),
        },
        managedDir: MANAGED_DIR,
        platform: 'linux',
        arch: 'x64',
        spawn: fake.spawn,
      })

      return { installer, fake }
    }

    it('runs the self-update on the yt-dlp downloads use, and reports the new version', async () => {
      const { installer, fake } = setupUpdate({
        stdout: [
          'Current version: nightly@2026.08.30.232658 from yt-dlp/yt-dlp-nightly-builds',
          'Latest version: nightly@2026.09.16.232951 from yt-dlp/yt-dlp-nightly-builds',
          'Updating to nightly@2026.09.16.232951 from yt-dlp/yt-dlp-nightly-builds ...',
          'Updated yt-dlp to nightly@2026.09.16.232951 from yt-dlp/yt-dlp-nightly-builds',
          '',
        ].join('\n'),
        exitCode: 0,
      })

      expect(await installer.updateYtDlp()).toEqual({ status: 'updated', version: '2026.09.16.232951' })
      expect(fake.calls[0]).toMatchObject({ command: `${MANAGED_DIR}/yt-dlp`, args: ['-U'] })
    })

    it('says when it is already up to date', async () => {
      const { installer } = setupUpdate({
        stdout: 'Latest version: nightly@2026.08.30.232658 from yt-dlp/yt-dlp-nightly-builds\nyt-dlp is up to date (nightly@2026.08.30.232658 from yt-dlp/yt-dlp-nightly-builds)\n',
        exitCode: 0,
      })

      expect(await installer.updateYtDlp()).toEqual({ status: 'current', version: '2026.08.30.232658' })
    })

    it('recognises a yt-dlp that a package manager has to update', async () => {
      const { installer } = setupUpdate({
        stderr: 'ERROR: You installed yt-dlp with pip or using the wheel from PyPi; Use that to update\n',
        exitCode: 1,
      })

      expect(await installer.updateYtDlp()).toEqual({ status: 'package-manager' })
    })

    it('fails with yt-dlp\'s own reason otherwise', async () => {
      const { installer } = setupUpdate({
        stderr: 'ERROR: Unable to write to /usr/local/bin/yt-dlp; try running as administrator\n',
        exitCode: 1,
      })

      expect(await installer.updateYtDlp()).toEqual({
        status: 'failed',
        reason: 'Unable to write to /usr/local/bin/yt-dlp; try running as administrator',
      })
    })

    it('says there is nothing to update when there is no yt-dlp', async () => {
      const { installer, fake } = setupUpdate(null)

      expect(await installer.updateYtDlp()).toEqual({ status: 'missing' })
      expect(fake.calls).toHaveLength(0)
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
