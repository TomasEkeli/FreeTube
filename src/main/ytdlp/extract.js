import { unzipSync } from 'fflate'
import { XzReadableStream } from 'xz-decompress'

/**
 * Takes the wanted files out of a downloaded archive, in-process: no system
 * tools, no native addons, one code path on every platform. `fflate` reads
 * zips; `xz-decompress`, xz-embedded compiled to WebAssembly, undoes the xz
 * layer, and the tar inside is read here as it streams by, since the ffmpeg
 * archive unpacks to over half a gigabyte and only two files of it are wanted.
 *
 * Every wanted file is written under a temporary name first. On any failure
 * the temporary files are removed before the error is thrown, so that nothing
 * partial is left behind; on success the caller moves them into place.
 */

/**
 * @typedef {object} WantedFile
 * @property {string} entry the file's path inside the archive, or its tail:
 *   `bin/ffmpeg` matches `ffmpeg-master-latest-linux64-gpl/bin/ffmpeg`
 * @property {string} destination where it is to end up
 */

/**
 * @param {object} options
 * @param {import('./nodeFileSystem').FileSystem} options.fs
 * @param {string} options.archivePath
 * @param {'zip' | 'tar.xz'} options.kind
 * @param {WantedFile[]} options.files
 * @returns {Promise<{ temporary: string, destination: string }[]>} the files written, still under their temporary names
 */
export async function extractFiles({ fs, archivePath, kind, files }) {
  const written = files.map(file => ({ ...file, temporary: `${file.destination}.part`, found: false }))

  try {
    if (kind === 'zip') {
      await extractZip(fs, archivePath, written)
    } else if (kind === 'tar.xz') {
      await extractTarXz(fs, archivePath, written)
    } else {
      throw new Error(`Unknown archive kind: ${kind}`)
    }

    const absent = written.filter(file => !file.found)
    if (absent.length > 0) {
      throw new Error(`The archive does not contain ${absent.map(file => file.entry).join(', ')}`)
    }
  } catch (error) {
    await Promise.all(written.map(file => fs.rm(file.temporary)))
    throw error
  }

  return written.map(({ temporary, destination }) => ({ temporary, destination }))
}

/**
 * @param {string} name
 * @param {string} entry
 */
