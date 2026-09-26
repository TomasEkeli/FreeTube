import path from 'node:path'

/**
 * Finds an executable the way a shell would, by walking the PATH entries in
 * order, so that what gets spawned is a full path rather than a bare name.
 *
 * @param {string} name the executable's name, without any extension
 * @param {object} options
 * @param {'win32' | string} options.platform
 * @param {Record<string, string | undefined>} options.env
 * @param {(filePath: string) => Promise<boolean>} options.isExecutableFile
 * @returns {Promise<string | null>}
 */
export async function findOnPath(name, { platform, env, isExecutableFile }) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  const delimiter = platform === 'win32' ? ';' : ':'

  // Windows keeps it as `Path`, and environment variable names are case
  // insensitive there, so look it up without regard to case.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH')
  const pathValue = pathKey === undefined ? '' : (env[pathKey] ?? '')

  // Only real executables: without a shell, Windows cannot start a `.bat` or
  // `.cmd`, and Node refuses to try.
  const extensions = platform === 'win32' ? ['.exe', '.com'] : ['']

  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue
    }

    // Quoted entries are legal on Windows
    const unquoted = directory.replace(/^"(.*)"$/, '$1')

    // A relative entry means whatever the working directory holds
    if (!pathModule.isAbsolute(unquoted)) {
      continue
    }

    for (const extension of extensions) {
      const candidate = pathModule.join(unquoted, name + extension)

      if (await isExecutableFile(candidate)) {
        return candidate
      }
    }
  }

  return null
}
