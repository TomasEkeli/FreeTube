import { describe, expect, it } from 'vitest'

import { createToolDetector, managedToolPath, parseVersion } from './toolDetection'
import { createFakeSpawn } from './testing/fakeProcess'

const MANAGED_DIR = '/data/FreeTube/bin'

/**
 * @param {object} options
 * @param {Record<string, string>} options.answers what each executable prints for its version
 * @param {string} [options.picked]
 * @param {string} [options.platform]
 * @param {Record<string, string>} [options.env]
 */
function setup({ answers, picked = '', platform = 'linux', env = { PATH: '/usr/bin' } }) {
  const fake = createFakeSpawn(command => (command in answers ? { stdout: answers[command] } : { exitCode: 1 }))
  let time = 0

  const detector = createToolDetector({
    spawn: fake.spawn,
    isExecutableFile: async filePath => filePath in answers,
    readSetting: async () => picked,
    managedDir: MANAGED_DIR,
    platform,
    env,
    now: () => time,
  })

  return { detector, fake, advance: (ms) => { time += ms } }
}

describe('tool detection', () => {
  it('reports each tool found with its version and where it came from', async () => {
    const { detector } = setup({
      answers: {
        '/opt/yt-dlp': '2026.09.16.232951\n',
        [`${MANAGED_DIR}/ffmpeg`]: 'ffmpeg version N-121067-g0e0ebfe5b9-20260925 Copyright (c) 2000-2026\n',
        '/usr/bin/deno': 'deno 2.5.1 (stable, release, x86_64-unknown-linux-gnu)\nv8 14.0\n',
      },
      picked: '/opt/yt-dlp',
    })

    expect(await detector.detect()).toEqual({
      'yt-dlp': { tool: 'yt-dlp', found: true, source: 'picked', path: '/opt/yt-dlp', version: '2026.09.16.232951' },
      ffmpeg: { tool: 'ffmpeg', found: true, source: 'managed', path: `${MANAGED_DIR}/ffmpeg`, version: 'N-121067-g0e0ebfe5b9-20260925' },
      deno: { tool: 'deno', found: true, source: 'path', path: '/usr/bin/deno', version: '2.5.1' },
    })
  })

  it('reports a tool missing when nothing answers', async () => {
    const { detector } = setup({ answers: {} })

    const statuses = await detector.detect()

    expect(statuses.ffmpeg).toEqual({ tool: 'ffmpeg', found: false, source: null, path: null, version: null })
  })

  it('looks for Windows executables with their extension', async () => {
    const { detector } = setup({
      platform: 'win32',
      env: { Path: 'C:\\Tools' },
      answers: {
        'C:\\Tools\\yt-dlp.exe': '2026.09.16\r\n',
      },
    })

    const statuses = await detector.detect()

    expect(statuses['yt-dlp']).toMatchObject({ found: true, source: 'path', path: 'C:\\Tools\\yt-dlp.exe' })
    expect(managedToolPath('C:\\data\\bin', 'ffmpeg', 'win32')).toBe('C:\\data\\bin\\ffmpeg.exe')
  })

  it('reuses a complete detection for a while, and looks again once invalidated', async () => {
    const { detector, fake, advance } = setup({
      answers: {
        '/usr/bin/yt-dlp': '2026.09.16\n',
        '/usr/bin/ffmpeg': 'ffmpeg version 7.1\n',
        '/usr/bin/deno': 'deno 2.5.1\n',
      },
    })

    await detector.detect()
    await detector.detect()
    expect(fake.calls).toHaveLength(3)

    detector.invalidate()
    await detector.detect()
    expect(fake.calls).toHaveLength(6)

    advance(10 * 60 * 1000)
    await detector.detect()
    expect(fake.calls).toHaveLength(9)
  })

  it('looks again when a tool it found has been removed since', async () => {
    const answers = {
      '/usr/bin/yt-dlp': '2026.09.16\n',
      '/usr/bin/ffmpeg': 'ffmpeg version 7.1\n',
      '/usr/bin/deno': 'deno 2.5.1\n',
    }
    const { detector } = setup({ answers })

    await detector.detect()
    delete answers['/usr/bin/deno']

    expect((await detector.detect()).deno.found).toBe(false)
  })

  it('never reuses a detection with something missing', async () => {
    const { detector, fake } = setup({ answers: { '/usr/bin/yt-dlp': '2026.09.16\n' } })

    await detector.detect()
    await detector.detect()

    expect(fake.calls).toHaveLength(2)
  })

  it('parses the versions the tools print', () => {
    expect(parseVersion('yt-dlp', '2025.10.22\n')).toBe('2025.10.22')
    expect(parseVersion('yt-dlp', 'Usage: yt-dlp [OPTIONS]\n')).toBeNull()
    expect(parseVersion('ffmpeg', 'ffmpeg version 7.1.1-1ubuntu1 Copyright (c) 2000-2025\n')).toBe('7.1.1-1ubuntu1')
    expect(parseVersion('deno', 'deno 2.5.1 (stable, release, x86_64-pc-windows-msvc)\r\n')).toBe('2.5.1')
  })
})
