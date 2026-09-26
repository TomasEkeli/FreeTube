import { describe, expect, it } from 'vitest'

import { createDownloadService } from './downloadService'
import { SETTING_DEFAULTS } from './settings'
import { createFakeSpawn, until } from './testing/fakeProcess'

const VIDEO_ID = 'dQw4w9WgXcQ'
const REQUEST = { videoId: VIDEO_ID, title: 'A video' }
const DOWNLOADS = '/home/viewer/Downloads'
const DEST = `${DOWNLOADS}/A video [dQw4w9WgXcQ].webm`

const MANAGED_DIR = '/data/FreeTube/bin'
const ON_PATH = ['/usr/bin/yt-dlp', '/usr/bin/ffmpeg', '/usr/bin/deno']

const VERSION_OUTPUT = {
  'yt-dlp': '2026.09.16.232951\n',
  ffmpeg: 'ffmpeg version N-121067-20260925 Copyright (c) 2000-2026 the FFmpeg developers\n',
  deno: 'deno 2.5.1 (stable, release, x86_64-unknown-linux-gnu)\n',
}

// What yt-dlp writes, given FreeTube's progress arguments, for a video
// downloaded as separate video and audio and merged
const DEST_LINE = `[freetube]dest 401+251 ${DEST}`
const VIDEO_PROGRESS = [
  '[freetube]progress downloading 1024 1000000 NA 50000 20 401 av01.0.12M.08 none',
  '[freetube]progress finished 1000000 1000000 NA NA NA 401 av01.0.12M.08 none',
]
const AUDIO_PROGRESS = [
  '[freetube]progress downloading 1024 200000 NA 50000 4 251 none opus',
  '[freetube]progress finished 200000 200000 NA NA NA 251 none opus',
]
const DONE_LINE = `[freetube]done ${DEST}`

const SUCCESS = {
  stdout: [DEST_LINE, ...VIDEO_PROGRESS, ...AUDIO_PROGRESS, DONE_LINE, ''].join('\n'),
  stderr: '[freetube]post started Merger\n[freetube]post finished Merger\n',
  exitCode: 0,
}

const TERMINAL = ['finished', 'failed', 'cancelled', 'not-found', 'tools-missing']

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
 * @param {Record<string, string[]>} [options.directories] what each folder holds
 */
function setup({ respond = () => SUCCESS, executables = ON_PATH, broken = [], settings = {}, directories = {} } = {}) {
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
  let time = 0

  const service = createDownloadService({
    spawn: fake.spawn,
    readSetting: async id => stored[id],
    isExecutableFile: async filePath => executables.includes(filePath),
    listDirectory: async dir => directories[dir] ?? [],
    managedDir: MANAGED_DIR,
    defaultDownloadFolder: () => DOWNLOADS,
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    now: () => time,
    startedFallbackMs: 30,
  })

  const report = outcome => outcomes.push(outcome)
  const downloads = () => fake.calls.filter(call => !call.command.endsWith('taskkill.exe') && !isVersionProbe(call.args))
  /** Everything but progress */
  const ours = () => outcomes.filter(o => o.type !== 'progress')
  const progress = () => outcomes.filter(o => o.type === 'progress').map(o => o.download)
  const ended = () => outcomes.some(o => TERMINAL.includes(o.type))

  return { service, fake, outcomes, report, downloads, ours, progress, ended, advance: (ms) => { time += ms } }
}

