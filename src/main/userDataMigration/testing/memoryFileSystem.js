import path from 'node:path'

/**
 * An in-memory stand-in for the migration's filesystem: files with their bytes
 * and mode, directories, and symlinks with their target. Paths are POSIX.
 * Symlinks are followed where the real calls follow them, so that a test can
 * see what a stray link would do.
 *
 * `failOn` lets a test make one operation throw, to see what a failure part
 * way through leaves behind: return true for an I/O error, or an error code.
 *
 * @typedef {{ kind: 'file', data: string, mode: number } | { kind: 'directory' } | { kind: 'symlink', target: string }} Entry
 *
 * @param {object} [options]
 * @param {(operation: string, filePath: string) => boolean | string} [options.failOn]
 * @param {() => number} [options.now] the clock that stamps modification times
 * @returns {import('../nodeFileSystem').MigrationFileSystem & {
 *   entries: Map<string, Entry>,
 *   file: (filePath: string, data?: string, mode?: number) => void,
 *   directory: (dir: string) => void,
 *   link: (filePath: string, target: string) => void,
 *   snapshot: (dir: string) => Record<string, Entry>,
 * }}
 */
export function createMemoryFileSystem({ failOn = () => false, now = () => 0 } = {}) {
  /** @type {Map<string, Entry>} */
  const entries = new Map()
  /** @type {Map<string, number>} */
  const modified = new Map()

  /**
   * @param {string} operation
   * @param {string} filePath
   */
  function check(operation, filePath) {
    const failure = failOn(operation, filePath)
    if (failure) {
      const code = typeof failure === 'string' ? failure : 'EIO'
      throw Object.assign(new Error(`${code}: ${operation} ${filePath}`), { code })
    }
  }

  /** @param {string} filePath */
  function missing(filePath) {
    return Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
  }

  /**
   * @param {string} filePath
   * @param {Entry} entry
   */
  function set(filePath, entry) {
    entries.set(filePath, entry)
    modified.set(filePath, now())
  }

  /** @param {string} filePath */
  function remove(filePath) {
    entries.delete(filePath)
    modified.delete(filePath)
  }

  /** @param {string} dir */
  function ensureDirectory(dir) {
    let current = dir
    while (current !== '/' && !entries.has(current)) {
      set(current, { kind: 'directory' })
      current = path.dirname(current)
    }
  }

  /**
   * Where a path ends up once any symlink at it is followed.
   *
   * @param {string} filePath
   */
  function resolve(filePath) {
    let current = filePath
    for (let hops = 0; hops < 40; hops++) {
      const entry = entries.get(current)
      if (entry?.kind !== 'symlink') {
        return current
      }
      current = path.resolve(path.dirname(current), entry.target)
    }
    throw Object.assign(new Error(`ELOOP: ${filePath}`), { code: 'ELOOP' })
  }

  return {
    entries,

    file: (filePath, data = '', mode = 0o644) => {
      ensureDirectory(path.dirname(filePath))
      set(filePath, { kind: 'file', data, mode })
    },

    directory: (dir) => {
      ensureDirectory(dir)
    },

    link: (filePath, target) => {
      ensureDirectory(path.dirname(filePath))
      set(filePath, { kind: 'symlink', target })
    },

    snapshot: (dir) => {
      /** @type {Record<string, Entry>} */
      const out = {}
      for (const [filePath, entry] of entries) {
        if (filePath.startsWith(dir + '/')) {
          out[filePath.slice(dir.length + 1)] = { ...entry }
        }
      }
      return out
    },

    kind: (filePath) => entries.get(filePath)?.kind ?? null,

    size: (filePath) => {
      const entry = entries.get(resolve(filePath))
      return entry?.kind === 'file' ? entry.data.length : null
    },

    modifiedAt: (filePath) => modified.get(filePath) ?? null,

    list: (dir) => {
      const prefix = dir + '/'
      return [...entries.keys()]
        .filter(filePath => filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/'))
        .map(filePath => filePath.slice(prefix.length))
    },

    mkdir: (dir) => {
      check('mkdir', dir)
      ensureDirectory(dir)
    },

    copyFile: (from, to) => {
      check('copyFile', to)
      const source = entries.get(resolve(from))
      if (source?.kind !== 'file') {
        throw missing(from)
      }
      // Like the real call, a symlink already at the destination is followed,
      // and whatever it points at is overwritten
      const destination = resolve(to)
      if (!entries.has(path.dirname(destination))) {
        throw missing(path.dirname(destination))
      }
      set(destination, { ...source })
    },

    readlink: (filePath) => {
      const entry = entries.get(filePath)
      if (entry?.kind !== 'symlink') {
        throw missing(filePath)
      }
      return entry.target
    },

    symlink: (target, filePath) => {
      check('symlink', filePath)
      if (entries.has(filePath)) {
        throw Object.assign(new Error(`EEXIST: ${filePath}`), { code: 'EEXIST' })
      }
      set(filePath, { kind: 'symlink', target })
    },

    rename: (from, to) => {
      check('rename', to)
      const entry = entries.get(from)
      if (!entry) {
        throw missing(from)
      }
      remove(from)
      set(to, entry)
    },

    rm: (filePath) => {
      remove(filePath)
    },

    createExclusive: (filePath, text) => {
      check('createExclusive', filePath)
      if (entries.has(filePath)) {
        throw Object.assign(new Error(`EEXIST: ${filePath}`), { code: 'EEXIST' })
      }
      set(filePath, { kind: 'file', data: text, mode: 0o644 })
    },

    writeText: (filePath, text) => {
      check('writeText', filePath)
      set(filePath, { kind: 'file', data: text, mode: 0o644 })
    },

    readText: (filePath) => {
      const entry = entries.get(resolve(filePath))
      return entry?.kind === 'file' ? entry.data : null
    },
  }
}
