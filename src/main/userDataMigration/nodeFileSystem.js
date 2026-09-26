import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

/**
 * The few filesystem operations the user data migration needs. They are
 * synchronous because the migration has to finish before the datastores
 * module is evaluated, and that module is imported, not called.
 *
 * @typedef {object} MigrationFileSystem
 * @property {(filePath: string) => 'file' | 'directory' | 'symlink' | null} kind without following a symlink; null if nothing is there
 * @property {(filePath: string) => number | null} size in bytes, following symlinks; null if there is no file
 * @property {(filePath: string) => number | null} modifiedAt in milliseconds; null if nothing is there
 * @property {(dir: string) => string[]} list the names in a directory, and none if it does not exist
 * @property {(dir: string) => void} mkdir recursive, and fine if it exists
 * @property {(from: string, to: string) => void} copyFile replaces `to`, and keeps the mode; follows symlinks at either end
 * @property {(filePath: string) => string} readlink
 * @property {(target: string, filePath: string) => void} symlink
 * @property {(from: string, to: string) => void} rename replaces `to`
 * @property {(filePath: string) => void} rm a file or symlink, and fine if it does not exist
 * @property {(filePath: string, text: string) => void} createExclusive throws EEXIST if anything is there
 * @property {(filePath: string, text: string) => void} writeText
 * @property {(filePath: string) => string | null} readText null if there is no file
 */

/** @type {MigrationFileSystem} */
export const nodeFileSystem = {
  kind: (filePath) => {
    const stats = lstatSync(filePath, { throwIfNoEntry: false })
    if (!stats) {
      return null
    }
    if (stats.isSymbolicLink()) {
      return 'symlink'
    }
    if (stats.isDirectory()) {
      return 'directory'
    }
    return stats.isFile() ? 'file' : null
  },

  size: (filePath) => {
    const stats = statSync(filePath, { throwIfNoEntry: false })
    return stats?.isFile() ? stats.size : null
  },

  modifiedAt: (filePath) => lstatSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? null,

  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []
      }
      throw error
    }
  },

  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true })
  },

  // A copy-on-write clone where the filesystem offers one, which makes the
  // managed tools, hundreds of megabytes, cost next to nothing to copy
  copyFile: (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE),

  readlink: filePath => readlinkSync(filePath),

  symlink: (target, filePath) => symlinkSync(target, filePath),

  rename: (from, to) => renameSync(from, to),

  rm: (filePath) => rmSync(filePath, { force: true }),

  createExclusive: (filePath, text) => writeFileSync(filePath, text, { flag: 'wx' }),

  writeText: (filePath, text) => writeFileSync(filePath, text),

  readText: (filePath) => {
    try {
      return readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  },
}
