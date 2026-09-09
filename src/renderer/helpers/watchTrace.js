/* eslint-disable no-console -- writing to the console is this module's entire purpose */

const enabled = !['', '0', 'false'].includes(process.env.FT_WATCH_TRACE)

/**
 * Opt-in trace of the watch page's parsing stages, enabled at build time with
 * `FT_WATCH_TRACE=1`. Called from inside error handlers, so it must never be
 * the thing that throws: a detail that cannot be serialised is reported as
 * such rather than losing the stage name too.
 * @param {string} stage
 * @param {Record<string, unknown>} details
 */
export function traceWatch(stage, details = {}) {
  if (!enabled) { return }

  let serialised

  try {
    serialised = JSON.stringify(details)
  } catch (error) {
    serialised = `<unserialisable details: ${error}>`
  }

  console.log(`[watch-trace] ${stage} ${serialised}`)
}
