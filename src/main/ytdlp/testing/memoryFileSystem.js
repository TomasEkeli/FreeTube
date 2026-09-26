/**
 * An in-memory stand-in for the installer's filesystem, holding each file's
 * bytes and mode.
 *
 * @returns {import('../nodeFileSystem').FileSystem & { files: Map<string, { data: Uint8Array, mode: number }> }}
 */
export function createMemoryFileSystem() {
  /** @type {Map<string, { data: Uint8Array, mode: number }>} */
  const files = new Map()

  return {
    files,

    mkdir: async () => {},

    openWrite: async (filePath) => {
      const chunks = []
      files.set(filePath, { data: new Uint8Array(0), mode: 0o644 })

      return {
        write: async (chunk) => {
          chunks.push(chunk)
        },
        close: async () => {
          files.set(filePath, { data: concat(chunks), mode: 0o644 })
        },
      }
    },

    readFile: async (filePath) => {
      const file = files.get(filePath)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
      }
      return file.data
    },

    openRead: (filePath) => {
      return (async function * () {
        const file = files.get(filePath)
        if (!file) {
          throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
        }
        yield file.data
      })()
    },

    rename: async (from, to) => {
      const file = files.get(from)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' })
      }
      files.delete(from)
      files.set(to, file)
    },

    rm: async (filePath) => {
      files.delete(filePath)
    },

    chmod: async (filePath, mode) => {
      const file = files.get(filePath)
      if (!file) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
      }
      file.mode = mode
    },
  }
}

/**
 * @param {Uint8Array[]} chunks
 */
function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * A fake `fetch` serving fixed bodies by URL, recording what was asked for.
 *
 * @param {Record<string, string | Uint8Array>} responses
 */
export function createFakeFetch(responses) {
  /** @type {string[]} */
  const requested = []

  /**
   * @param {string} url
   */
  async function fetch(url) {
    requested.push(url)

    if (!(url in responses)) {
      return new Response('not found', { status: 404 })
    }

    const body = responses[url]
    return new Response(body, {
      status: 200,
      headers: { 'content-length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.length) },
    })
  }

  return { fetch, requested }
}