function matches(name, entry) {
  const normalised = name.replace(/^\.\//, '')
  return normalised === entry || normalised.endsWith(`/${entry}`)
}

/**
 * @param {import('./nodeFileSystem').FileSystem} fs
 * @param {string} archivePath
 * @param {(WantedFile & { temporary: string, found: boolean })[]} written
 */
async function extractZip(fs, archivePath, written) {
  const data = await fs.readFile(archivePath)

  // Inflates only what the filter lets through
  const entries = unzipSync(data, {
    filter: file => !file.name.endsWith('/') && written.some(wanted => matches(file.name, wanted.entry)),
  })

  for (const [name, contents] of Object.entries(entries)) {
    const wanted = written.find(file => !file.found && matches(name, file.entry))
    if (!wanted) {
      continue
    }

    const out = await fs.openWrite(wanted.temporary)
    try {
      await out.write(contents)
    } finally {
      await out.close()
    }
    wanted.found = true
  }
}

const BLOCK = 512

/**
 * @param {import('./nodeFileSystem').FileSystem} fs
 * @param {string} archivePath
 * @param {(WantedFile & { temporary: string, found: boolean })[]} written
 */
async function extractTarXz(fs, archivePath, written) {
  const source = fs.openRead(archivePath)
  const decompressed = new XzReadableStream(ReadableStream.from(source)).getReader()
  const reader = new TarReader()

  try {
    while (true) {
      const { done, value: chunk } = await decompressed.read()
      if (done) {
        break
      }

      await reader.push(chunk, async (entry) => {
        if (entry.type !== 'file') {
          return null
        }

        const wanted = written.find(file => !file.found && matches(entry.name, file.entry))
        if (!wanted) {
          return null
        }

        wanted.found = true
        return await fs.openWrite(wanted.temporary)
      })

      // Everything wanted is written in full: the rest need not be unpacked
      if (reader.ended || (reader.current === null && written.every(file => file.found))) {
        break
      }
    }

    // The stream ran out partway through an entry, or before the archive's
    // end with something still to find
    if (reader.current !== null || (!reader.ended && !written.every(file => file.found))) {
      throw new Error('The archive is truncated')
    }
  } finally {
    await reader.abandon()

    try {
      await decompressed.cancel()
    } catch {
      // xz-decompress throws when cancelled after it has already finished
    }

    // @ts-ignore a Node stream, when it is one
    source.destroy?.()
  }
}

/**
 * A tar reader fed chunk by chunk, for archives too big to hold in memory.
 * Understands ustar, GNU long names and pax path records, which is what the
 * archives it reads use.
 */
class TarReader {
  constructor() {
    /** @type {Uint8Array} */
    this.pending = new Uint8Array(0)
    /** @type {{ remaining: number, padding: number, out: { write: Function, close: Function } | null, collect: Uint8Array[] | null, kind: string } | null} */
    this.current = null
    /** A name from a GNU long name or pax header, for the entry that follows */
    this.nextName = null
    this.zeroBlocks = 0
    this.ended = false
  }

  /**
   * @param {Uint8Array} chunk
   * @param {(entry: { name: string, type: 'file' | 'other', size: number }) => Promise<{ write: (chunk: Uint8Array) => Promise<void>, close: () => Promise<void> } | null>} onEntry
   *   returns where to write the entry's contents, or null to skip them
   */
  async push(chunk, onEntry) {
    let data = this.pending.length > 0 ? concat(this.pending, chunk) : chunk
    this.pending = new Uint8Array(0)

    while (data.length > 0 && !this.ended) {
      if (this.current !== null) {
        data = await this.consumeContents(data)
        continue
      }

      if (data.length < BLOCK) {
        this.pending = data.slice()
        return
      }

      const header = data.subarray(0, BLOCK)
      data = data.subarray(BLOCK)

      if (header.every(byte => byte === 0)) {
        // Two zero blocks end the archive
        this.zeroBlocks++
        if (this.zeroBlocks >= 2) {
          this.ended = true
        }
        continue
      }
      this.zeroBlocks = 0

      await this.startEntry(header, onEntry)
    }
  }

  /**
   * @param {Uint8Array} header
   * @param {Parameters<TarReader['push']>[1]} onEntry
   */
  async startEntry(header, onEntry) {
    const typeFlag = String.fromCharCode(header[156])
    const size = parseSize(header.subarray(124, 136))

    // Garbage rather than a header: stop, rather than misread what follows
    if (!Number.isSafeInteger(size) || size < 0 || !checksumMatches(header)) {
      throw new Error('The archive is corrupt')
    }

    const padding = (BLOCK - (size % BLOCK)) % BLOCK

    // Headers whose contents are the name, or the attributes, of the next entry
    if (typeFlag === 'L' || typeFlag === 'x') {
      this.current = { remaining: size, padding, out: null, collect: [], kind: typeFlag }
      return
    }

    let name = this.nextName ?? headerName(header)
    this.nextName = null
    name = name.replace(/\0.*$/s, '')

    const isFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '7'
    const out = await onEntry({ name, type: isFile ? 'file' : 'other', size })

    this.current = { remaining: size, padding, out, collect: null, kind: typeFlag }

    if (size === 0 && padding === 0) {
      await this.finishEntry()
    }
  }

  /**
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>} what is left after this entry's share
   */
  async consumeContents(data) {
    const current = this.current

    if (current.remaining > 0) {
      const take = Math.min(current.remaining, data.length)
      const part = data.subarray(0, take)

      if (current.out) {
        // A copy, since the chunk's buffer is reused by the decompressor
        await current.out.write(part.slice())
      } else if (current.collect) {
        current.collect.push(part.slice())
      }

      current.remaining -= take
      data = data.subarray(take)
    }

    if (current.remaining === 0) {
      const skip = Math.min(current.padding, data.length)
      current.padding -= skip
      data = data.subarray(skip)

      if (current.padding === 0) {
        await this.finishEntry()
      }
    }

    return data
  }

  /**
   * Closes a file left open by an entry that never finished.
   */
  async abandon() {
    const out = this.current?.out
    this.current = null
    await out?.close()
  }

  async finishEntry() {
    const current = this.current
    this.current = null

    if (current.out) {
      await current.out.close()
    }

    if (current.collect) {
      const text = new TextDecoder().decode(concat(...current.collect))

      if (current.kind === 'L') {
        this.nextName = text
      } else {
        // pax records: "<length> <key>=<value>\n"
        const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1]
        if (path !== undefined) {
          this.nextName = path
        }
      }
    }
  }
}

/**
 * @param {Uint8Array} header
 */
function headerName(header) {
  const decoder = new TextDecoder()
  const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '')
  // POSIX ustar only: GNU's "ustar  " keeps other things where the prefix goes
  const isPosixUstar = decoder.decode(header.subarray(257, 265)) === 'ustar\u000000'
  const prefix = isPosixUstar ? decoder.decode(header.subarray(345, 500)).replace(/\0.*$/s, '') : ''

  return prefix ? `${prefix}/${name}` : name
}

/**
 * The header's own checksum: the sum of its bytes, with the checksum field
 * counted as spaces.
 *
 * @param {Uint8Array} header
 */
function checksumMatches(header) {
  const field = new TextDecoder().decode(header.subarray(148, 156)).replace(/\0.*$/s, '').trim()
  const stored = /^[0-7]+$/.test(field) ? Number.parseInt(field, 8) : Number.NaN

  let sum = 0
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }

  return sum === stored
}

/**
 * Octal digits, or GNU base-256 for sizes too big for them.
 *
 * @param {Uint8Array} field
 */
function parseSize(field) {
  if (field[0] & 0x80) {
    let size = 0
    for (let index = 1; index < field.length; index++) {
      size = size * 256 + field[index]
    }
    return size
  }

  const text = new TextDecoder().decode(field).replace(/\0.*$/s, '').trim()
  return text.length > 0 ? Number.parseInt(text, 8) : 0
}

/**
 * @param {...Uint8Array} parts
 */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
