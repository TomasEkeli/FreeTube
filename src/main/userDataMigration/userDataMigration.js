import path from 'node:path'

/** Held while a launch decides whether to migrate, and while it does */
const LOCK = '.migration-lock'

/** There only while a migration is under way, so one found says it was cut short */
const INCOMPLETE = '.migration-incomplete'

/** Longer than any migration takes, so a lock this old is left over */
const STALE_AFTER_MS = 10 * 60 * 1000

const WAIT_MS = 250

/**
 * Carries a user's data over from a folder the app used under an earlier name
 * into the folder it uses now. It copies, never moves: whatever else uses the
 * old folder, such as an installed official FreeTube, keeps working with it.
 *
 * What is copied is a short list, because the rest of the folder is
 * Chromium's own and regenerates: every database file, the `bin` folder of
 * managed tools, and the `experiment-*` flag files. Caches and browser storage
 * are left behind.
 *
 * The migration runs only while the new folder holds no database with anything
 * in it. Whether the folder exists says nothing, since Chromium creates it
 * early on, and neither do empty databases, which the app leaves behind when
 * it starts after a failed migration.
 *
 * Databases are copied last and moved into place together, and on a failure
 * the ones already moved are taken out again, so the next launch tries again.
 * A launch killed part way through leaves a marker, and the next one copies
 * everything again whatever it finds.
 *
 * Two launches at once would each copy over the other: a lock file keeps a
 * second launch waiting until the first is done, or has died.
 *
 * @typedef {{ outcome: 'copied', from: string, linksCopiedAsFiles: string[] }
 *   | { outcome: 'skipped-target-has-data' }
 *   | { outcome: 'skipped-no-source' }
 *   | { outcome: 'failed', from: string | undefined, error: Error }} MigrationResult
 *
 * @param {object} options
 * @param {string} options.root the folder both the old and the new folder are in
 * @param {string[]} options.sources the old folder names, in order of preference
 * @param {string} options.target the new folder name
 * @param {import('./nodeFileSystem').MigrationFileSystem} options.fs
 * @param {number} options.pid this process, written into the lock
 * @param {(pid: number) => boolean} options.isAlive whether the process holding the lock still runs
 * @param {() => number} options.now milliseconds, on the clock file modification times use
 * @param {(ms: number) => void} options.sleep blocks, since the migration is synchronous
 * @returns {MigrationResult}
 */
export function migrateUserData({ root, sources, target, fs, pid, isAlive, now, sleep }) {
  const targetDir = path.join(root, target)
  const lockPath = path.join(targetDir, LOCK)
  const incompletePath = path.join(targetDir, INCOMPLETE)

  let locked = false
  /** @type {string | undefined} */
  let from

  try {
    fs.mkdir(targetDir)
    acquireLock({ fs, lockPath, pid, isAlive, now, sleep })
    locked = true

    const interrupted = fs.kind(incompletePath) !== null
    if (!interrupted && databasesWithData(fs, targetDir).length > 0) {
      return { outcome: 'skipped-target-has-data' }
    }

    from = sources.find(source => databasesWithData(fs, path.join(root, source)).length > 0)
    if (from === undefined) {
      fs.rm(incompletePath)
      return { outcome: 'skipped-no-source' }
    }

    const sourceDir = path.join(root, from)
    const copy = { fs, sourceDir, linksCopiedAsFiles: [] }

    fs.writeText(incompletePath, '')

    try {
      for (const name of fs.list(sourceDir).filter(name => name === 'bin' || name.startsWith('experiment-'))) {
        copyEntry(copy, path.join(sourceDir, name), path.join(targetDir, name))
      }

      moveDatabasesIn(copy, targetDir)
    } catch (error) {
      fs.rm(incompletePath)
      throw error
    }

    fs.rm(incompletePath)
    return { outcome: 'copied', from, linksCopiedAsFiles: copy.linksCopiedAsFiles }
  } catch (error) {
    return { outcome: 'failed', from, error }
  } finally {
    if (locked) {
      fs.rm(lockPath)
    }
  }
}

/**
 * @param {object} options
 * @param {import('./nodeFileSystem').MigrationFileSystem} options.fs
 * @param {string} options.lockPath
 * @param {number} options.pid
 * @param {(pid: number) => boolean} options.isAlive
 * @param {() => number} options.now
 * @param {(ms: number) => void} options.sleep
 */
