import shaka from 'shaka-player'

import { createSabrSession } from './SabrSchemePlugin'
import { injectedPatienceSeconds, noteCredentialsInstalled, noteSessionStarted, resetWallInjection, sabrWallInjectionEnabled } from './sabrWallInjection'

const AbortableOperation = shaka.util.AbortableOperation

/**
 * Everything the regulator needs from the player it is serving, including
 * where to report an episode of recovery starting and ending. The callbacks
 * travel with the context rather than through subscriptions on purpose: the
 * regulator outlives players, so a subscription list would grow by one dead
 * player on every format switch and every reload, and nothing would ever
 * remove them.
 * @typedef PlayerContext
 * @type {object}
 * @property {() => shaka.Player} getPlayer
 * @property {() => shaka.extern.Manifest} getManifest
 * @property {import('vue').ComputedRef<number>} playerWidth
 * @property {import('vue').ComputedRef<number>} playerHeight
 * @property {() => void} [onRecoveryStarted]
 * @property {() => void} [onRecoveryEnded]
 */

/**
 * @typedef SabrRegulator
 * @type {object}
 * @property {{ name: string, maxSessions: number, warmStandby: boolean }} policy
 * @property {(playerContext: PlayerContext) => void} attach
 * @property {(sabrData: import('../../views/Watch/Watch').SabrData) => import('./SabrSchemePlugin').SabrSession} startSession
 * @property {() => ?import('./SabrSchemePlugin').SabrSession} getSession
 * @property {() => boolean} isRecovering
 * @property {() => void} noteRebuildSettled
 * @property {() => boolean} rebuildWasSuperseded
 * @property {(videoId: string) => void} resetBudget
 * @property {(videoId: string) => void} reset
 * @property {() => void} detach
 */

/**
 * What a session may report, and every answer it may be given.
 * @typedef SabrRecovery
 * @type {object}
 * @property {() => void} noteMediaServed
 * @property {(facts: { hasServedMedia: boolean, sessionEnded: boolean }) => RecoveryDecision} decideOnRefusal
 * @property {() => void} noteRefreshStarted
 * @property {(facts: { description: string, hasServedMedia: boolean, sessionEnded: boolean }) => RecoveryDecision} decideOnLoopSuspicion
 */

/**
 * What the regulator answers a session with. The session performs it, because
 * each remedy destroys state at a different radius and only its owner can
 * destroy it; the regulator decides and delegates rather than acting.
 *
 * `log` is the line to print, already prefixed. The session prints it rather
 * than the regulator, because at the loop suspicion site the same decision can
 * be reached many times within one request and the request is what knows
 * whether it has said this already. Episode transitions are the exception and
 * are printed here: they belong to the video, not to any request.
 *
 * @typedef RecoveryDecision
 * @type {object}
 * @property {'run-on' | 'refresh' | 'rebuild' | 'reload-page' | 'give-up' | 'abort'} action
 * @property {?string} log
 * @property {SabrGiveUpError} [error] the verdict itself, for a 'give-up'
 */

/**
 * The regulator's verdict that nothing left to it can make this session play,
 * carried as a type rather than as a message. The watch view matches on it to
 * show a real error instead of cycling formats, and that match is the only
 * thing standing between a refused session and a format ring that cannot help
 * it, so it should not rest on two copies of a sentence staying identical.
 */
export class SabrGiveUpError extends Error {
  constructor() {
    super('YouTube did not accept the PO token for this session')
    this.name = 'SabrGiveUpError'
  }
}

/**
 * The name of the scheme every SABR segment URL is written against, in the
 * manifest the SABR manifest parser builds. Shaka's registry holds exactly one
 * handler per scheme name, process wide.
 */
const SABR_SCHEME = 'sabr'

/**
 * One prefix for the whole recovery ladder, so a single search of the log
 * says what happened and which rung fixed it.
 */
const RECOVERY_LOG = '[SABR recovery]'

