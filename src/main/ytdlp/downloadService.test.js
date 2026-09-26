import { describe, expect, it } from 'vitest'

import { createDownloadService } from './downloadService'
import { SETTING_DEFAULTS } from './settings'
import { createFakeSpawn, until } from './testing/fakeProcess'

const VIDEO_ID = 'dQw4w9WgXcQ'
const REQUEST = { videoId: VIDEO_ID, title: 'A video' }

const MANAGED_DIR = '/data/FreeTube/bin'
const ON_PATH = ['/usr/bin/yt-dlp', '/usr/bin/ffmpeg', '/usr/bin/deno']

const VERSION_OUTPUT = {
  'yt-dlp': '2026.09.16.232951\n',
  ffmpeg: 'ffmpeg version N-121067-20260925 Copyright (c) 2000-2026 the FFmpeg developers\n',
  deno: 'deno 2.5.1 (stable, release, x86_64-unknown-linux-gnu)\n',
}

/**
 * @param {string[]} args
 */
function isVersionProbe(args) {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-version')
}

/**
 * @param {object} options
 * @param {(command: string, args: string[]) => import('./testing/fakeProcess').Script} [options.respond] for the download itself
 * @param {string[]} [options.executables] files that exist and can be run
 * @param {string[]} [options.broken] files that exist but do not answer their version probe
 * @param {Partial<typeof SETTING_DEFAULTS>} [options.settings]
 */
function setup({ respond = () => ({}), executables = ON_PATH, broken = [], settings = {} } = {}) {
  const fake = createFakeSpawn((command, args) => {
    if (isVersionProbe(args)) {
      if (broken.includes(command)) {
        return { exitCode: 1 }
      }
      const tool = command.split('/').at(-1)
      return { stdout: VERSION_OUTPUT[tool], exitCode: 0 }
    }
    return respond(command, args)
  })
  const outcomes = []
  const stored = { ...SETTING_DEFAULTS, ytDlpEnabled: true, ...settings }

  const service = createDownloadService({
    spawn: fake.spawn,
    readSetting: async id => stored[id],
    isExecutableFile: async filePath => executables.includes(filePath),
    managedDir: MANAGED_DIR,
    defaultDownloadFolder: () => '/home/viewer/Downloads',
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
  })

  const report = outcome => outcomes.push(outcome)
  const downloads = () => fake.calls.filter(call => call.command !== 'taskkill' && !isVersionProbe(call.args))

  return { service, fake, outcomes, report, downloads }
}