function acquireLock({ fs, lockPath, pid, isAlive, now, sleep }) {
  for (;;) {
    try {
      fs.createExclusive(lockPath, String(pid))
      return
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }

    const since = fs.modifiedAt(lockPath)
    if (since === null) {
      // Gone between the two calls: try again at once
      continue
    }

    const holder = Number.parseInt(fs.readText(lockPath) ?? '', 10)
    // An unreadable holder may be a lock still being written, so only its
    // age can say it is left over. Our own pid is left over from an earlier
    // process that had the same one.
    const leftOver = (Number.isInteger(holder) && (holder === pid || !isAlive(holder))) ||
      now() - since > STALE_AFTER_MS

    if (leftOver) {
      fs.rm(lockPath)
    } else {
      sleep(WAIT_MS)
    }
  }
}

/**
 * Copies every database into the new folder under a staging name, then moves
 * them all into place. On a failure it takes out every staged file and every
 * database it moved in, so none are left.
 *
 * @param {{ fs: import('./nodeFileSystem').MigrationFileSystem, sourceDir: string, linksCopiedAsFiles: string[] }} copy
 * @param {string} targetDir
 */
function moveDatabasesIn(copy, targetDir) {
  const { fs, sourceDir } = copy

  const staged = databasesWithData(fs, sourceDir).map(name => ({
    from: path.join(sourceDir, name),
    staging: path.join(targetDir, `${name}.migrating`),
    to: path.join(targetDir, name),
  }))
  /** @type {string[]} */
  const moved = []

  try {
    for (const file of staged) {
      copyEntry(copy, file.from, file.staging)
    }
    for (const file of staged) {
      fs.rename(file.staging, file.to)
      moved.push(file.to)
    }
  } catch (error) {
    for (const file of staged) {
      fs.rm(file.staging)
    }
    for (const filePath of moved) {
      fs.rm(filePath)
    }
    throw error
  }
}

/**
 * The database files in a folder that have something in them, following
 * symlinks to see.
 *
 * @param {import('./nodeFileSystem').MigrationFileSystem} fs
 * @param {string} dir
 */
function databasesWithData(fs, dir) {
  return fs.list(dir).filter((name) => {
    if (!name.endsWith('.db')) {
      return false
    }
    const filePath = path.join(dir, name)
    const kind = fs.kind(filePath)
    return (kind === 'file' || kind === 'symlink') && (fs.size(filePath) ?? 0) > 0
  })
}

/**
 * @param {{ fs: import('./nodeFileSystem').MigrationFileSystem, sourceDir: string, linksCopiedAsFiles: string[] }} copy
 * @param {string} from
 * @param {string} to
 */
function copyEntry(copy, from, to) {
  const { fs, sourceDir } = copy

  switch (fs.kind(from)) {
    case 'symlink': {
      fs.rm(to)
      try {
        fs.symlink(linkTarget(sourceDir, from, fs.readlink(from)), to)
      } catch (error) {
        // Windows allows symlinks only to administrators and in developer
        // mode. A copy of what the link points at is better than nothing.
        if (error.code !== 'EPERM') {
          throw error
        }
        fs.copyFile(from, to)
        copy.linksCopiedAsFiles.push(path.relative(sourceDir, from))
      }
      break
    }
    case 'directory': {
      fs.mkdir(to)
      for (const name of fs.list(from)) {
        copyEntry(copy, path.join(from, name), path.join(to, name))
      }
      break
    }
    case 'file': {
      // Whatever is already there goes first: a symlink left at the
      // destination would otherwise be written through
      fs.rm(to)
      fs.copyFile(from, to)
      break
    }
  }
}

/**
 * Whether a path inside the old folder, relative to it, is one the migration
 * copies.
 *
 * @param {string} relative
 */
function isCopied(relative) {
  const [first, ...rest] = relative.split(path.sep)
  return first === 'bin' ||
    (rest.length === 0 && (first.endsWith('.db') || first.startsWith('experiment-')))
}

/**
 * A link's target, as the copy of the link needs it. A relative target that
 * points at something the migration copies too is kept as it is, since it
 * resolves the same way from the new folder. Any other relative target would
 * resolve to nothing, or somewhere else, so it becomes absolute.
 *
 * @param {string} sourceDir
 * @param {string} link
 * @param {string} target
 */
function linkTarget(sourceDir, link, target) {
  if (path.isAbsolute(target)) {
    return target
  }

  const resolved = path.resolve(path.dirname(link), target)
  const fromSource = path.relative(sourceDir, resolved)
  const inside = fromSource !== '' && !fromSource.startsWith('..') && !path.isAbsolute(fromSource)

  return inside && isCopied(fromSource) ? target : resolved
}
