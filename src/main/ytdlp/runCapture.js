/**
 * Runs a program to completion and collects what it wrote, for the short
 * commands around a download: version probes and self-updates.
 *
 * @param {typeof import('node:child_process').spawn} spawn
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, error: Error | null }>}
 */
export function runCapture(spawn, command, args, { timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(env ? { env } : {}),
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error })
      return
    }

    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    const timer = setTimeout(() => child.kill(), timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, error })
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, error: null })
    })
  })
}