/**
 * How many credential refreshes to always try before anything heavier.
 *
 * One, because a fresh token is cheap and often enough, and because every
 * refresh after it spends about ten seconds of the runway that the escalation
 * needs to land in. This was three, on the reasoning that a session walled
 * before it buffered anything has nothing to lose by trying again, which had
 * it backwards: nothing left to play means the viewer is already stopped, and
 * that is when reaching the remedy that works matters most. Three refreshes
 * put the earliest possible rebuild thirty seconds after the wall, by which
 * time no threshold could have saved the playback.
 */
const ATTESTATION_REFRESH_FLOOR = 1

/**
 * How little watching time must remain before rebuilding the session beats
 * refreshing the credentials again.
 *
 * Small, and deliberately so. Rebuilding unloads the player, which throws the
 * buffer away rather than playing through it, so the gap it costs is its own
 * duration however much was buffered. Twenty five seconds was tried on the
 * assumption that the buffer would cover the rebuild; it cannot, and a rebuild
 * with 18.4s in hand stalled exactly as one with none would.
 *
 * Since the gap is the same whenever it is taken, the buffer is worth nothing
 * except the refreshes it pays for, and those are the only remedy the viewer
 * never sees. So spend it all on them, and rebuild only once it is nearly gone
 * and there is nothing left to lose by discarding it.
 */
const ATTESTATION_LOW_BUFFER_SECONDS = 8

/**
 * Hard stop on refreshing regardless of buffer, in real seconds. A paused
 * player never drains its buffer, and a session that has never served has no
 * buffer to drain, so without this the ladder would refresh for as long as
 * YouTube kept saying no.
 *
 * This was a count of twelve refreshes, and a count is the wrong unit. What is
 * being bounded is patience — how long the viewer is left waiting before
 * something heavier is tried — but refusals arrive at the rate the player asks
 * for segments, so the count is spent at the playback rate while the runway it
 * is standing in for drains at one real second per real second. Measured on
 * 2026-08-16: twelve refreshes took 85 seconds at 1x and escalated on the
 * buffer as designed, and 49 seconds at 2x, where the count ran out first and
 * escalated with 23 seconds of watching still in hand. A ceiling tuned against
 * a 1x cadence therefore fired earliest for exactly the viewers who speed
 * videos up.
 *
 * 85 seconds is not a new judgement about how patient to be: it is what the
 * old count already meant at the rate it was tuned at, so 1x behaviour is
 * unchanged and only the rate dependence is gone. Whether 85 is the right
 * amount of patience is a separate question with its own measurement to make —
 * in particular it is still long enough that a session which never serves
 * spends about six minutes and dozens of PO token mints reaching the give-up
 * screen, which is its own problem and not this one.
 */
const ATTESTATION_PATIENCE_SECONDS = 85

/**
 * How many times to rebuild the SABR session from scratch, keeping the page.
 * This is the automatic version of what a viewer does by reopening a walled
 * video, which is known to work where repeated refreshes do not.
 */
const ATTESTATION_HARD_RELOAD_LIMIT = 2

/**
 * How many times to fall back to reloading the whole watch page. More
 * disruptive than a session reload and no more likely to work, so this is a
 * backstop for the cases a session reload cannot cover, such as the formats
 * changing underneath us.
 */
const ATTESTATION_PAGE_RELOAD_LIMIT = 1

/**
 * How many media bearing responses count as the video genuinely having
 * recovered, at which point the reload budgets are restored. Without a
 * threshold, a video that walled and recovered every half minute would mint
 * itself an unlimited supply of reloads.
 */
const ATTESTATION_RECOVERY_SEGMENTS = 10

/**
 * How long the viewer can keep watching without another byte arriving, in real
 * seconds rather than media seconds. This is the runway recovery has to land
 * in, so it is what decides how patient the in place refresh can afford to be.
 *
 * The distinction matters: buffer is measured in media time, but it is spent
 * at the playback rate, so ten seconds of it lasts a little over three at
 * triple speed. Treating the two as the same made every escalation late, and
 * latest exactly for the viewers who had sped the video up.
 * @param {?shaka.Player} player
 * @returns {number}
 */
