import { describe, expect, it } from 'vitest'

import { createDownloadService } from './downloadService'
import { createFakeSpawn, until } from './testing/fakeProcess'

const VIDEO_ID = 'dQw4w9WgXcQ'
const REQUEST = { videoId: VIDEO_ID, title: 'A video' }

/**
 * @param {object} options
 * @param {(command: string, args: string[]) => import('./testing/fakeProcess').Script} [options.respond]
 * @param {string[]} [options.executables] files that exist and can be run
 */
function setup({ respond = () => ({}), executables = ['/usr/bin/yt-dlp'] } = {}) {
  const fake = createFakeSpawn(respond)
  const outcomes = []

  const service = createDownloadService({
    spawn: fake.spawn,
    isExecutableFile: async filePath => executables.includes(filePath),
    defaultDownloadFolder: () => '/home/viewer/Downloads',
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
  })

  const report = outcome => outcomes.push(outcome)
  const downloads = () => fake.calls.filter(call => call.command !== 'taskkill')

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

    it('reports not found, and spawns nothing, when there is no yt-dlp on PATH', async () => {
      const { service, report, outcomes, downloads } = setup({ executables: [] })

      await service.start(REQUEST, report)

      expect(outcomes).toEqual([{ type: 'not-found', videoId: VIDEO_ID, title: 'A video' }])
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