describe('download service', () => {
  describe('the command', () => {
    it('downloads into the Downloads folder, with the watch URL after the end-of-options marker', async () => {
      const { service, report, downloads, outcomes } = setup()

      await service.start(REQUEST, report)
      await until(() => outcomes.some(o => o.type === 'finished'))

      const { command, args } = downloads()[0]
      expect(command).toBe('/usr/bin/yt-dlp')

      const home = args.indexOf('--paths')
      expect(args[home + 1]).toBe('home:/home/viewer/Downloads')

      const marker = args.indexOf('--')
      expect(marker).toBe(args.length - 2)
      expect(args.at(-1)).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`)
    })

    it('asks yt-dlp to print the final file path', async () => {
      const { service, report, downloads, outcomes } = setup()

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      const print = args.indexOf('--print')
      expect(args[print + 1]).toBe('after_move:filepath')
    })

    it('downloads into the chosen folder when there is one', async () => {
      const { service, report, downloads, outcomes } = setup({ settings: { ytDlpDownloadFolder: '/mnt/videos' } })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--paths') + 1]).toBe('home:/mnt/videos')
    })

    it('puts the custom arguments after its own and before the end-of-options marker', async () => {
      const { service, report, downloads, outcomes } = setup({
        settings: { ytDlpCustomArgs: JSON.stringify(['-x', '--audio-format', 'opus']) },
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      const custom = args.indexOf('-x')
      expect(args.slice(custom, custom + 3)).toEqual(['-x', '--audio-format', 'opus'])
      expect(custom).toBeGreaterThan(args.indexOf('--print'))
      expect(args.indexOf('--')).toBe(custom + 3)
    })

    it('ignores custom arguments that are not a JSON array of strings', async () => {
      const { service, report, downloads, outcomes } = setup({ settings: { ytDlpCustomArgs: '{"not": "a list"}' } })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args.slice(-2)).toEqual(['--', `https://www.youtube.com/watch?v=${VIDEO_ID}`])
    })

    it('passes the proxy when FreeTube\'s proxy is on', async () => {
      const { service, report, downloads, outcomes } = setup({
        settings: { useProxy: true, proxyProtocol: 'socks5', proxyHostname: '10.0.0.2', proxyPort: '1080' },
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--proxy') + 1]).toBe('socks5://10.0.0.2:1080')
      expect(args.indexOf('--proxy')).toBeLessThan(args.indexOf('--'))
    })

    it('passes the proxy credentials for an HTTP proxy', async () => {
      const { service, report, downloads, outcomes } = setup({
        settings: {
          useProxy: true,
          proxyProtocol: 'http',
          proxyHostname: 'proxy.lan',
          proxyPort: '3128',
          proxyUsername: 'me',
          proxyPassword: 'p@ss:word',
        },
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--proxy') + 1]).toBe('http://me:p%40ss%3Aword@proxy.lan:3128')
    })

    it('passes no proxy when FreeTube\'s proxy is off', async () => {
      const { service, report, downloads, outcomes } = setup({
        settings: { useProxy: false, proxyHostname: '10.0.0.2' },
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      expect(downloads()[0].args).not.toContain('--proxy')
    })

    it('never spawns through a shell', async () => {
      const { service, report, downloads, outcomes } = setup()

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      expect(downloads()[0].options.shell).toBeFalsy()
    })
  })

  describe('outcomes', () => {
    it('reports started, then finished with the printed path', async () => {
      const { service, report, outcomes } = setup({
        respond: () => ({ stdout: '/home/viewer/Downloads/A video [dQw4w9WgXcQ].webm\n', exitCode: 0 }),
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 2)

      expect(outcomes).toEqual([
        { type: 'started', videoId: VIDEO_ID, title: 'A video' },
        { type: 'finished', videoId: VIDEO_ID, title: 'A video', path: '/home/viewer/Downloads/A video [dQw4w9WgXcQ].webm' },
      ])
      expect(service.getFinished(VIDEO_ID)).toEqual({
        path: '/home/viewer/Downloads/A video [dQw4w9WgXcQ].webm',
        folder: '/home/viewer/Downloads',
      })
    })

    it('reports failed with the last ERROR: line', async () => {
      const { service, report, outcomes } = setup({
        respond: () => ({
          stderr: [
            'WARNING: something harmless',
            'ERROR: [youtube] dQw4w9WgXcQ: first problem',
            'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable',
            '',
          ].join('\n'),
          exitCode: 1,
        }),
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 2)

      expect(outcomes[1]).toEqual({
        type: 'failed',
        videoId: VIDEO_ID,
        title: 'A video',
        reason: '[youtube] dQw4w9WgXcQ: Video unavailable',
        exitCode: 1,
      })
    })

    it('reports failed with the exit code when there is no ERROR: line', async () => {
      const { service, report, outcomes } = setup({
        respond: () => ({ stderr: 'Traceback (most recent call last):\n', exitCode: 2 }),
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 2)

      expect(outcomes[1]).toEqual({ type: 'failed', videoId: VIDEO_ID, title: 'A video', reason: null, exitCode: 2 })
    })

    it('reports not found when the executable cannot be started', async () => {
      const error = Object.assign(new Error('spawn /usr/bin/yt-dlp ENOENT'), { code: 'ENOENT' })
      const { service, report, outcomes } = setup({ respond: () => ({ error }) })

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 1)
      // Give a stray 'close' the chance to report twice
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(outcomes).toEqual([{ type: 'not-found', videoId: VIDEO_ID, title: 'A video' }])
    })

    it('reports tools missing, naming it, and spawns nothing, when there is no yt-dlp anywhere', async () => {
      const { service, report, outcomes, downloads } = setup({ executables: ['/usr/bin/ffmpeg', '/usr/bin/deno'] })

      await service.start(REQUEST, report)

      expect(outcomes).toEqual([{ type: 'tools-missing', videoId: VIDEO_ID, title: 'A video', missing: ['yt-dlp'] }])
      expect(downloads()).toHaveLength(0)
    })

    it('reports tools missing when ffmpeg or Deno is absent, naming them, and spawns nothing', async () => {
      const { service, report, outcomes, downloads } = setup({ executables: ['/usr/bin/yt-dlp'] })

      await service.start(REQUEST, report)

      expect(outcomes).toEqual([{ type: 'tools-missing', videoId: VIDEO_ID, title: 'A video', missing: ['ffmpeg', 'deno'] }])
      expect(downloads()).toHaveLength(0)
    })

    it('turns away a second start for a video that is still downloading, spawning nothing', async () => {
      const { service, report, outcomes, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 1)
      await service.start(REQUEST, report)

      expect(outcomes.map(o => o.type)).toEqual(['started', 'already-running'])
      expect(downloads()).toHaveLength(1)
      expect(service.isBusy()).toBe(true)
    })

    it('turns away a second start that arrives before the first has spawned', async () => {
      const { service, report, outcomes, downloads } = setup({ respond: () => ({ hang: true }) })

      await Promise.all([service.start(REQUEST, report), service.start(REQUEST, report)])
      await until(() => outcomes.length === 2)

      expect(outcomes.map(o => o.type).sort()).toEqual(['already-running', 'started'])
      expect(downloads()).toHaveLength(1)
    })

    it('downloads different videos side by side', async () => {
      const { service, report, outcomes, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await service.start({ videoId: 'aaaaaaaaaaa', title: 'Another' }, report)
      await until(() => outcomes.length === 2)

      expect(outcomes.map(o => o.type)).toEqual(['started', 'started'])
      expect(downloads()).toHaveLength(2)
    })

    it('allows the same video again once the first download has ended', async () => {
      const { service, report, outcomes, downloads } = setup()

      await service.start(REQUEST, report)
      await until(() => outcomes.length === 2)
      await service.start(REQUEST, report)
      await until(() => outcomes.length === 4)

      expect(downloads()).toHaveLength(2)
      expect(service.isBusy()).toBe(false)
    })
  })

  describe('tools from the managed folder', () => {
    it('points yt-dlp at the managed ffmpeg and Deno when those are the ones found', async () => {
      const { service, report, downloads, outcomes } = setup({
        executables: ['/usr/bin/yt-dlp', `${MANAGED_DIR}/ffmpeg`, `${MANAGED_DIR}/deno`],
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe(MANAGED_DIR)
      expect(args[args.indexOf('--js-runtimes') + 1]).toBe(`deno:${MANAGED_DIR}/deno`)
      expect(args.indexOf('--js-runtimes')).toBeLessThan(args.indexOf('--'))
    })

    it('adds neither when ffmpeg and Deno are on PATH, where yt-dlp finds them itself', async () => {
      const { service, report, downloads, outcomes } = setup({
        executables: [`${MANAGED_DIR}/yt-dlp`, '/usr/bin/ffmpeg', '/usr/bin/deno'],
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args).not.toContain('--ffmpeg-location')
      expect(args).not.toContain('--js-runtimes')
    })

    it('adds only the one that is managed', async () => {
      const { service, report, downloads, outcomes } = setup({
        executables: ['/usr/bin/yt-dlp', '/usr/bin/ffmpeg', `${MANAGED_DIR}/deno`],
      })

      await service.start(REQUEST, report)
      await until(() => outcomes.length >= 2)

      const { args } = downloads()[0]
      expect(args).not.toContain('--ffmpeg-location')
      expect(args).toContain('--js-runtimes')
    })
  })

  describe('which yt-dlp is run', () => {
    const picked = '/opt/custom/yt-dlp'
    const managed = `${MANAGED_DIR}/yt-dlp`

    /**
     * @param {Parameters<typeof setup>[0]} options
     */
    async function spawnedYtDlp(options) {
      const { service, report, outcomes, downloads } = setup(options)
      await service.start(REQUEST, report)
      await until(() => outcomes.some(o => o.type !== 'started'))
      return downloads()[0]?.command
    }

    it('runs the picked executable ahead of the managed one and PATH', async () => {
      expect(await spawnedYtDlp({
        executables: [picked, managed, ...ON_PATH],
        settings: { ytDlpExecutablePath: picked },
      })).toBe(picked)
    })

    it('runs the managed one ahead of PATH when nothing is picked', async () => {
      expect(await spawnedYtDlp({ executables: [managed, ...ON_PATH] })).toBe(managed)
    })

    it('runs the one on PATH, by its full path, when there is nothing else', async () => {
      expect(await spawnedYtDlp({ executables: ON_PATH })).toBe('/usr/bin/yt-dlp')
    })

    it('passes over a candidate that does not answer its version probe', async () => {
      expect(await spawnedYtDlp({
        executables: [picked, managed, ...ON_PATH],
        broken: [picked, managed],
        settings: { ytDlpExecutablePath: picked },
      })).toBe('/usr/bin/yt-dlp')
    })
  })

  describe('quitting', () => {
    it('terminates the running children, and reports nothing for them', async () => {
      const { service, report, outcomes, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await service.start({ videoId: 'aaaaaaaaaaa', title: 'Another' }, report)
      await until(() => outcomes.length === 2)

      service.stopAll()

      for (const { child } of downloads()) {
        expect(child.killed).toBe(true)
      }

      await until(() => !service.isBusy())
      expect(outcomes.map(o => o.type)).toEqual(['started', 'started'])
    })
  })
})