function secondsOfPlaybackLeft(player) {
  const media = player?.getMediaElement()

  if (typeof media?.currentTime !== 'number') return 0

  const currentTime = media.currentTime

  // `total` is the intersection across the active streams, which is exactly
  // what playback can continue on
  for (const { start, end } of player.getBufferedInfo().total) {
    if (start <= currentTime && currentTime < end) {
      return (end - currentTime) / Math.max(media.playbackRate || 1, 0.1)
    }
  }

  return 0
}

/**
 * What the classic/regulated switch actually selects.
 *
 * **Not two implementations.** There is one regulator and one transport, and
 * the setting chooses a policy for them. Two code paths would be the trap: with
 * one user a second path is exercised approximately never, and rots into dead
 * code that complicates every change while providing no safety.
 *
 * **Every bug fix stays in force on both policies.** Classic means "one
 * session, escalate as the ladder does, no pool, no standby" — the behaviour
 * this fork has after 2026-08-16, which is upstream's structure with its bugs
 * removed. It emphatically does not mean upstream's behaviour: nerfing it back
 * would re-introduce a page reload on a full buffer, a dead end on a rejected
 * token, and a dead player on a missing legacy format, which is not a fallback
 * but a regression with a setting attached.
 *
 * **The two are currently identical, and that is the point of building this
 * now rather than later.** Phases 1 and 2 moved ownership without changing
 * behaviour, so there is nothing yet for the policies to differ on. Phase 3 is
 * what makes them differ, and it can only land by raising these numbers under
 * `regulated`. Had the switch been added afterwards it would have been
 * retrofitted around code that already assumed it was not there.
 *
 * So: do not simplify these two branches together because they look the same.
 * The sameness is temporary and the branch is the seam phase 3 lands on.
 *
 * @param {boolean} regulated
 * @returns {{ name: string, maxSessions: number, warmStandby: boolean }}
 */
function recoveryPolicy(regulated) {
  return {
    name: regulated ? 'regulated' : 'classic',

    /**
     * How many SABR sessions the regulator may hold at once. Phase 3 raises
     * this to 2 under `regulated` so that rung 1 can promote a standby rather
     * than tearing the player down, which is where the whole eight to ten
     * second gap lives.
     */
    maxSessions: 1,

    /**
     * Whether rung 1 warms a replacement session before it is needed. Bounded
     * and never run against a healthy session when it does exist: a standby is
     * a second session fetching real segments, against a host that is already
     * rate limiting at exactly the moment recovery is wanted.
     */
    warmStandby: false,
  }
}

/**
 * Owns the `sabr://` scheme slot, routes every segment request to the session
 * it is currently serving from, and makes every recovery decision for the
 * video being played.
 *
 * The slot used to belong to a session, which is the wrong way round: a
 * session is the shortest lived thing in the player, so replacing one meant
 * giving the slot up and taking it again, and nothing could be routed in
 * between. That is why a session rebuild has to unload the player first, and
 * why unloading throws the buffer away for the viewer to watch drain. An owner
 * that outlives its sessions can hold the slot steady and decide, per request,
 * which session answers.
 *
 * The recovery decisions live here for a related reason. They used to be spread
 * across six layers, each with its own idea of what to do when YouTube stops
 * cooperating and none able to see the others' decisions, and every recovery
 * bug found so far has been two of those layers each believing it owned the
 * answer. Sessions now report what happened and are told what to do about it.
 *
 * **This belongs to the watch view, not to the player.** The ladder's own
 * remedies decide that: rung 1 rebuilds the session and rung 2 reloads the
 * player, so a regulator owned by either would have its budgets destroyed by
 * the very thing they bound, and a budget that resets when it fires bounds
 * nothing. The view survives both — `reloadView` is one of its own methods,
 * and the router reuses the instance across a query or param change — and it
 * dies when the viewer leaves the watch page, which is exactly when the
 * ladder should be forgotten. That is why these counters can be ordinary
 * state here, having been module-global for as long as a network scheme
 * plugin owned them.
 *
 * @param {object} [options]
 * @param {() => boolean} [options.isRegulated] reads the experimental setting.
 *
 * A function rather than a value, and consulted when the video changes rather
 * than when the regulator is built. Built-time was wrong and the log said so:
 * the router reuses the watch view across a param change, so `created` runs
 * once and the policy would have been fixed for as long as the viewer stayed
 * on watch pages — which is to say, effectively for the session. Per video is
 * both what the setting promises and the only moment at which changing it is
 * safe, since every rung of the ladder is mid-video by definition.
 * @returns {SabrRegulator}
 */
