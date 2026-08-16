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
 *   FT_SABR_WALL=10:never  nothing ever satisfies it, so the wall keeps coming
 *                          back ten seconds into every session it walls
 *   FT_SABR_WALL=0:never   nothing ever plays, which is what drives the ladder
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
 * It also decides whether `never` ever ends, which is not what this file used
 * to claim. A rebuilt session gets its delay over again, so at any delay above
 * zero it serves for that long, ATTESTATION_RECOVERY_SEGMENTS reads ten served
 * segments as the video playing again, and the budgets go back to full. The
 * ladder then cycles indefinitely and never reaches its top: measured on
 * 2026-08-16 at `15:never:backoff=4`, four minutes of unbroken playback, three
 * session rebuilds each logged as "reload 1 of 2", no page reload. That is the
 * ladder behaving correctly under an intermittent wall, but it is not a test
 * of the rungs above the rebuild, and only a delay of zero is.
 *
 * Two named options may follow, in either order, and either on its own:
 *
 *   FT_SABR_WALL=10:never:backoff=4  every refusal also asks us to wait four
 *                                    seconds before asking again
 *   FT_SABR_WALL=10:1:status=3       the token is rejected outright rather
 *                                    than left pending
 *   FT_SABR_WALL=0:never:patience=20 escalate after twenty seconds of refreshing
 *                                    rather than the usual eighty five
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
 * `patience` lowers the bound on in place credential refreshing, which is how
 * long a test has to sit through before the ladder climbs. A session that has
 * never served has no runway, so the buffer test cannot fire and that bound is
 * the only gate: eighty five seconds per rung is nearly six minutes to walk
 * the whole ladder. Twenty makes the same walk take a quarter of the time and
 * reaches every rung by the same path.
 *
 * It is the one option that changes a tuned number rather than imitating the
 * server, so it is for testing structure, not thresholds. A run that is meant
 * to say something about how patient the ladder should be must leave it alone,
 * and so must any run where the buffer is supposed to decide first.
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
  console.error(`[SABR recovery] FT_SABR_WALL="${raw}" ignored: ${because}. Expected <seconds>[:<credentials>|never][:backoff=<seconds>][:status=<2|3>][:patience=<seconds>]`)

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
  let patienceSeconds = 0

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
      case 'patience': {
        patienceSeconds = Number.parseFloat(value)

        if (!(patienceSeconds > 0)) {
          return refuseConfig(raw, `patience "${value}" is not a number of seconds`)
        }

        break
      }
      default: {
        return refuseConfig(raw, `"${optionText}" is not one of backoff=<seconds>, status=<2|3> or patience=<seconds>`)
      }
    }
  }

  return { delayMs: delaySeconds * 1000, credentialsUntilTrusted, backoffMs, protectionStatus, patienceSeconds }
})()

export const sabrWallInjectionEnabled = CONFIG !== null

if (CONFIG !== null) {
  const needed = CONFIG.credentialsUntilTrusted === Number.POSITIVE_INFINITY
    ? 'nothing will satisfy it'
    : `lifting after ${CONFIG.credentialsUntilTrusted} fresh credentials`

  const refusal = CONFIG.protectionStatus === 3 ? 'as a rejected token' : 'as a pending attestation'
  const backoff = CONFIG.backoffMs > 0 ? `, asking for ${CONFIG.backoffMs / 1000}s of backoff each time` : ''
  const patience = CONFIG.patienceSeconds > 0 ? `, escalating after ${CONFIG.patienceSeconds}s of refreshing instead of the usual number` : ''

  console.warn(
    `[SABR recovery] WALL INJECTION ACTIVE: sessions wall ${CONFIG.delayMs / 1000}s in ${refusal}${backoff}${patience}, ${needed}. Unset FT_SABR_WALL to stop.`
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
 * How long a walled session may go on refreshing its credentials before the
 * ladder escalates, when a test has asked for less than the tuned number of
 * seconds. Zero means it has not, and the real bound stands.
 * @returns {number}
 */
export function injectedPatienceSeconds() {
  return CONFIG?.patienceSeconds ?? 0
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
