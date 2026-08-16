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
 * Two named options may follow, in either order, and either on its own:
 *
 *   FT_SABR_WALL=10:never:backoff=4  every refusal also asks us to wait four
 *                                    seconds before asking again
 *   FT_SABR_WALL=10:1:status=3       the token is rejected outright rather
 *                                    than left pending
 *
 * `backoff` is what makes the loop detector countable. It counts backoffs
 * within a single segment request and only a refused request retries inside
 * itself, so a refusal is the one place a backoff can be injected from and
 * still be counted: three of them used to reload the whole watch page on the
 * spot, one request before the credential refresh that would have fixed it
 * invisibly (`thoughts/2026-08-16-sabr-backoff-loop-page-reload.md`). Injecting
 * one reproduces that race exactly, so what the buffer now decides can be
 * watched rather than reasoned about.
 *
 * `status` picks which refusal to imitate. 2, the default, is an attestation
 * still pending: it carries a retry directive, so it is not a wall until those
 * retries are spent. 3 is a token the server has rejected, which carries no
 * directive at all and enters the ladder at once, since only a different token
 * can change that answer.
 *
 * Responses are rewritten rather than prevented, so everything downstream runs
 * exactly as it does against a real wall: the server's media is read and then
 * discarded, so the buffer drains at playback speed just as it really would.
 *
 * Like the subscription failure injection, the flag is baked in by
 * DefinePlugin because the renderer has no runtime `process.env`, and the
 * whole module disappears from a build that does not set it.
 */

/**
 * Says why a setting was thrown away, rather than starting a test run that
 * quietly proves nothing. A typo here costs an evening otherwise, since the
 * only symptom is a wall that never arrives.
 * @param {string} raw
 * @param {string} because
 * @returns {null}
 */
function refuseConfig(raw, because) {
  console.error(`[SABR recovery] FT_SABR_WALL="${raw}" ignored: ${because}. Expected <seconds>[:<credentials>|never][:backoff=<seconds>][:status=<2|3>]`)

  return null
}

const CONFIG = (() => {
  const raw = process.env.FT_SABR_WALL

  if (!raw || raw === '0' || raw === 'false') { return null }

  const [delayText, credentialsText = '1', ...optionTexts] = String(raw).split(':')
  const delaySeconds = Number.parseFloat(delayText)

  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    return refuseConfig(raw, `"${delayText}" is not a number of seconds`)
  }

  const credentialsUntilTrusted = credentialsText === 'never'
    ? Number.POSITIVE_INFINITY
    : Number.parseInt(credentialsText)

  if (!(credentialsUntilTrusted > 0)) {
    return refuseConfig(raw, `"${credentialsText}" is neither a count of credential sets nor "never"`)
  }

  let backoffMs = 0
  let protectionStatus = 2

  // Named rather than positional, so that either can be given alone and so
  // that a command line still says what it does a month later
  for (const optionText of optionTexts) {
    const [name, value] = optionText.split('=')

    switch (name) {
      case 'backoff': {
        const backoffSeconds = Number.parseFloat(value)

        if (!Number.isFinite(backoffSeconds) || backoffSeconds < 0) {
          return refuseConfig(raw, `backoff "${value}" is not a number of seconds`)
        }

        backoffMs = backoffSeconds * 1000
        break
      }
      case 'status': {
        protectionStatus = Number.parseInt(value)

        if (protectionStatus !== 2 && protectionStatus !== 3) {
          return refuseConfig(raw, `status "${value}" is neither 2 (attestation pending) nor 3 (token rejected)`)
        }

        break
      }
      default: {
        return refuseConfig(raw, `"${optionText}" is not one of backoff=<seconds> or status=<2|3>`)
      }
    }
  }

  return { delayMs: delaySeconds * 1000, credentialsUntilTrusted, backoffMs, protectionStatus }
})()

export const sabrWallInjectionEnabled = CONFIG !== null

if (CONFIG !== null) {
  const needed = CONFIG.credentialsUntilTrusted === Number.POSITIVE_INFINITY
    ? 'nothing will satisfy it'
    : `lifting after ${CONFIG.credentialsUntilTrusted} fresh credentials`

  const refusal = CONFIG.protectionStatus === 3 ? 'as a rejected token' : 'as a pending attestation'
  const backoff = CONFIG.backoffMs > 0 ? `, asking for ${CONFIG.backoffMs / 1000}s of backoff each time` : ''

  console.warn(
    `[SABR recovery] WALL INJECTION ACTIVE: sessions wall ${CONFIG.delayMs / 1000}s in ${refusal}${backoff}, ${needed}. Unset FT_SABR_WALL to stop.`
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
 * Which refusal a walled response should carry: 2 for an attestation still
 * pending, 3 for a token the server has rejected.
 * @returns {number}
 */
export function injectedProtectionStatus() {
  return CONFIG?.protectionStatus ?? 2
}

/**
 * How long the simulated server asks us to wait before the next request, or 0
 * when it is not configured to ask at all.
 * @returns {number}
 */
export function injectedBackoffMs() {
  return CONFIG?.backoffMs ?? 0
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
