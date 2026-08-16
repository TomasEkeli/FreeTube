import shaka from 'shaka-player'

import { createSabrSession } from './SabrSchemePlugin'

const AbortableOperation = shaka.util.AbortableOperation

/**
 * @typedef PlayerContext
 * @type {object}
 * @property {() => shaka.Player} getPlayer
 * @property {() => shaka.extern.Manifest} getManifest
 * @property {import('vue').ComputedRef<number>} playerWidth
 * @property {import('vue').ComputedRef<number>} playerHeight
 */

/**
 * @typedef SabrRegulator
 * @type {object}
 * @property {(sabrData: import('../../views/Watch/Watch').SabrData) => import('./SabrSchemePlugin').SabrSession} startSession
 * @property {() => ?import('./SabrSchemePlugin').SabrSession} getSession
 * @property {() => void} release
 */

/**
 * The name of the scheme every SABR segment URL is written against, in the
 * manifest the SABR manifest parser builds. Shaka's registry holds exactly one
 * handler per scheme name, process wide.
 */
const SABR_SCHEME = 'sabr'

/**
 * Owns the `sabr://` scheme slot for as long as the player exists, and routes
 * every segment request to the session it is currently serving from.
 *
 * The slot used to belong to a session, which is the wrong way round: a
 * session is the shortest lived thing in the player, so replacing one meant
 * giving the slot up and taking it again, and nothing could be routed in
 * between. That is why a session rebuild has to unload the player first, and
 * why unloading throws the buffer away for the viewer to watch drain. An owner
 * that outlives its sessions can hold the slot steady and decide, per request,
 * which session answers.
 *
 * This is only the ownership change: there is still exactly one session at a
 * time, and every policy decision is still where it was.
 *
 * @param {PlayerContext} playerContext everything a session needs to describe
 * the player it is serving. The same for every session, since they all serve
 * the same player, which is why the regulator holds it rather than the caller
 * passing it again per session.
 * @returns {SabrRegulator}
 */
export function createSabrRegulator(playerContext) {
  /** @type {?import('./SabrSchemePlugin').SabrSession} */
  let currentSession = null

  /** Whether the scheme slot is ours right now, so it is claimed once and released once */
  let holdsScheme = false

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

  return {
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

      currentSession = /** @__NOINLINE__ */ createSabrSession(
        sabrData,
        playerContext.getPlayer,
        playerContext.getManifest,
        playerContext.playerWidth,
        playerContext.playerHeight,
      )

      claimScheme()

      return currentSession
    },

    getSession() {
      return currentSession
    },

    /**
     * Gives up the scheme slot and finishes the session behind it. The slot is
     * process-global, so a regulator that is not released leaks its handler
     * into whatever plays next.
     */
    release() {
      if (holdsScheme) {
        shaka.net.NetworkingEngine.unregisterScheme(SABR_SCHEME)
        holdsScheme = false
      }

      currentSession?.cleanup()
      currentSession = null
    },
  }
}
