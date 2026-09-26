import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractFiles } from './extract'
import { nodeFileSystem } from './nodeFileSystem'

// Built once with tar, xz and zip, and committed as bytes: a folder
// `tool-1.0` holding `bin/ffmpeg` and `bin/ffprobe`, the stand-ins wanted,
// and `doc/ffmpeg`, a decoy with the right name in the wrong folder.
const FIXTURES = path.join(__dirname, 'fixtures')

const expected = {
  ffmpeg: 'stand-in for ffmpeg\n'.repeat(40),
  ffprobe: 'stand-in for ffprobe\n'.repeat(40),
}

/** @type {string} */
let dir

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ft-extract-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * @param {'zip' | 'tar.xz'} kind
 * @param {(bytes: Buffer) => Buffer} [alter]
 */
async function extract(kind, alter = bytes => bytes) {
  const archivePath = path.join(dir, `archive.${kind}`)
  await writeFile(archivePath, alter(await readFile(path.join(FIXTURES, `archive.${kind}`))))

  return extractFiles({
    fs: nodeFileSystem,
    archivePath,
    kind,
    files: [
      { entry: 'bin/ffmpeg', destination: path.join(dir, 'ffmpeg') },
      { entry: 'bin/ffprobe', destination: path.join(dir, 'ffprobe') },
    ],
  })
}

describe.each(['zip', 'tar.xz'])('extracting from a %s', (kind) => {
  it('writes the wanted files, intact, under temporary names', async () => {
    const written = await extract(kind)

    expect(written).toEqual([
      { temporary: path.join(dir, 'ffmpeg.part'), destination: path.join(dir, 'ffmpeg') },
      { temporary: path.join(dir, 'ffprobe.part'), destination: path.join(dir, 'ffprobe') },
    ])
    expect(await readFile(path.join(dir, 'ffmpeg.part'), 'utf8')).toBe(expected.ffmpeg)
    expect(await readFile(path.join(dir, 'ffprobe.part'), 'utf8')).toBe(expected.ffprobe)
  })

  it('leaves the decoy in the archive', async () => {
    await extract(kind)

    expect((await readdir(dir)).sort()).toEqual([`archive.${kind}`, 'ffmpeg.part', 'ffprobe.part'])
  })

  it('fails cleanly on a truncated archive, leaving nothing partial behind', async () => {
    await expect(extract(kind, bytes => bytes.subarray(0, Math.floor(bytes.length / 2)))).rejects.toThrow()

    expect(await readdir(dir)).toEqual([`archive.${kind}`])
  })

  it('fails cleanly when a wanted file is not in the archive', async () => {
    const archivePath = path.join(dir, `archive.${kind}`)
    await writeFile(archivePath, await readFile(path.join(FIXTURES, `archive.${kind}`)))

    await expect(extractFiles({
      fs: nodeFileSystem,
      archivePath,
      kind,
      files: [
        { entry: 'bin/ffmpeg', destination: path.join(dir, 'ffmpeg') },
        { entry: 'bin/ffplay', destination: path.join(dir, 'ffplay') },
      ],
    })).rejects.toThrow(/bin\/ffplay/)

    expect(await readdir(dir)).toEqual([`archive.${kind}`])
  })
})
