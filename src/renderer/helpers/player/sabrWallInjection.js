/**
 * Makes YouTube pretend to distrust our PO token, so the recovery ladder can
 * be exercised on demand.
 *
 * The real thing arrives when it feels like it. An evening of trying can
 * produce a dozen episodes that all clear on the first credential refresh, and
 * none that reach the rungs above it, which leaves the interesting half of the
 * ladder untested. Playing at double speed and forcing a higher definition,
 * both of which used to provoke it, stopped provoking it.
 *
 * Set `FT_SABR_WALL` when launching:
 *
 *   FT_SABR_WALL=10        wall the session ten seconds in, until one fresh
 *                          set of credentials has been installed
 *   FT_SABR_WALL=10:3      the same, but three sets are needed
 *   FT_SABR_WALL=10:never  nothing ever satisfies it, which drives the ladder
 *                          all the way to the error screen and its retry
 *
 * Credentials count whether they came from a refresh underneath the running
 * session or from a session rebuilt around them, so the second number chooses
 * which rung of the ladder is allowed to succeed: one is a plain refresh, and
 * a number larger than the refreshes the buffer allows forces a rebuild.
 *
 * The delay matters as much as the count: a session that walls before it has
 * buffered anything tests the floor, and one that walls with a full buffer
 * tests the patience the buffer buys.
 *
 * Responses are rewritten rather than prevented, so everything downstream runs
 * exactly as it does against a real wall: the server's media is read and then
 * discarded, so the buffer drains at playback speed just as it really would.
 *
 * Like the subscription failure injection, the flag is baked in by
 * DefinePlugin because the renderer has no runtime `process.env`, and the
 * whole module disappears from a build that does not set it.
 */

const CONFIG = (() => {
  const raw = process.env.FT_SABR_WALL

  if (!raw || raw === '0' || raw === 'false') { return null }

  const [delayText, credentialsText = '1'] = String(raw).split(':')
  const delaySeconds = Number.parseFloat(delayText)

  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) { return null }

  const credentialsUntilTrusted = credentialsText === 'never'
    ? Number.POSITIVE_INFINITY
    : Number.parseInt(credentialsText)

  if (!(credentialsUntilTrusted > 0)) { return null }

  return { delayMs: delaySeconds * 1000, credentialsUntilTrusted }
})()

export const sabrWallInjectionEnabled = CONFIG !== null

if (CONFIG !== null) {
  const needed = CONFIG.credentialsUntilTrusted === Number.POSITIVE_INFINITY
    ? 'nothing will satisfy it'
    : `lifting after ${CONFIG.credentialsUntilTrusted} fresh credentials`

  console.warn(
    `[SABR recovery] WALL INJECTION ACTIVE: sessions wall ${CONFIG.delayMs / 1000}s in, ${needed}. Unset FT_SABR_WALL to stop.`
  )
}

/** Fresh credentials installed since the wall was raised. */
let credentialsInstalled = 0

/**
 * When the current session first served anything, or null if it has not.
 *
 * The delay is counted from here rather than from when the session was built,
 * because building one takes several seconds during which it plays nothing. A
 * session whose grace expired while it was still starting up walls a second
 * after it recovers, which no real server does and which made every rebuilt
 * session look like an immediate failure.
 * @type {?number}
 */
let servingSince = null

/**
 * Records that a fresh set of credentials is in use, whether from a refresh
 * underneath the running session or from a rebuilt one. Enough of them lift
 * the simulated wall.
 */
export function noteCredentialsInstalled() {
  if (CONFIG === null) { return }

  credentialsInstalled += 1
}

/**
 * Starts a new video with the wall back up, so one test does not depend on
 * what the previous one spent.
 */
export function resetWallInjection() {
  if (CONFIG === null) { return }

  credentialsInstalled = 0
  servingSince = null
}

/**
 * Starts a session's grace period over, to be counted from the first thing it
 * manages to serve.
 */
export function noteSessionStarted() {
  if (CONFIG === null) { return }

  servingSince = null
}

/**
 * Records that the session is serving, which is when its grace begins.
 */
export function noteSessionServing() {
  if (CONFIG === null || servingSince !== null) { return }

  servingSince = Date.now()
}

/**
 * Whether this response should be rewritten as a walled one.
 * @param {number} sessionStartedAt
 * @returns {boolean}
 */
export function shouldInjectWall(sessionStartedAt) {
  if (CONFIG === null) { return false }
  if (credentialsInstalled >= CONFIG.credentialsUntilTrusted) { return false }

  // A session that has served nothing has no grace to run down, so a delay of
  // zero walls it from its first request and any other delay lets it start
  return Date.now() - (servingSince ?? sessionStartedAt) >= CONFIG.delayMs
}