export function createSabrRegulator({ isRegulated = () => false } = {}) {
  let policy = recoveryPolicy(isRegulated())

  /**
   * Names the policy in force. Every watched run and every ordinary use
   * collection has to say which one produced it, or the two cannot be told
   * apart afterwards.
   */
  function announcePolicy() {
    console.warn(`${RECOVERY_LOG} ${policy.name} policy: at most ${policy.maxSessions} session, ${policy.warmStandby ? 'warming a standby' : 'no standby'}`)
  }

  announcePolicy()

  /**
   * The player currently being served, or null between one being torn down and
   * the next attaching. A page reload leaves the regulator briefly playerless,
   * which is the whole point of it outliving the player.
   * @type {?PlayerContext}
   */
  let playerContext = null

  /** @type {?import('./SabrSchemePlugin').SabrSession} */
  let currentSession = null

  /** Whether the scheme slot is ours right now, so it is claimed once and released once */
  let holdsScheme = false

  /**
   * Whether a session rebuild this authorised has yet to come to anything.
   *
   * A rebuild is not finished when the new session starts: the player has to
   * load against it, and under a wall that never lifts that load never
   * resolves, because the init segment it waits for never arrives. The
   * rebuilt session meanwhile keeps being refused and keeps climbing the
   * ladder, and used to ask for a second rebuild on top of the first. The
   * player refused the collision and reloaded the page itself, which the
   * ladder had not authorised and did not count, so its own page reload was
   * still unspent and fired ninety seconds later: two page reloads, from two
   * owners that could not see each other. Measured 2026-08-16 at
   * FT_SABR_WALL=0:never.
   */
  let rebuildUnsettled = false

  /**
   * Whether a decision larger than a rebuild was taken while a rebuild was
   * still outstanding, so the player is waiting on a load that this has just
   * killed. It has to be able to tell that from a rebuild that simply failed,
   * because its answer to a failure is to reload the page, and doing that in
   * answer to a verdict turns "there is nothing left to try" into another
   * reload that nobody counted and an error screen the viewer never sees.
   */
  let rebuildSuperseded = false

  /**
   * The recovery ladder's state for the video being watched. Reset when the
   * video changes, and when the viewer asks for a retry themselves.
   */
  const ladder = {
    /** @type {?string} */
    videoId: null,
    refreshes: 0,
    /**
     * When this session first started refreshing, which is when the clock the
     * patience bound reads begins. Null while nothing is being refreshed.
     *
     * It belongs to the session rather than to the episode, exactly as the
     * refresh count above does: a session rebuilt to recover the last one gets
     * a full budget, because carrying a spent one into a fresh session made
     * every attempt after the first give up on its first block.
     * @type {?number}
     */
    patienceSince: null,
    hardReloads: 0,
    pageReloads: 0,
    mediaResponsesSinceReload: 0,
    /** Whether an episode of this is under way, so its end can be reported */
    recovering: false,
    /**
     * Refreshes made during the current episode. Separate from the budget
     * counter above, which a trusted token clears the moment it arrives,
     * usually in the same response as the media that ends the episode.
     */
    refreshesThisEpisode: 0,
  }

  /**
   * Gives the session a full refresh budget back: the count the floor reads
   * and the clock the patience bound reads, which have to move together or the
   * bound outlives the thing it is bounding.
   */
  function restoreRefreshBudget() {
    ladder.refreshes = 0
    ladder.patienceSince = null
  }

  function resetBudget(videoId) {
    ladder.videoId = videoId
    restoreRefreshBudget()
    ladder.hardReloads = 0
    ladder.pageReloads = 0
    ladder.mediaResponsesSinceReload = 0
    ladder.recovering = false
    ladder.refreshesThisEpisode = 0
  }

  /**
   * Gives up the scheme slot, the session behind it and the player they were
   * serving. The ladder is deliberately untouched: this is usually the first
   * half of a remedy the ladder itself chose, and a budget that forgot itself
   * at that moment would bound nothing.
   */
  function giveUpPlayer() {
    if (holdsScheme) {
      shaka.net.NetworkingEngine.unregisterScheme(SABR_SCHEME)
      holdsScheme = false
    }

    currentSession?.cleanup()
    currentSession = null
    playerContext = null
    rebuildUnsettled = false
    rebuildSuperseded = false
  }

  function claimScheme() {
    if (holdsScheme) { return }

    shaka.net.NetworkingEngine.registerScheme(SABR_SCHEME, (uri, request, requestType, progressUpdated, headersReceived, config) => {
      if (!currentSession) {
        // Only reachable between releasing the last session and unregistering,
        // which nothing awaits in between, so this is a guard rather than a
        // path. Resolving empty is what the handler already does when there is
        // no player, and is quieter than failing a request nobody is waiting
        // on any more.
        return new AbortableOperation(Promise.resolve())
      }

      return currentSession.handleRequest(uri, request, requestType, progressUpdated, headersReceived, config)
    })

    holdsScheme = true
  }

  /**
   * Ends the recovery episode, if one was under way, and says how it went.
   * @param {string} outcome
   */
  function endEpisode(outcome) {
    if (!ladder.recovering) { return }

    ladder.recovering = false
    playerContext?.onRecoveryEnded?.()

    console.warn(`${RECOVERY_LOG} ${outcome}`)
    ladder.refreshesThisEpisode = 0
  }

  /**
   * Rungs 1 and 2: rebuild the SABR session, and once that budget is spent,
   * reload the watch page. Both cost the viewer the buffer, so both callers
   * reach here only once playback is about to stall anyway, and both draw on
   * the same budgets, which belong to the video rather than to whatever
   * noticed the trouble.
   *
   * Returns null when every budget is spent. What comes after the ladder
   * differs by who climbed it, so that answer is the caller's.
   * @param {string} reason for the log line
   * @returns {?RecoveryDecision}
   */
  function escalate(reason) {
    // Rebuilding the session is what a viewer does by hand when they reopen a
    // walled video, and it succeeds where refreshing the credentials
    // underneath a running session does not. Why is not established: a reload
    // both takes longer and starts a genuinely new session, and we cannot yet
    // tell which of the two is the cure.
    if (!rebuildUnsettled && ladder.hardReloads < ATTESTATION_HARD_RELOAD_LIMIT) {
      ladder.hardReloads += 1
      ladder.mediaResponsesSinceReload = 0
      rebuildUnsettled = true
      rebuildSuperseded = false

      return {
        action: 'rebuild',
        log: `${RECOVERY_LOG} ${reason}, rebuilding the session (reload ${ladder.hardReloads} of ${ATTESTATION_HARD_RELOAD_LIMIT})`,
      }
    }

    if (ladder.pageReloads < ATTESTATION_PAGE_RELOAD_LIMIT) {
      ladder.pageReloads += 1
      ladder.mediaResponsesSinceReload = 0

      // Naming which of the two it is matters: one says the rebuilds did not
      // work, the other says the last one never got to try
      const why = rebuildUnsettled
        ? 'the last session reload never finished loading'
        : 'session reloads spent'

      rebuildSuperseded = rebuildUnsettled

      return {
        action: 'reload-page',
        log: `${RECOVERY_LOG} ${reason}, ${why}, reloading the page`,
      }
    }

    return null
  }

  /**
   * Everything a session may report, and every answer it may be given. A
   * session decides nothing about recovery; it says what the server did and
   * does as it is told.
   */
  const recovery = {
    /**
     * The server served media, which is the only proof that recovery worked.
     * Enough of it restores the reload budgets.
     */
    noteMediaServed() {
      rebuildUnsettled = false

      endEpisode(
        `playing again after ${ladder.refreshesThisEpisode} refreshes, ` +
        `${ladder.hardReloads} session reloads and ${ladder.pageReloads} page reloads`
      )

      restoreRefreshBudget()

      if (ladder.mediaResponsesSinceReload < ATTESTATION_RECOVERY_SEGMENTS) {
        ladder.mediaResponsesSinceReload += 1

        if (ladder.mediaResponsesSinceReload === ATTESTATION_RECOVERY_SEGMENTS) {
          ladder.hardReloads = 0
          ladder.pageReloads = 0
        }
      }
    },

    /**
     * The server answered without media because it does not trust the PO
     * token. Retrying sends an identical request, so it cannot succeed; a
     * fresh token sometimes is trusted, and that is rung 0 of the ladder.
     *
     * @param {object} facts
     * @param {boolean} facts.hasServedMedia whether this session has ever served
     * @param {boolean} facts.sessionEnded whether this session has already been ended for a recovery
     * @returns {RecoveryDecision}
     */
    decideOnRefusal({ hasServedMedia, sessionEnded }) {
      const playbackLeft = secondsOfPlaybackLeft(playerContext?.getPlayer())

      // A session that has not served anything yet has an empty buffer because
      // it has not started, not because it is about to stop, and reading that
      // as an imminent stall makes every fresh session escalate on its first
      // block. Rebuilding one rebuilt a moment ago is the one thing that
      // cannot help.
      const runwayIsMeaningful = hasServedMedia

      // Refreshing costs the viewer nothing for as long as the buffer covers
      // playback, so there is no reason to stop while it does. Once the buffer
      // is nearly gone the video is about to stall whatever we do, which is
      // the moment a more disruptive remedy stops being a downgrade.
      // Only ever lowered when FT_SABR_WALL asks for it, so that walking the
      // whole ladder does not take six minutes of sitting still
      const patienceSeconds = (sabrWallInjectionEnabled && injectedPatienceSeconds()) || ATTESTATION_PATIENCE_SECONDS

      const secondsRefreshing = ladder.patienceSince === null
        ? 0
        : (Date.now() - ladder.patienceSince) / 1000

      const outOfPatience = ladder.refreshes >= ATTESTATION_REFRESH_FLOOR &&
        ((runwayIsMeaningful && playbackLeft < ATTESTATION_LOW_BUFFER_SECONDS) ||
          secondsRefreshing >= patienceSeconds)

      if (!outOfPatience) {
        return { action: 'refresh', log: null }
      }

      // Audio and video reach this together, so the first one to escalate ends
      // the session for both, and the second must not spend a second rung
      if (sessionEnded) {
        return { action: 'abort', log: null }
      }

      const reason = runwayIsMeaningful && playbackLeft < ATTESTATION_LOW_BUFFER_SECONDS
        ? `${playbackLeft.toFixed(1)}s of watching left`
        : `${secondsRefreshing.toFixed(0)}s of refreshing across ${ladder.refreshes} attempts, out of patience`

      const escalation = escalate(reason)

      if (escalation) { return escalation }

      // A rebuild still waiting on a load it will never get is now waiting for
      // nothing, and must not read this as its own failure
      rebuildSuperseded = rebuildUnsettled

      // Audio and video both arrive here, and both have to fail, but the
      // episode only ends once
      endEpisode(`giving up: ${ladder.hardReloads} session reloads and ${ladder.pageReloads} page reloads did not get a trusted token`)

      return { action: 'give-up', log: null, error: new SabrGiveUpError() }
    },

    /**
     * Records that a credential refresh is actually starting, which is what
     * spends the budget. Both the audio and the video request are told to
     * refresh, and only the first of them starts one.
     */
    noteRefreshStarted() {
      ladder.refreshes += 1
      ladder.refreshesThisEpisode += 1

      // The clock starts with the first refresh of this session, not with the
      // refusal that provoked it, so it measures time spent on the remedy
      ladder.patienceSince ??= Date.now()

      if (!ladder.recovering) {
        ladder.recovering = true
        playerContext?.onRecoveryStarted?.()
      }

      const playbackLeft = secondsOfPlaybackLeft(playerContext?.getPlayer())

      console.warn(`${RECOVERY_LOG} PO token not trusted, refreshing credentials (attempt ${ladder.refreshes}, ${playbackLeft.toFixed(1)}s of watching left)`)
    },

    /**
     * The request has been told to wait, or to retry, often enough to look
     * like a loop.
     *
     * Being told to wait is not a fault to be fixed, and while there is
     * something left to play it costs the viewer nothing to do as we are told.
     * If it really never ends, the buffer drains and we come back here in
     * earnest. Upstream reloaded the whole page here on the spot, which
     * discarded a buffer that was usually full.
     *
     * @param {object} facts
     * @param {string} facts.description what was counted, for the log line
     * @param {boolean} facts.hasServedMedia whether this session has ever served
     * @param {boolean} facts.sessionEnded whether this session has already been ended for a recovery
     * @returns {RecoveryDecision}
     */
    decideOnLoopSuspicion({ description, hasServedMedia, sessionEnded }) {
      const playbackLeft = secondsOfPlaybackLeft(playerContext?.getPlayer())

      // A session that has not served anything yet has an empty buffer because
      // it has not started, not because it is about to stop
      const aboutToStall = hasServedMedia && playbackLeft < ATTESTATION_LOW_BUFFER_SECONDS

      if (!aboutToStall) {
        const waitingBecause = hasServedMedia
          ? `${playbackLeft.toFixed(1)}s of watching left`
          : 'this session has not served anything yet, so its empty buffer says nothing'

        return {
          action: 'run-on',
          log: `${RECOVERY_LOG} ${description}, but ${waitingBecause}, so waiting rather than reloading`,
        }
      }

      if (sessionEnded) {
        return { action: 'abort', log: null }
      }

      const escalation = escalate(description)

      if (escalation) { return escalation }

      // A video that has already been rebuilt and reloaded is telling us that
      // the reloading is not what is wrong
      return {
        action: 'run-on',
        log: `${RECOVERY_LOG} ${description}, and every reload is spent, so letting the request run`,
      }
    },
  }

  return {
    /**
     * The policy currently in force. A getter, because it is re-read when the
     * video changes, so a caller that captured it once would be answering with
     * a policy the viewer has since turned off.
     */
    get policy() {
      return policy
    },

    /**
     * Takes charge of a player, and of nothing that belonged to the last one.
     * Called when a player is created, which happens again on every format
     * switch and every page reload while the regulator and its ladder carry
     * on.
     *
     * It re-arms rather than merely accepting, so that whatever state the
     * previous player left behind — a session, the scheme slot, a context
     * pointing at a destroyed player — is given up first. Reloading the player
     * is one of the ladder's own remedies, so a reload has to be able to fix
     * the transport; the counters are the only thing meant to survive it.
     * @param {PlayerContext} context
     */
    attach(context) {
      giveUpPlayer()

      playerContext = context
    },

    /**
     * Builds a session from fresh credentials and serves from it. Any previous
     * session is finished first, in the same order as before the regulator
     * existed: the old one is cleaned up, then the new one is built.
     *
     * Both happen without the scheme slot changing hands, so a request that
     * arrives during the swap is impossible rather than merely unlikely.
     *
     * @param {import('../../views/Watch/Watch').SabrData} sabrData
     * @returns {import('./SabrSchemePlugin').SabrSession}
     */
    startSession(sabrData) {
      currentSession?.cleanup()

      // Same video means the ladder built this one to replace a session that
      // was refused, rather than the viewer opening something
      const isRecoverySession = ladder.videoId === sabrData.videoId

      if (ladder.videoId !== sabrData.videoId) {
        resetBudget(sabrData.videoId)
        resetWallInjection()

        // A new video is the one safe moment to change policy, and the only
        // one the viewer was promised. Mid-video would mean re-policing a
        // ladder already climbing, which every rung is by definition.
        const chosen = recoveryPolicy(isRegulated())

        if (chosen.name !== policy.name) {
          policy = chosen
          announcePolicy()
        }
      } else {
        // Same video, so this session was built to recover the last one, and
        // its credentials are fresh ones the simulated wall should count
        noteCredentialsInstalled()
      }

      noteSessionStarted()

      // A new session gets a full refresh budget, whatever produced it: a new
      // video, the user reopening a walled one, or a recovery reload. Carrying
      // a spent budget into a fresh session made every attempt after the first
      // give up on its first block, which is why reopening a walled video only
      // sometimes helped. The reload budgets deliberately do not reset here,
      // since they are what bounds the ladder.
      restoreRefreshBudget()

      currentSession = /** @__NOINLINE__ */ createSabrSession(
        sabrData,
        recovery,
        playerContext.getPlayer,
        playerContext.getManifest,
        playerContext.playerWidth,
        playerContext.playerHeight,
      )

      claimScheme()

      // The denominator. Every other line under this prefix is something going
      // wrong, so a log full of nothing cannot be told apart from a log of a
      // hundred sessions that all worked — and the question phase 0 exists to
      // answer is a rate, not a count. Saying that a session started, and
      // whether it is a fresh video or a rung of the ladder replacing one,
      // makes both terms readable from the same stream.
      console.warn(`${RECOVERY_LOG} SABR session started for ${sabrData.videoId} under the ${policy.name} policy${isRecoverySession ? ', replacing one that was refused' : ''}`)

      return currentSession
    },

    getSession() {
      return currentSession
    },

    /**
     * The player has finished trying to rebuild the session, whether it worked
     * or not. Until it says so, no second rebuild is authorised: the first one
     * has not had its chance yet, and a rebuild that replaces a rebuild in
     * progress leaves the player loading against a session that no longer
     * exists.
     */
    noteRebuildSettled() {
      rebuildUnsettled = false
      rebuildSuperseded = false
    },

    /**
     * Whether the rebuild the player is running was overtaken by a decision of
     * ours: a page reload, or the end of the ladder. Either way the load it is
     * waiting on has been killed by us rather than having failed, so its own
     * fallback is not the right answer and would be a remedy nobody ordered.
     * @returns {boolean}
     */
    rebuildWasSuperseded() {
      return rebuildSuperseded
    },

    /**
     * Whether the video is currently being recovered. Survives both the
     * session being rebuilt and the player being reloaded, which is how a
     * player built in the middle of an episode knows it has walked into one.
     * @returns {boolean}
     */
    isRecovering() {
      return ladder.recovering
    },

    /**
     * Restores the full recovery budget for a video. Called when the viewer
     * asks for a retry themselves, which is a clear statement that they want
     * the attempt made regardless of what the automatic ladder already spent.
     * @param {string} videoId
     */
    resetBudget,

    /**
     * The player being served is going away: give up the scheme slot and
     * finish the session behind it. The slot is process-global, so a handler
     * left registered answers for whatever plays next.
     *
     * The ladder is deliberately untouched. Detaching is usually the first
     * half of a remedy the ladder itself chose, and a budget that forgot
     * itself at that moment would bound nothing.
     */
    detach: giveUpPlayer,

    /**
     * Back to how it was born, for a viewer who has decided this is broken:
     * no session, no scheme slot, no player, and a full budget. Everything the
     * automatic ladder holds onto across a reload is meant to be spendable
     * exactly once, so the one thing the viewer can do about a regulator that
     * has painted itself into a corner is to say so, and this is what that
     * says.
     * @param {string} videoId
     */
    reset(videoId) {
      giveUpPlayer()
      resetBudget(videoId)
    },
  }
}
