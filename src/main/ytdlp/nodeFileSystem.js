import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

/**
 * The few filesystem operations the installer and extraction need, on the
 * real filesystem. Tests hand them an in-memory one with the same shape.
 *
 * @typedef {object} FileSystem
 * @property {(dir: string) => Promise<void>} mkdir recursive, and fine if it exists
 * @property {(filePath: string) => Promise<{ write: (chunk: Uint8Array) => Promise<void>, close: () => Promise<void> }>} openWrite
 * @property {(filePath: string) => Promise<Uint8Array>} readFile
 * @property {(filePath: string) => AsyncIterable<Uint8Array>} openRead
 * @property {(from: string, to: string) => Promise<void>} rename replaces `to`
 * @property {(filePath: string) => Promise<void>} rm fine if it does not exist
 * @property {(filePath: string, mode: number) => Promise<void>} chmod
 */

/** @type {FileSystem} */
export const nodeFileSystem = {
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true })
  },

  openWrite: async (filePath) => {
    const handle = await fs.open(filePath, 'w')
    return {
      write: async (chunk) => {
        await handle.write(chunk)
      },
      close: () => handle.close(),
    }
  },

  readFile: async (filePath) => new Uint8Array(await fs.readFile(filePath)),

  openRead: filePath => createReadStream(filePath),

  rename: (from, to) => fs.rename(from, to),

  rm: (filePath) => fs.rm(filePath, { force: true }),

  chmod: (filePath, mode) => fs.chmod(filePath, mode),
}