describe('download service', () => {
  describe('the command', () => {
    it('downloads into the Downloads folder, with the watch URL after the end-of-options marker', async () => {
      const { service, report, downloads, ended } = setup()

      await service.start(REQUEST, report)
      await until(ended)

      const { command, args } = downloads()[0]
      expect(command).toBe('/usr/bin/yt-dlp')

      const home = args.indexOf('--paths')
      expect(args[home + 1]).toBe('home:/home/viewer/Downloads')

      const marker = args.indexOf('--')
      expect(marker).toBe(args.length - 2)
      expect(args.at(-1)).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`)
    })

    it('asks yt-dlp for the destination up front, progress as it goes, and the final path at the end', async () => {
      const { service, report, downloads, ended } = setup()

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args).toContain('before_dl:[freetube]dest %(format_id)s %(filename)s')
      expect(args).toContain('after_move:[freetube]done %(filepath)s')
      expect(args).toContain('--progress')
      expect(args).toContain('--newline')
      expect(args.filter(arg => arg === '--progress-template')).toHaveLength(2)
    })

    it('downloads into the chosen folder when there is one', async () => {
      const { service, report, downloads, ended } = setup({ settings: { ytDlpDownloadFolder: '/mnt/videos' } })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--paths') + 1]).toBe('home:/mnt/videos')
    })

    it('puts the custom arguments after its own, progress included, and before the end-of-options marker', async () => {
      const { service, report, downloads, ended } = setup({
        settings: { ytDlpCustomArgs: JSON.stringify(['-x', '--audio-format', 'opus']) },
      })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      const custom = args.indexOf('-x')
      expect(args.slice(custom, custom + 3)).toEqual(['-x', '--audio-format', 'opus'])
      expect(custom).toBeGreaterThan(args.lastIndexOf('--progress-template'))
      expect(args.indexOf('--')).toBe(custom + 3)
    })

    it('ignores custom arguments that are not a JSON array of strings', async () => {
      const { service, report, downloads, ended } = setup({ settings: { ytDlpCustomArgs: '{"not": "a list"}' } })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args.slice(-2)).toEqual(['--', `https://www.youtube.com/watch?v=${VIDEO_ID}`])
    })

    it('passes the proxy when FreeTube\'s proxy is on', async () => {
      const { service, report, downloads, ended } = setup({
        settings: { useProxy: true, proxyProtocol: 'socks5', proxyHostname: '10.0.0.2', proxyPort: '1080' },
      })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      // socks5h, so that yt-dlp looks names up through the proxy, not beside it
      expect(args[args.indexOf('--proxy') + 1]).toBe('socks5h://10.0.0.2:1080')
      expect(args.indexOf('--proxy')).toBeLessThan(args.indexOf('--'))
    })

    it('passes a socks4 proxy as socks4a, for the same reason', async () => {
      const { service, report, downloads, ended } = setup({
        settings: { useProxy: true, proxyProtocol: 'socks4', proxyHostname: '10.0.0.2', proxyPort: '1080' },
      })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--proxy') + 1]).toBe('socks4a://10.0.0.2:1080')
    })

    it('passes an HTTP proxy with credentials through the environment, keeping the password off the command line', async () => {
      const { service, report, downloads, ended } = setup({
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
      await until(ended)

      const { args, options } = downloads()[0]
      expect(args).not.toContain('--proxy')
      expect(args.join(' ')).not.toContain('p%40ss')
      expect(options.env.HTTPS_PROXY).toBe('http://me:p%40ss%3Aword@proxy.lan:3128')
      expect(options.env.HTTP_PROXY).toBe('http://me:p%40ss%3Aword@proxy.lan:3128')
    })

    it('passes no proxy when FreeTube\'s proxy is off', async () => {
      const { service, report, downloads, ended } = setup({
        settings: { useProxy: false, proxyHostname: '10.0.0.2' },
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(downloads()[0].args).not.toContain('--proxy')
    })

    it('never spawns through a shell', async () => {
      const { service, report, downloads, ended } = setup()

      await service.start(REQUEST, report)
      await until(ended)

      expect(downloads()[0].options.shell).toBeFalsy()
    })
  })

  describe('outcomes', () => {
    it('reports started with the destination, then finished with the final path', async () => {
      const { service, report, ours, ended } = setup()

      await service.start(REQUEST, report)
      await until(ended)

      expect(ours().map(o => o.type)).toEqual(['started', 'finished'])
      expect(ours()[0].download).toMatchObject({ destination: DEST, folder: DOWNLOADS, resuming: false, parts: 2 })
      expect(ours()[1]).toMatchObject({ type: 'finished', videoId: VIDEO_ID, title: 'A video', path: DEST })
      expect(ours()[1].download).toMatchObject({ status: 'finished', destination: DEST })
      expect(service.getFinished(VIDEO_ID)).toEqual({ path: DEST, folder: DOWNLOADS })
    })

    it('reports started without a destination when yt-dlp does not say, after a few seconds', async () => {
      const { service, report, ours } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await until(() => ours().length === 1)

      expect(ours()[0]).toMatchObject({ type: 'started', download: { destination: null, folder: DOWNLOADS } })
    })

    it('reports failed with the last ERROR: line', async () => {
      const { service, report, ours, ended } = setup({
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
      await until(ended)

      expect(ours()).toHaveLength(1)
      expect(ours()[0]).toMatchObject({
        type: 'failed',
        videoId: VIDEO_ID,
        title: 'A video',
        reason: '[youtube] dQw4w9WgXcQ: Video unavailable',
        exitCode: 1,
      })
      expect(ours()[0].download.status).toBe('failed')
    })

    it('reports failed with the exit code when there is no ERROR: line', async () => {
      const { service, report, ours, ended } = setup({
        respond: () => ({ stderr: 'Traceback (most recent call last):\n', exitCode: 2 }),
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(ours()[0]).toMatchObject({ type: 'failed', reason: null, exitCode: 2 })
    })

    it('reports not found when the executable cannot be started', async () => {
      const error = Object.assign(new Error('spawn /usr/bin/yt-dlp ENOENT'), { code: 'ENOENT' })
      const { service, report, ours, ended } = setup({ respond: () => ({ error }) })

      await service.start(REQUEST, report)
      await until(ended)
      // Give a stray 'close' the chance to report twice
      await new Promise(resolve => setTimeout(resolve, 40))

      expect(ours()).toEqual([{ type: 'not-found', videoId: VIDEO_ID, title: 'A video' }])
    })

    it('reports tools missing, naming it, and spawns nothing, when there is no yt-dlp anywhere', async () => {
      const { service, report, ours, downloads } = setup({ executables: ['/usr/bin/ffmpeg', '/usr/bin/deno'] })

      await service.start(REQUEST, report)

      expect(ours()).toEqual([{ type: 'tools-missing', videoId: VIDEO_ID, title: 'A video', missing: ['yt-dlp'] }])
      expect(downloads()).toHaveLength(0)
      expect(service.list().downloads).toEqual([])
    })

    it('reports tools missing when ffmpeg or Deno is absent, naming them, and spawns nothing', async () => {
      const { service, report, ours, downloads } = setup({ executables: ['/usr/bin/yt-dlp'] })

      await service.start(REQUEST, report)

      expect(ours()).toEqual([{ type: 'tools-missing', videoId: VIDEO_ID, title: 'A video', missing: ['ffmpeg', 'deno'] }])
      expect(downloads()).toHaveLength(0)
    })

    it('turns away a second start for a video that is still downloading, spawning nothing', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await until(() => downloads().length === 1)
      await service.start(REQUEST, report)

      expect(ours().map(o => o.type)).toContain('already-running')
      expect(downloads()).toHaveLength(1)
      expect(service.isBusy()).toBe(true)
    })

    it('turns away a second start that arrives before the first has spawned', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      await Promise.all([service.start(REQUEST, report), service.start(REQUEST, report)])
      await until(() => ours().length === 2)

      expect(ours().map(o => o.type).sort()).toEqual(['already-running', 'started'])
      expect(downloads()).toHaveLength(1)
    })

    it('downloads different videos side by side', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await service.start({ videoId: 'aaaaaaaaaaa', title: 'Another' }, report)
      await until(() => ours().length === 2)

      expect(ours().map(o => o.type)).toEqual(['started', 'started'])
      expect(downloads()).toHaveLength(2)
    })

    it('allows the same video again once the first download has ended', async () => {
      const { service, report, outcomes, downloads } = setup()

      await service.start(REQUEST, report)
      await until(() => outcomes.filter(o => o.type === 'finished').length === 1)
      await service.start(REQUEST, report)
      await until(() => outcomes.filter(o => o.type === 'finished').length === 2)

      expect(downloads()).toHaveLength(2)
      expect(service.isBusy()).toBe(false)
    })
  })

  describe('progress', () => {
    it('reports preparing as soon as the download is accepted', async () => {
      const { service, report, progress } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)

      expect(progress()[0]).toMatchObject({ videoId: VIDEO_ID, status: 'preparing', folder: DOWNLOADS, destination: null })
    })

    it('follows each part, video then audio, with bytes, speed and time left', async () => {
      const { service, report, progress, downloads } = setup({
        respond: () => ({ stdout: [DEST_LINE, VIDEO_PROGRESS[0], ''].join('\n'), hang: true }),
      })

      await service.start(REQUEST, report)
      await until(() => progress().some(p => p.status === 'downloading'))

      expect(progress().find(p => p.status === 'downloading')).toMatchObject({
        part: 1,
        parts: 2,
        partKind: 'video',
        downloadedBytes: 1024,
        totalBytes: 1000000,
        speed: 50000,
        eta: 20,
      })

      downloads()[0].child.stdout.write(`${VIDEO_PROGRESS[1]}\n${AUDIO_PROGRESS[0]}\n`)
      await until(() => progress().some(p => p.part === 2))

      expect(progress().find(p => p.part === 2)).toMatchObject({ partKind: 'audio', parts: 2, totalBytes: 200000 })
    })

    it('reports merging as its own stage', async () => {
      const { service, report, progress, downloads } = setup({
        respond: () => ({ stdout: [DEST_LINE, ...VIDEO_PROGRESS, ...AUDIO_PROGRESS, ''].join('\n'), hang: true }),
      })

      await service.start(REQUEST, report)
      await until(() => progress().some(p => p.part === 2))

      downloads()[0].child.stderr.write('[freetube]post started Merger\n')
      await until(() => progress().some(p => p.status === 'merging'))

      expect(progress().at(-1)).toMatchObject({ status: 'merging', speed: null, eta: null })
    })

    it('sends progress about once a second, and changes of part straight away', async () => {
      const { service, report, progress, downloads, advance } = setup({
        respond: () => ({ stdout: [DEST_LINE, VIDEO_PROGRESS[0], ''].join('\n'), hang: true }),
      })

      await service.start(REQUEST, report)
      await until(() => progress().some(p => p.status === 'downloading'))
      const before = progress().length

      const child = downloads()[0].child
      child.stdout.write('[freetube]progress downloading 2048 1000000 NA 50000 19 401 av01 none\n')
      child.stdout.write('[freetube]progress downloading 4096 1000000 NA 50000 18 401 av01 none\n')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(progress()).toHaveLength(before)

      advance(1000)
      child.stdout.write('[freetube]progress downloading 8192 1000000 NA 50000 17 401 av01 none\n')
      await until(() => progress().length === before + 1)
      expect(progress().at(-1).downloadedBytes).toBe(8192)
    })

    it('ignores lines that are not its own, such as those of a user\'s own template', async () => {
      const { service, report, progress, ours, ended } = setup({
        respond: () => ({
          stdout: [DEST_LINE, 'my own progress: 50%', '[download]  12.3% of 10MiB', DONE_LINE, ''].join('\n'),
          exitCode: 0,
        }),
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(progress().every(p => p.status === 'preparing')).toBe(true)
      expect(ours().at(-1)).toMatchObject({ type: 'finished', path: DEST })
    })
  })

  describe('resuming', () => {
    it('says it is resuming when earlier partial files for the destination are there', async () => {
      const { service, report, ours, ended } = setup({
        directories: { [DOWNLOADS]: ['A video [dQw4w9WgXcQ].f401.mp4.part', 'unrelated.mp4'] },
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(ours()[0]).toMatchObject({ type: 'started', download: { resuming: true } })
    })

    it('counts a part already finished last time too', async () => {
      const { service, report, ours, ended } = setup({
        directories: { [DOWNLOADS]: ['A video [dQw4w9WgXcQ].f401.mp4'] },
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(ours()[0].download.resuming).toBe(true)
    })

    it('does not, with nothing of it there, or only the finished file itself', async () => {
      const { service, report, ours, ended } = setup({
        directories: { [DOWNLOADS]: ['A video [dQw4w9WgXcQ].webm', 'Another video [aaaaaaaaaaa].f401.mp4.part'] },
      })

      await service.start(REQUEST, report)
      await until(ended)

      expect(ours()[0].download.resuming).toBe(false)
    })

    it('notices a resumed part from its first progress line, when the files said nothing', async () => {
      const { service, report, progress } = setup({
        respond: () => ({
          stdout: [DEST_LINE, '[freetube]progress downloading 1977751871 5000000000 NA 8000000 380 401 av01 none', ''].join('\n'),
          hang: true,
        }),
      })

      await service.start(REQUEST, report)
      await until(() => progress().some(p => p.status === 'downloading'))

      expect(progress().at(-1).resuming).toBe(true)
    })
  })

  describe('cancelling', () => {
    it('stops the child and reports cancelled, not failed', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await until(() => downloads().length === 1)

      expect(service.cancel(VIDEO_ID)).toBe(true)
      await until(() => ours().some(o => o.type === 'cancelled'))

      expect(downloads()[0].child.killed).toBe(true)
      expect(ours().map(o => o.type)).not.toContain('failed')
      expect(ours().at(-1).download.status).toBe('cancelled')
      expect(service.isBusy()).toBe(false)
    })

    it('never spawns a download cancelled while it was still being prepared', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      const starting = service.start(REQUEST, report)
      service.cancel(VIDEO_ID)
      await starting

      expect(downloads()).toHaveLength(0)
      expect(ours().map(o => o.type)).toEqual(['cancelled'])
      expect(service.isBusy()).toBe(false)
    })

    it('says there was nothing to cancel for a video not downloading', () => {
      const { service } = setup()

      expect(service.cancel(VIDEO_ID)).toBe(false)
    })
  })

  describe('the list of downloads', () => {
    it('lists running and ended downloads, and the finished files, until dismissed or expired', async () => {
      const { service, report, ended, advance } = setup()

      await service.start(REQUEST, report)
      await until(ended)

      expect(service.list().downloads).toMatchObject([{ videoId: VIDEO_ID, status: 'finished', destination: DEST }])
      expect(service.list().finished).toEqual({ [VIDEO_ID]: DEST })

      service.dismiss(VIDEO_ID)
      expect(service.list().downloads).toEqual([])
      // still there for show in folder
      expect(service.list().finished).toEqual({ [VIDEO_ID]: DEST })

      await service.start({ videoId: 'aaaaaaaaaaa', title: 'Another' }, report)
      await until(() => service.list().downloads.some(d => d.status === 'finished'))
      advance(10 * 60 * 1000)
      expect(service.list().downloads).toEqual([])
    })

    it('does not dismiss a download that is still running', async () => {
      const { service, report, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await until(() => downloads().length === 1)
      service.dismiss(VIDEO_ID)

      expect(service.list().downloads).toHaveLength(1)
    })
  })

  describe('tools from the managed folder', () => {
    it('points yt-dlp at the managed ffmpeg and Deno when those are the ones found', async () => {
      const { service, report, downloads, ended } = setup({
        executables: ['/usr/bin/yt-dlp', `${MANAGED_DIR}/ffmpeg`, `${MANAGED_DIR}/deno`],
      })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe(MANAGED_DIR)
      expect(args[args.indexOf('--js-runtimes') + 1]).toBe(`deno:${MANAGED_DIR}/deno`)
      expect(args.indexOf('--js-runtimes')).toBeLessThan(args.indexOf('--'))
    })

    it('adds neither when ffmpeg and Deno are on PATH, where yt-dlp finds them itself', async () => {
      const { service, report, downloads, ended } = setup({
        executables: [`${MANAGED_DIR}/yt-dlp`, '/usr/bin/ffmpeg', '/usr/bin/deno'],
      })

      await service.start(REQUEST, report)
      await until(ended)

      const { args } = downloads()[0]
      expect(args).not.toContain('--ffmpeg-location')
      expect(args).not.toContain('--js-runtimes')
    })

    it('adds only the one that is managed', async () => {
      const { service, report, downloads, ended } = setup({
        executables: ['/usr/bin/yt-dlp', '/usr/bin/ffmpeg', `${MANAGED_DIR}/deno`],
      })

      await service.start(REQUEST, report)
      await until(ended)

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
      const { service, report, downloads, ended } = setup(options)
      await service.start(REQUEST, report)
      await until(ended)
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
    it('never starts a download that was still being prepared', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      const starting = service.start(REQUEST, report)
      service.stopAll()
      await starting

      expect(downloads()).toHaveLength(0)
      expect(ours()).toEqual([])
      expect(service.isBusy()).toBe(false)
    })

    it('terminates the running children, and reports nothing for them', async () => {
      const { service, report, ours, downloads } = setup({ respond: () => ({ hang: true }) })

      await service.start(REQUEST, report)
      await service.start({ videoId: 'aaaaaaaaaaa', title: 'Another' }, report)
      await until(() => ours().length === 2)

      service.stopAll()

      for (const { child } of downloads()) {
        expect(child.killed).toBe(true)
      }

      await until(() => !service.isBusy())
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(ours().map(o => o.type)).toEqual(['started', 'started'])
    })
  })
})
