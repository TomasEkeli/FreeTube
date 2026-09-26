import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/**
 * A scripted stand-in for a child process: an event emitter with stdout and
 * stderr streams that plays back what it was told to, then exits or errors.
 *
 * @typedef {object} Script
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number | null} [exitCode] defaults to 0
 * @property {Error} [error] a spawn error instead of running
 * @property {boolean} [hang] never exit on its own, until killed
 */

export class FakeChild extends EventEmitter {
  /**
   * @param {Script} script
   */
  constructor(script) {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.pid = undefined
    this.killed = false
    this.script = script

    setImmediate(() => this.play())
  }

  play() {
    const { stdout = '', stderr = '', exitCode = 0, error, hang } = this.script

    if (error) {
      this.emit('error', error)
      this.stdout.end()
      this.stderr.end()
      setImmediate(() => this.emit('close', -2, null))
      return
    }

    this.emit('spawn')
    this.stdout.write(stdout)
    this.stderr.write(stderr)

    if (hang) {
      return
    }

    this.finish(exitCode, null)
  }

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  finish(code, signal) {
    this.stdout.end()
    this.stderr.end()
    // 'close' comes after the streams have ended, as with a real child
    setTimeout(() => this.emit('close', code, signal), 5)
  }

  kill(signal = 'SIGTERM') {
    this.killed = true
    this.finish(null, signal)
    return true
  }
}

/**
 * A fake `spawn` that records every call and answers each with a script
 * chosen by `respond`, which sees the command and its arguments.
 *
 * @param {(command: string, args: string[]) => Script} respond
 */
export function createFakeSpawn(respond) {
  /** @type {{ command: string, args: string[], options: object, child: FakeChild }[]} */
  const calls = []

  /**
   * @param {string} command
   * @param {string[]} args
   * @param {object} options
   */
  function spawn(command, args = [], options = {}) {
    const child = new FakeChild(respond(command, args))
    calls.push({ command, args, options, child })
    return child
  }

  return { spawn, calls }
}

/**
 * Resolves once `predicate` holds, polling briefly; for outcomes that arrive
 * after a child's scripted exit.
 *
 * @param {() => boolean} predicate
 */
export async function until(predicate, timeoutMs = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
