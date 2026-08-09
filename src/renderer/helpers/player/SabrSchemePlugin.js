import { base64ToU8, concatenateChunks, EventEmitterLike, MAX_INT32_VALUE } from 'googlevideo/utils'
import { CompositeBuffer, UmpReader } from 'googlevideo/ump'
import {
  UMPPartId,
  VideoPlaybackAbrRequest,
  StreamProtectionStatus,
  SabrError,
  SabrRedirect,
  MediaHeader,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrContextWritePolicy,
  NextRequestPolicy,
  PlaybackCookie,
  ReloadPlaybackContext,
} from 'googlevideo/protos'
import shaka from 'shaka-player'

import { deepCopy } from '../utils'
import { noteCredentialsInstalled, resetWallInjection, sabrWallInjectionEnabled, shouldInjectWall } from './sabrWallInjection'

const AbortableOperation = shaka.util.AbortableOperation
const ShakaError = shaka.util.Error

/**
 * How many times to retry a segment that the server answered with a
 * NextRequestPolicy and no media, while attestation is pending.
 * Retrying sends a byte identical request, so a high number achieves nothing
 * except hammering the server.
 */
const ATTESTATION_RETRY_LIMIT = 3

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
 * How much watching time must remain for another refresh to be worth more than
 * rebuilding the session.
 *
 * This has to be longer than the remedy it triggers, or the remedy cannot
 * finish before the video stalls and the escalation is pointless. Rebuilding
 * takes six to seven seconds, measured across eight live rebuilds, and a
 * refresh cycle takes about seven, so the last refresh has to be given up on
 * with enough left for both. Fifteen seconds covers a rebuild with room to
 * spare, at the cost of abandoning refreshes that might have worked.
 */
const ATTESTATION_LOW_BUFFER_SECONDS = 15

/**
 * Hard stop on refreshes regardless of buffer. A paused player never drains
 * its buffer, so without this it would refresh for as long as YouTube kept
 * saying no.
 */
const ATTESTATION_REFRESH_CEILING = 12

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
 * One prefix for the whole recovery ladder, so a single search of the log
 * says what happened and which rung fixed it.
 */
const RECOVERY_LOG = '[SABR recovery]'

/**
 * Survives player teardown, so that recovery attempts triggered by a
 * distrusted PO token can be counted across the session reloads and page
 * reloads that destroy everything else. Scoped to a single video.
 */
const attestationState = {
  /** @type {?string} */
  videoId: null,
  refreshes: 0,
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
 * Whether the video is currently being recovered. Survives the session being
 * rebuilt, which is how a new session knows it has walked into an episode that
 * was already under way.
 * @returns {boolean}
 */
export function isAttestationRecovering() {
  return attestationState.recovering
}

/**
 * Restores the full recovery budget for a video. Called when the viewer asks
 * for a retry themselves, which is a clear statement that they want the
 * attempt made regardless of what the automatic ladder already spent.
 * @param {string} videoId
 */
export function resetAttestationBudget(videoId) {
  attestationState.videoId = videoId
  attestationState.refreshes = 0
  attestationState.hardReloads = 0
  attestationState.pageReloads = 0
  attestationState.mediaResponsesSinceReload = 0
  attestationState.recovering = false
  attestationState.refreshesThisEpisode = 0
}

/**
 * The give-up error raised once the refresh budget is spent. The watch view
 * matches on this message to show a real error instead of cycling formats.
 */
export const ATTESTATION_GIVE_UP_MESSAGE = 'YouTube did not accept the PO token for this session'

/**
 * @typedef OperationInputs
 * @type {object}
 * @property {string} uri
 * @property {shaka.extern.Request} request
 * @property {shaka.net.NetworkingEngine.RequestType} requestType
 * @property {shaka.extern.HeadersReceived} headersReceived
 * The following are calculated from above properties
 * @property {string} formatIdString
 * @property {boolean} isInit
 * @property {number} sequenceNumber
 */
/**
 * @typedef AbortStatus
 * @type {object}
 * @property {boolean} cancelled
 * @property {boolean} timedOut
 * @property {boolean} playerReloadRequested
 * @property {boolean} finished
 */
/**
 * @typedef CurrentState
 * @type {object}
 * @property {Map<string, Uint8Array>} initDataCache
 * @property {VideoPlaybackAbrRequest} abrRequest
 * @property {RequestInit} requestInit
 * @property {AbortStatus} abortStatus
 * @property {AbortController} abortController
 * @property {SabrStreamState} sabrStreamState
 * @property {?TimeoutController} timeoutController
 * @property {?EventEmitterLike} eventEmitter
 * @property {number} cumulativeBackOffTimeMs
 * @property {number} cumulativeBackOffRequested
 * @property {number} cumulativeRetryDueToNextRequestPolicy
 * @property {number} generation
 * @property {(abrRequest: VideoPlaybackAbrRequest, builtAtGeneration: number) => number} applyCredentials
 * @property {() => ?PendingRefresh} getPendingRefresh
 * @property {() => void} beginRefresh
 * @property {() => shaka.Player} getPlayer
 * @property {number} sessionStartedAt
 * @property {() => boolean} isTornDown
 */
/**
 * @typedef PendingRefresh
 * @type {object}
 * @property {Promise<void>} promise
 * @property {() => void} resolve
 * @property {(error: Error) => void} reject
 */
/**
 * @typedef SabrStreamState
 * @type {object}
 * @property {string} sabrUrl
 * @property {Set<number>} activeSabrContextTypes
 * @property {Map<number, SabrContextUpdate>} sabrContexts
 * @property {?NextRequestPolicy} nextRequestPolicy
 * @property {boolean} playerReloadRequested
 * @property {number} requestNumber
 * @property {boolean} refreshInFlight
 */
/**
 * @typedef TimeoutController
 * @type {object}
 * @property {() => void} resetTimeoutOnce
 * @property {() => void} suspend
 * @property {() => void} resume
 * @property {() => void} clearTimeout
 */
/**
 * @typedef SabrStream
 * @type {object}
 * @property {(cb: ({backoffMs: number}) => void) => void} onBackoffRequested
 * @property {(cb: () => void) => void} onReloadOnce
 * @property {(cb: () => void) => void} onRefreshNeeded
 * @property {(cb: () => void) => void} onHardReloadNeededOnce
 * @property {(cb: () => void) => void} onRecoveryStarted
 * @property {(cb: () => void) => void} onRecoveryEnded
 * @property {(newSabrData: import('../../views/Watch/Watch').SabrData) => void} refresh
 * @property {(error: Error) => void} abandonRefresh
 * @property {() => string[]} getFormatIds
 * @property {() => void | undefined} cleanup
 */

/**
 * @param {string} str
 */
function formatIdFromString(str) {
  const videoFormatIdParts = str.split('-')

  return {
    itag: parseInt(videoFormatIdParts[0]),
    lastModified: videoFormatIdParts[1],
    xtags: videoFormatIdParts[2]
  }
}

/**
 * @param {import('googlevideo/protos').FormatId} formatId
 * @param {shaka.extern.BufferedRange} buffered
 * @param {shaka.media.SegmentIndex} segmentIndex
 */
function createBufferedRange(formatId, buffered, segmentIndex) {
  let endSegmentIndex = segmentIndex.find(buffered.end)
  if (endSegmentIndex == null) {
    // Using Last end time will get `null` in `segmentIndex.find`
    endSegmentIndex = segmentIndex.getNumReferences() - 1
  }

  return {
    formatId,
    startTimeMs: String(Math.round(buffered.start * 1000)),
    durationMs: String(Math.round((buffered.end - buffered.start) * 1000)),
    startSegmentIndex: segmentIndex.find(buffered.start),
    endSegmentIndex: endSegmentIndex,
  }
}

/**
 * Creates a bogus buffered range for a format. Used when we want to signal to the server to not send any
 * segments for this format.
 * @param {import('googlevideo/protos').FormatId} formatId - The format to create a full buffer range for.
 * @returns {import('googlevideo/protos').BufferedRange} A BufferedRange object indicating the entire format is buffered.
 */
function createFullBufferRange(formatId) {
  return {
    formatId: formatId,
    durationMs: MAX_INT32_VALUE,
    startTimeMs: '0',
    startSegmentIndex: parseInt(MAX_INT32_VALUE),
    endSegmentIndex: parseInt(MAX_INT32_VALUE),
    timeRange: {
      durationTicks: MAX_INT32_VALUE,
      startTicks: '0',
      timescale: 1000
    }
  }
}

/**
 * @param {shaka.Player} player
 * @param {shaka.extern.Manifest} manifest
 * @param {boolean} audioFormatsActive
 * @param {boolean} streamIsVideo - Fake audio bufferRange can be used
 * @param {boolean} streamIsAudio - Fake video bufferRange can be used
 * @param {import('googlevideo/protos').BufferedRange[]} bufferedRanges
 * @param {shaka.extern.Track} activeVariant
 */
function fillBufferedRanges(player, manifest, audioFormatsActive, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant) {
  const bufferedInfo = player.getBufferedInfo()

  if (bufferedInfo.audio.length > 0 || bufferedInfo.video.length > 0) {
    let activeManifestVariant
    if (audioFormatsActive) {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId
      })
    } else {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId &&
          variant.video.originalId === activeVariant.originalVideoId
      })
    }

    const audioFormatId = formatIdFromString(activeVariant.originalAudioId)
    const audioSegmentIndex = activeManifestVariant.audio.segmentIndex

    if (streamIsVideo) {
      bufferedRanges.push(createFullBufferRange(audioFormatId))
    } else {
      for (const buffered of bufferedInfo.audio) {
        bufferedRanges.push(createBufferedRange(audioFormatId, buffered, audioSegmentIndex))
      }
    }

    // Lazily initialize these variables as video data won't exist for audio-only playback
    let videoFormatId
    let videoSegmentIndex

    if (streamIsAudio && bufferedInfo.video.length > 0) {
      videoFormatId = formatIdFromString(activeVariant.originalVideoId)
      bufferedRanges.push(createFullBufferRange(videoFormatId))
    } else {
      for (const buffered of bufferedInfo.video) {
        if (!videoFormatId) {
          videoFormatId = formatIdFromString(activeVariant.originalVideoId)
        }

        if (!videoSegmentIndex) {
          videoSegmentIndex = activeManifestVariant.video.segmentIndex
        }

        bufferedRanges.push(createBufferedRange(videoFormatId, buffered, videoSegmentIndex))
      }
    }
  }
}

/**
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {Uint8Array} data
 * @returns {shaka.util.AbortableOperation<shaka.extern.Response>}
 */
function createCacheResponse(uri, request, data) {
  return AbortableOperation.completed({
    data,
    fromCache: true,
    headers: {},
    originalRequest: request,
    originalUri: uri,
    uri
  })
}

/**
 * @param {shaka.util.Error.Code} code
 * @param {...any} args
 */
function createRecoverableNetworkError(code, ...args) {
  return new ShakaError(ShakaError.Severity.RECOVERABLE, ShakaError.Category.NETWORK, code, ...args)
}

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
 * Ends this SABR session and asks for the named recovery. Requests already in
 * flight abort themselves once `playerReloadRequested` is set.
 * @param {CurrentState} currentState
 * @param {'reload' | 'hard-reload-needed'} event
 */
function endSessionForRecovery(currentState, event) {
  // A session that has been cleaned up has no player left to recover, and
  // asking for one reloads a page the viewer is already looking at
  if (currentState.isTornDown()) { return }

  currentState.sabrStreamState.playerReloadRequested = true
  if (!currentState.abortController.signal.aborted) {
    currentState.abortController.abort()
    currentState.eventEmitter.emit(event)
  }
}

/**
 * Asks the watch view to reload the player.
 * @param {CurrentState} currentState
 */
function requestPlayerReload(currentState) {
  endSessionForRecovery(currentState, 'reload')
}

/**
 * Records that the server served media, which is the only proof that recovery
 * worked. Enough of it restores the reload budgets.
 * @param {CurrentState} currentState
 */
function noteMediaServed(currentState) {
  if (attestationState.recovering) {
    attestationState.recovering = false
    currentState.eventEmitter.emit('recovery-ended')

    console.warn(
      `${RECOVERY_LOG} playing again after ${attestationState.refreshesThisEpisode} refreshes, ` +
      `${attestationState.hardReloads} session reloads and ${attestationState.pageReloads} page reloads`
    )

    attestationState.refreshesThisEpisode = 0
  }

  attestationState.refreshes = 0

  if (attestationState.mediaResponsesSinceReload < ATTESTATION_RECOVERY_SEGMENTS) {
    attestationState.mediaResponsesSinceReload += 1

    if (attestationState.mediaResponsesSinceReload === ATTESTATION_RECOVERY_SEGMENTS) {
      attestationState.hardReloads = 0
      attestationState.pageReloads = 0
    }
  }
}

/**
 * Re-applies the current credentials and SABR contexts to the request and
 * re-encodes the body. Needed before any re-send, because the encoded body
 * outlives the credentials it was built with.
 * @param {CurrentState} currentState
 */
function rebuildRequestBody(currentState) {
  currentState.generation = currentState.applyCredentials(currentState.abrRequest, currentState.generation)

  const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(currentState.sabrStreamState)

  currentState.abrRequest.streamerContext.sabrContexts = sabrContexts
  currentState.abrRequest.streamerContext.unsentSabrContexts = unsentSabrContexts

  let body

  try {
    body = VideoPlaybackAbrRequest.encode(currentState.abrRequest).finish()
  } catch (error) {
    console.error('Invalid VideoPlaybackAbrRequest data', currentState.abrRequest)
    throw error
  }

  currentState.requestInit = {
    ...currentState.requestInit,
    body,
  }
}

/**
 * Parks the request while a credential refresh is in flight, instead of
 * failing it. The player keeps playing from its buffer in the meantime. Once
 * released, the body is rebuilt against the fresh credentials. If the refresh
 * is abandoned, falls back to the old full player reload.
 * @param {OperationInputs} operationInputs
 * @param {CurrentState} currentState
 */
async function parkUntilRefreshed(operationInputs, currentState) {
  const pending = currentState.getPendingRefresh()
  if (!pending) return

  // Time spent parked is our latency, not the server's
  currentState.timeoutController?.suspend()

  try {
    await pending.promise
  } catch {
    if (currentState.abortStatus.cancelled || currentState.isTornDown()) {
      // Woken by teardown, not by a failed refresh: bow out quietly
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    }

    requestPlayerReload(currentState)
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Reloading player: SABR credential refresh failed'),
      operationInputs.requestType,
    )
  } finally {
    currentState.timeoutController?.resume()
  }

  // The retry and backoff history belongs to the dead session. Left in place,
  // the stale backoff tally plus the new session's routine start up backoff
  // trips the loop detector and forces the full reload this refresh exists to
  // avoid.
  currentState.cumulativeRetryDueToNextRequestPolicy = 0
  currentState.cumulativeBackOffRequested = 0
  currentState.cumulativeBackOffTimeMs = 0

  rebuildRequestBody(currentState)
}

/**
 * @param {SabrStreamState} sabrStreamState
 */
function prepareSabrContexts(sabrStreamState) {
  /** @type {SabrContextUpdate[]} */
  const sabrContexts = []
  /** @type {number[]} */
  const unsentSabrContexts = []

  for (const ctxUpdate of sabrStreamState.sabrContexts.values()) {
    if (sabrStreamState.activeSabrContextTypes.has(ctxUpdate.type)) {
      sabrContexts.push(ctxUpdate)
    } else {
      unsentSabrContexts.push(ctxUpdate.type)
    }
  }

  return { sabrContexts, unsentSabrContexts }
}

/**
 * @template T
 * @param {import('googlevideo/shared-types').Part} part
 * @param {{ decode: (data: Uint8Array) => T }} decoder
 * @returns {T | undefined}
 */
function decodePart(part, decoder) {
  if (!part.data.chunks.length) return undefined

  try {
    const chunk = part.data.chunks.length === 1 ? part.data.chunks[0] : concatenateChunks(part.data.chunks)
    return decoder.decode(chunk)
  } catch {
    return undefined
  }
}

/**
 * @param {(args: void) => void} callback
 * @param {number} timeoutMs
 * @return TimeoutController
 */
function createTimeoutController(callback, timeoutMs) {
  return {
    _timeout: setTimeout(callback, timeoutMs),
    _resetCount: 0,
    resetTimeoutOnce() {
      if (this._resetCount > 0) return

      this.clearTimeout()
      this._timeout = setTimeout(callback, timeoutMs)
      this._resetCount++
    },
    /**
     * Stops the clock without consuming the one shot reset. Used while a
     * request is parked waiting for fresh credentials: time spent parked is
     * our latency, not the server's, so it must not count against the request.
     */
    suspend() {
      clearTimeout(this._timeout)
    },
    resume() {
      this._timeout = setTimeout(callback, timeoutMs)
    },
    clearTimeout() {
      clearTimeout(this._timeout)
    },
  }
}

/**
 * @param {OperationInputs} operationInputs - readonly
 * @param {CurrentState} currentState - can be updated
 */
async function doRequest(
  operationInputs,
  currentState,
) {
  let response
  /** @type {CompositeBuffer | null} */
  let chunkedDataBuffer = null
  /** @type {Uint8Array[]} */
  const responseDataChunks = []
  let segmentComplete = false
  let shouldRetry = false
  let shouldRetryDueToNextRequestPolicy = false

  let invalidPoToken = false
  let error

  /** Latest value from a StreamProtectionStatus part. 2 means attestation pending. */
  let protectionStatus = 0
  let receivedMediaPart = false

  /** Only ever true when FT_SABR_WALL is set, see sabrWallInjection */
  const wallInjected = sabrWallInjectionEnabled && shouldInjectWall(currentState.sessionStartedAt)

  if (currentState.sabrStreamState.playerReloadRequested) {
    // Multiple requests might be issued at the same time, other requests should abort themselves once reload requested
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  await parkUntilRefreshed(operationInputs, currentState)

  try {
    let shouldReloadDueToBackoffLoop = false
    if ((currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs || 0) > 0) {
      const currentBackoffTimeMs = currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.eventEmitter.emit('backoff-requested', { backoffMs: currentBackoffTimeMs })
      // Wait but can be aborted
      await new Promise((resolve, reject) => {
        setTimeout(resolve, currentBackoffTimeMs)
        currentState.abortController.signal.addEventListener('abort', reject)
      })
      // Must reset AFTER waiting to avoid requested aborted
      // Since long backoff time mostly happens on the start of video playback we only reset timeout once
      // i.e. backoff time parts received will not reset timeout - counted as video loading issue
      currentState.timeoutController?.resetTimeoutOnce()

      currentState.cumulativeBackOffTimeMs += currentState.sabrStreamState.nextRequestPolicy.backoffTimeMs
      currentState.cumulativeBackOffRequested += 1
      const timeoutMs = operationInputs.request.retryParameters.timeout
      // Detect infinite backoff loop by no. of times requested and cumulative time approaching timeout
      if (currentState.cumulativeBackOffRequested >= 3 || (timeoutMs > 0 && timeoutMs <= (currentState.cumulativeBackOffTimeMs + currentBackoffTimeMs))) {
        shouldReloadDueToBackoffLoop = true
      }
    }
    if (shouldReloadDueToBackoffLoop || currentState.cumulativeRetryDueToNextRequestPolicy >= 100) {
      // Fire fake reload event due to detecting retry loop
      requestPlayerReload(currentState)
    }

    const sabrURL = new URL(currentState.sabrStreamState.sabrUrl)
    sabrURL.searchParams.set('rn', String(currentState.sabrStreamState.requestNumber++))
    response = await fetch(sabrURL.toString(), currentState.requestInit)

    operationInputs.headersReceived({})

    const { itag, lastModified, xtags } = formatIdFromString(operationInputs.formatIdString)
    let mediaHeaderId

    const reader = response.body.getReader()
    let readObj = await reader.read()

    while (!readObj.done && !currentState.abortStatus.finished) {
      if (chunkedDataBuffer) {
        chunkedDataBuffer.append(readObj.value)
      } else {
        chunkedDataBuffer = new CompositeBuffer([readObj.value])
      }

      const remainingData = new UmpReader(chunkedDataBuffer).read((part) => {
        // A simulated wall throws the media away and lets everything else
        // through, which is what the session sees when the server really
        // refuses to serve an untrusted token. Dropping MEDIA_END also keeps
        // the request retryable, since that is the part that finishes it.
        if (wallInjected && (
          part.type === UMPPartId.MEDIA ||
          part.type === UMPPartId.MEDIA_END ||
          part.type === UMPPartId.MEDIA_HEADER
        )) {
          return
        }

        switch (part.type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(part, StreamProtectionStatus)
            protectionStatus = streamProtectionStatus?.status ?? 0

            // A trusted status used to clear the recovery budget here. It is
            // not proof of anything on its own: a session can keep answering
            // "trusted" while serving nothing, and every such answer put the
            // budget back to zero, so the escalation was never reached and the
            // video refreshed forever in front of a drained buffer. Media
            // actually arriving is the only proof, and noteMediaServed has it.
            if (streamProtectionStatus.status === 3) {
              invalidPoToken = true
            }
            break
          }
          case UMPPartId.SABR_ERROR: {
            const sabrError = decodePart(part, SabrError)
            if (!sabrError) break

            error = `SABR Error: type: ${sabrError.type}, code: ${sabrError.code}`
            break
          }
          case UMPPartId.SABR_REDIRECT: {
            const sabrRedirect = decodePart(part, SabrRedirect)
            if (!sabrRedirect) break

            // The server sometimes sends a redirect part with an empty URL.
            // Applying it breaks every request in the session with
            // "Failed to construct 'URL'", so only follow parseable targets.
            if (sabrRedirect.url && URL.canParse(sabrRedirect.url)) {
              currentState.sabrStreamState.sabrUrl = sabrRedirect.url
              shouldRetry = true
            }
            break
          }
          case UMPPartId.MEDIA_HEADER: {
            if (mediaHeaderId === undefined) {
              const mediaHeader = decodePart(part, MediaHeader)
              if (!mediaHeader) break

              if (
                mediaHeader.formatId.itag === itag &&
                mediaHeader.formatId.lastModified === lastModified &&
                mediaHeader.formatId.xtags === xtags
              ) {
                if (operationInputs.isInit && mediaHeader.isInitSeg) {
                  mediaHeaderId = mediaHeader.headerId
                } else if (!operationInputs.isInit && mediaHeader.sequenceNumber === operationInputs.sequenceNumber) {
                  mediaHeaderId = mediaHeader.headerId
                }
              }
            }

            break
          }
          case UMPPartId.MEDIA: {
            receivedMediaPart = true
            if (mediaHeaderId === part.data.getUint8(0)) {
              responseDataChunks.push(...part.data.split(1).remainingBuffer.chunks)
            }
            break
          }
          case UMPPartId.MEDIA_END: {
            if (mediaHeaderId === part.data.getUint8(0)) {
              segmentComplete = true
              currentState.abortStatus.finished = true
              currentState.abortController.abort()
            }
            break
          }
          case UMPPartId.NEXT_REQUEST_POLICY: {
            const nextRequestPolicy = decodePart(part, NextRequestPolicy)

            shouldRetry = true
            shouldRetryDueToNextRequestPolicy = true

            currentState.sabrStreamState.nextRequestPolicy = nextRequestPolicy
            currentState.abrRequest.streamerContext.playbackCookie = nextRequestPolicy?.playbackCookie ? PlaybackCookie.encode(nextRequestPolicy.playbackCookie).finish() : undefined

            currentState.abrRequest.streamerContext.backoffTimeMs = nextRequestPolicy?.backoffTimeMs
            break
          }
          case UMPPartId.FORMAT_INITIALIZATION_METADATA: {
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(part, SabrContextUpdate)
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              if (
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)
              ) {
                break
              }

              currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_SENDING_POLICY: {
            const sabrContextSendingPolicy = decodePart(part, SabrContextSendingPolicy)
            if (!sabrContextSendingPolicy) break

            for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
              if (!currentState.sabrStreamState.activeSabrContextTypes.has(startPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.add(startPolicy)
              }
            }

            for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
              if (currentState.sabrStreamState.activeSabrContextTypes.has(stopPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.delete(stopPolicy)
              }
            }

            for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
              if (currentState.sabrStreamState.sabrContexts.has(discardPolicy)) {
                currentState.sabrStreamState.sabrContexts.delete(discardPolicy)
              }
            }
            break
          }
          case UMPPartId.RELOAD_PLAYER_RESPONSE: {
            const reloadPlaybackContext = decodePart(part, ReloadPlaybackContext)
            if (!reloadPlaybackContext) break

            // Whole video cannot be played
            requestPlayerReload(currentState)
            break
          }
          default: {
            break
          }
        }
      })

      if (!currentState.abortStatus.finished) {
        if (remainingData) {
          chunkedDataBuffer = remainingData.data
        } else {
          chunkedDataBuffer = null
        }

        readObj = await reader.read()
      }
    }
  } catch (error) {
    if (currentState.abortStatus.cancelled) {
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    } else if (currentState.abortStatus.timedOut) {
      throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
    } else if (!currentState.abortStatus.finished) {
      throw createRecoverableNetworkError(ShakaError.Code.HTTP_ERROR, operationInputs.uri, error, operationInputs.requestType)
    }
  }

  if (currentState.abortStatus.cancelled) {
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  } else if (currentState.abortStatus.timedOut) {
    throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
  }

  if (wallInjected) {
    // Answer as a walled session does, whatever the server actually said
    protectionStatus = 2
    shouldRetry = true
    shouldRetryDueToNextRequestPolicy = true
  }

  // The server answered without media because it does not trust the PO token
  // (attestation pending). Retrying sends an identical request, so it cannot
  // succeed. Reloading mints a new token, which sometimes is trusted.
  const attestationBlocked = !invalidPoToken &&
    protectionStatus >= 2 &&
    !receivedMediaPart &&
    currentState.cumulativeRetryDueToNextRequestPolicy >= ATTESTATION_RETRY_LIMIT

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

    noteMediaServed(currentState)

    if (operationInputs.isInit) {
      currentState.initDataCache.set(operationInputs.formatIdString, data)
    }

    /** @type {shaka.extern.Response} */
    return {
      uri: operationInputs.uri,
      originalUri: operationInputs.uri,
      data,
      status: response.status,
      headers: {},
      fromCache: false,
      originalRequest: operationInputs.request,
    }
  } else if (attestationBlocked) {
    const playbackLeft = secondsOfPlaybackLeft(currentState.getPlayer())

    // Refreshing costs the viewer nothing for as long as the buffer covers
    // playback, so there is no reason to stop while it does. Once the buffer
    // is nearly gone the video is about to stall whatever we do, which is the
    // moment a more disruptive remedy stops being a downgrade.
    const outOfPatience = attestationState.refreshes >= ATTESTATION_REFRESH_FLOOR &&
      (playbackLeft < ATTESTATION_LOW_BUFFER_SECONDS || attestationState.refreshes >= ATTESTATION_REFRESH_CEILING)

    if (outOfPatience) {
      // Audio and video reach this together, so the first one to escalate
      // ends the session for both. The budgets belong to the video, not to
      // each stream.
      if (currentState.sabrStreamState.playerReloadRequested) {
        throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
      }

      const reason = playbackLeft < ATTESTATION_LOW_BUFFER_SECONDS
        ? `${playbackLeft.toFixed(1)}s of watching left`
        : `${attestationState.refreshes} refreshes, the limit`

      // Rebuilding the session is what a viewer does by hand when they reopen
      // a walled video, and it succeeds where refreshing the credentials
      // underneath a running session does not. Why is not established: a
      // reload both takes longer and starts a genuinely new session, and we
      // cannot yet tell which of the two is the cure.
      if (attestationState.hardReloads < ATTESTATION_HARD_RELOAD_LIMIT) {
        attestationState.hardReloads += 1
        attestationState.mediaResponsesSinceReload = 0

        console.warn(`${RECOVERY_LOG} ${reason}, rebuilding the session (reload ${attestationState.hardReloads} of ${ATTESTATION_HARD_RELOAD_LIMIT})`)

        endSessionForRecovery(currentState, 'hard-reload-needed')

        throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
      }

      if (attestationState.pageReloads < ATTESTATION_PAGE_RELOAD_LIMIT) {
        attestationState.pageReloads += 1
        attestationState.mediaResponsesSinceReload = 0

        console.warn(`${RECOVERY_LOG} ${reason}, session reloads spent, reloading the page`)

        requestPlayerReload(currentState)

        throw createRecoverableNetworkError(
          ShakaError.Code.HTTP_ERROR,
          operationInputs.uri,
          new Error('Reloading player: SABR attestation recovery'),
          operationInputs.requestType,
        )
      }

      // Audio and video both arrive here, and both have to fail, but the
      // episode only ends once
      if (attestationState.recovering) {
        attestationState.recovering = false
        currentState.eventEmitter.emit('recovery-ended')

        console.warn(`${RECOVERY_LOG} giving up: ${attestationState.hardReloads} session reloads and ${attestationState.pageReloads} page reloads did not get a trusted token`)
      }

      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.NETWORK,
        ShakaError.Code.HTTP_ERROR,
        operationInputs.uri,
        new Error(ATTESTATION_GIVE_UP_MESSAGE),
        operationInputs.requestType,
      )
    }

    // Audio and video requests hit this at the same time, so only the first
    // one starts the refresh and counts it against the budget. Both then park
    // until the fresh credentials arrive and retry with them, without the
    // player being torn down.
    if (!currentState.sabrStreamState.refreshInFlight) {
      currentState.sabrStreamState.refreshInFlight = true
      attestationState.refreshes += 1
      attestationState.refreshesThisEpisode += 1

      if (!attestationState.recovering) {
        attestationState.recovering = true
        currentState.eventEmitter.emit('recovery-started')
      }

      console.warn(`${RECOVERY_LOG} PO token not trusted, refreshing credentials (attempt ${attestationState.refreshes}, ${playbackLeft.toFixed(1)}s of watching left)`)

      currentState.beginRefresh()
      currentState.eventEmitter.emit('refresh-needed')
    }

    // parkUntilRefreshed resets the per session counters on resume
    await parkUntilRefreshed(operationInputs, currentState)

    currentState.abortStatus.timedOut = false
    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (shouldRetry) {
    if (shouldRetryDueToNextRequestPolicy) {
      // Only count on actual retry to avoid counting false positive (when segmentComplete
      currentState.cumulativeRetryDueToNextRequestPolicy += 1
    }

    rebuildRequestBody(currentState)
    currentState.abortStatus.timedOut = false

    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (invalidPoToken) {
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.NETWORK,
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Invalid PO token'),
      operationInputs.requestType,
    )
  } else if (error) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error(error),
      operationInputs.requestType,
    )
  } else if (responseDataChunks.length > 0 && !segmentComplete) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Incomplete segment, missing MEDIA_END part'),
      operationInputs.requestType,
    )
  } else if (response.status === 200) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Empty response, this should not happen'),
      operationInputs.requestType,
    )
  } else {
    const severity = response.status === 401 || response.status === 403
      ? ShakaError.Severity.CRITICAL
      : ShakaError.Severity.RECOVERABLE

    throw new ShakaError(
      severity,
      ShakaError.Category.NETWORK,
      ShakaError.Code.BAD_HTTP_STATUS,
      operationInputs.uri,
      response.status,
      '',
      {},
      operationInputs.requestType,
      operationInputs.uri,
    )
  }
}

/**
 * @param {import('../../views/Watch/Watch').SabrData} sabrData
 * @param {() => shaka.Player} getPlayer
 * @param {() => shaka.extern.Manifest} getManifest
 * @param {import('vue').ComputedRef<number>} playerWidth
 * @param {import('vue').ComputedRef<number>} playerHeight
 * @return SabrStream
 */
export function setupSabrScheme(sabrData, getPlayer, getManifest, playerWidth, playerHeight) {
  const eventEmitter = new EventEmitterLike()

  /**
   * Caches the init data until the video ends
   * that way changing qualities and between audio and DASH
   * doesn't have to fetch the init data and segment index again
   * @type {Map<string, Uint8Array>}
   */
  const initDataCache = new Map()

  /**
   * Mutable so that credentials can be swapped underneath a running player
   * without destroying it, see `refresh` below.
   */
  const credentials = {
    poToken: base64ToU8(sabrData.poToken),
    videoPlaybackUstreamerConfig: base64ToU8(sabrData.ustreamerConfig),
    clientInfo: deepCopy(sabrData.clientInfo),
  }

  /**
   * While a credential refresh is in flight, requests park on this promise
   * instead of failing. Null means no refresh is in progress.
   * @type {?PendingRefresh}
   */
  let pendingRefresh = null

  /**
   * Set once this session has been cleaned up. Everything still in flight then
   * belongs to a player that no longer exists, so it must fail quietly rather
   * than ask for a recovery nobody wanted.
   */
  let tornDown = false

  function beginRefresh() {
    if (pendingRefresh) return

    let promiseResolve
    let promiseReject
    const promise = new Promise((resolve, reject) => {
      promiseResolve = resolve
      promiseReject = reject
    })
    // If every parked request is cancelled before an abandoned refresh
    // rejects, nobody is awaiting: swallow the unhandled rejection
    promise.catch(() => {})
    pendingRefresh = { promise, resolve: promiseResolve, reject: promiseReject }
  }

  /**
   * Incremented on every refresh. A request built before a refresh carries the
   * old generation, which is how we know its playback cookie is dead.
   */
  let sessionGeneration = 0

  /**
   * Re-applies current credentials to a request immediately before encoding.
   * The request body is built once when the Shaka request arrives and
   * re-encoded from the same object on every retry, so mutable credentials
   * alone are not enough: a request that parks across a refresh would still
   * send the old PO token, which the new session answers with a 403.
   * @param {VideoPlaybackAbrRequest} abrRequest
   * @param {number} builtAtGeneration
   */
  function applyCredentials(abrRequest, builtAtGeneration) {
    abrRequest.streamerContext.poToken = credentials.poToken
    abrRequest.streamerContext.clientInfo = credentials.clientInfo
    abrRequest.videoPlaybackUstreamerConfig = credentials.videoPlaybackUstreamerConfig

    if (builtAtGeneration !== sessionGeneration) {
      // The cookie identifies the dead session; sending it to the new one is
      // worse than sending nothing. The backoff echo belongs to it too.
      abrRequest.streamerContext.playbackCookie = undefined
      abrRequest.streamerContext.backoffTimeMs = undefined
    }

    return sessionGeneration
  }

  const sessionStartedAt = Date.now()

  if (attestationState.videoId !== sabrData.videoId) {
    resetAttestationBudget(sabrData.videoId)
    resetWallInjection()
  } else {
    // Same video, so this session was built to recover the last one, and its
    // credentials are fresh ones the simulated wall should count
    noteCredentialsInstalled()
  }

  // A new session gets a full refresh budget, whatever produced it: a new
  // video, the user reopening a walled one, or a recovery reload. Carrying a
  // spent budget into a fresh session made every attempt after the first give
  // up on its first block, which is why reopening a walled video only
  // sometimes helped. The reload budgets deliberately do not reset here, since
  // they are what bounds the ladder.
  attestationState.refreshes = 0

  /** @type {SabrStreamState} */
  const sabrStreamState = {
    sabrUrl: sabrData.url,
    activeSabrContextTypes: new Set(),
    sabrContexts: new Map(),
    nextRequestPolicy: undefined,
    playerReloadRequested: false,
    requestNumber: 0,
    refreshInFlight: false,
  }

  shaka.net.NetworkingEngine.registerScheme('sabr', (uri, request, requestType, _progressUpdated, headersReceived, _config) => {
    // lazily fetch it as the variable is only set after setupSabrScheme is called
    // but it will definitely exist when we receive a request here.
    const player = getPlayer()
    if (player == null) {
      // This is true during reload, returning a promise to suppress error
      return new AbortableOperation(Promise.resolve())
    }
    const isAudioOnly = player.isAudioOnly()

    const url = new URL(request.uris[0])

    const isInit = url.searchParams.has('init')
    const formatIdString = url.searchParams.get('formatId')

    if (isInit && initDataCache.has(formatIdString)) {
      return /** @__NOINLINE__ */ createCacheResponse(uri, request, initDataCache.get(formatIdString))
    }

    const variantTracks = player.getVariantTracks()
    const activeVariant = variantTracks.find(track => track.active)

    const streamIsAudio = url.pathname === 'audio'
    const streamIsVideo = url.pathname === 'video'

    let audioFormatId
    let videoFormatId

    if (streamIsAudio) {
      audioFormatId = formatIdFromString(formatIdString)

      if (isAudioOnly) {
        // We need to specify a video format even for audio only otherwise we get an error response
        videoFormatId = formatIdFromString(url.searchParams.get('videoFormatId'))
      } else {
        videoFormatId = formatIdFromString((activeVariant ?? variantTracks[0]).originalVideoId)
      }
    } else if (streamIsVideo) {
      videoFormatId = formatIdFromString(formatIdString)

      // for the first fetching of the initial data there won't be an active variant
      // (shaka-player only sets it to active after it has fetched the init/segment data)
      if (activeVariant) {
        audioFormatId = formatIdFromString(activeVariant.originalAudioId)
      } else {
        const candidates = variantTracks.filter((track) => track.audioRoles.includes('main'))

        const probableAudioFormat = candidates.reduce((previous, current) => {
          return current.audioBandwidth >= previous.audioBandwidth ? current : previous
        }, candidates[0])

        audioFormatId = formatIdFromString(probableAudioFormat.originalAudioId)
      }
    }

    /** @type {import('googlevideo/protos').BufferedRange[]} */
    const bufferedRanges = []

    if (!isInit && activeVariant) {
      /** @__NOINLINE__ */ fillBufferedRanges(player, getManifest(), isAudioOnly, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant)
    }

    let playerTimeMs = '0'

    if (url.searchParams.has('startTimeMs')) {
      playerTimeMs = url.searchParams.get('startTimeMs')
    }

    const drcEnabled = url.searchParams.has('drc') || !!(activeVariant && activeVariant.audioRoles.includes('drc'))
    const enableVoiceBoost = url.searchParams.has('vb') || !!(activeVariant && activeVariant.audioRoles.includes('vb'))

    const resolution = streamIsVideo ? parseInt(url.searchParams.get('resolution')) : undefined

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(sabrStreamState)

    /** @type {VideoPlaybackAbrRequest} */
    const requestData = {
      clientAbrState: {
        bandwidthEstimate: String(Math.round(player.getStats().estimatedBandwidth)),
        timeSinceLastManualFormatSelectionMs: streamIsVideo ? '0' : undefined,
        stickyResolution: resolution,
        lastManualSelectedResolution: resolution,
        playbackRate: player.getPlaybackRate(),
        enabledTrackTypesBitfield: streamIsAudio ? 1 : 0,
        drcEnabled,
        enableVoiceBoost,
        playerTimeMs,
        clientViewportWidth: playerWidth.value,
        clientViewportHeight: playerHeight.value,
        clientViewportIsFlexible: false
      },
      preferredAudioFormatIds: [audioFormatId],
      preferredVideoFormatIds: [videoFormatId],
      preferredSubtitleFormatIds: [],
      selectedFormatIds: isInit ? [] : [audioFormatId, videoFormatId],
      bufferedRanges,
      streamerContext: {
        poToken: credentials.poToken,
        clientInfo: credentials.clientInfo,
        sabrContexts,
        unsentSabrContexts,
        playbackCookie: sabrStreamState.nextRequestPolicy?.playbackCookie ? PlaybackCookie.encode(sabrStreamState.nextRequestPolicy.playbackCookie).finish() : undefined,
      },
      field1000: [],
      videoPlaybackUstreamerConfig: credentials.videoPlaybackUstreamerConfig,
    }

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(requestData).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', requestData)
      throw error
    }

    const sequenceNumber = parseInt(url.searchParams.get('sq'))

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {OperationInputs}
     */
    const opInputs = {
      uri,
      request,
      requestType,
      headersReceived,

      formatIdString,
      isInit,
      sequenceNumber,
    }

    const abortController = new AbortController()

    /** @type {RequestInit} */
    const init = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: abortController.signal,
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {AbortStatus}
     */
    const abortStatus = {
      cancelled: false,
      timedOut: false,
      finished: false,
    }

    const timeoutMs = request.retryParameters.timeout
    let timeoutController = null
    if (timeoutMs) {
      timeoutController = createTimeoutController(() => {
        abortStatus.timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {CurrentState}
     */
    const currentState = {
      initDataCache,
      abrRequest: requestData,
      requestInit: init,
      abortStatus: abortStatus,
      abortController,
      sabrStreamState,
      timeoutController,
      eventEmitter,
      cumulativeBackOffTimeMs: 0,
      cumulativeBackOffRequested: 0,
      cumulativeRetryDueToNextRequestPolicy: 0,
      generation: sessionGeneration,
      applyCredentials,
      getPendingRefresh: () => pendingRefresh,
      beginRefresh,
      getPlayer,
      sessionStartedAt,
      isTornDown: () => tornDown,
    }

    const pendingRequest = doRequest(opInputs, currentState)

    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.cancelled = true
      abortController.abort()
      return Promise.resolve()
    })

    if (timeoutController) {
      op.finally(() => {
        timeoutController.clearTimeout()
      })
    }

    return op
  })

  const cleanup = () => {
    tornDown = true

    shaka.net.NetworkingEngine.unregisterScheme('sabr')
    initDataCache.clear()

    // Release anything still parked, so requests cannot outlive the player
    const refresh = pendingRefresh
    pendingRefresh = null
    refresh?.reject(new Error('SABR session cleaned up during refresh'))
  }

  return {
    onBackoffRequested(callback) {
      eventEmitter.on('backoff-requested', callback)
    },
    onReloadOnce(callback) {
      eventEmitter.once('reload', callback)
    },
    /**
     * Fires when the server has stopped serving media for the current PO
     * token and fresh credentials are needed. The consumer answers with
     * either `refresh` or `abandonRefresh`. Not `once`: a session can need
     * refreshing more than once.
     * @param {() => void} callback
     */
    onRefreshNeeded(callback) {
      eventEmitter.on('refresh-needed', callback)
    },
    /**
     * Fires when refreshing credentials underneath the running session has
     * stopped being worth it and the session should be rebuilt from scratch,
     * keeping the watch page. This session is finished either way: the
     * consumer either rebuilds it or falls back to reloading the page.
     * @param {() => void} callback
     */
    onHardReloadNeededOnce(callback) {
      eventEmitter.once('hard-reload-needed', callback)
    },
    /**
     * Fires when the video first stops being served and recovery begins.
     * @param {() => void} callback
     */
    onRecoveryStarted(callback) {
      eventEmitter.on('recovery-started', callback)
    },
    /**
     * Fires when recovery finishes, whether it worked or was given up on.
     * @param {() => void} callback
     */
    onRecoveryEnded(callback) {
      eventEmitter.on('recovery-ended', callback)
    },
    /**
     * Swaps in fresh credentials without tearing down the player. Protocol
     * state tied to the old streaming session is discarded; the init data
     * cache is kept because the caller has verified the formats are
     * unchanged.
     * @param {import('../../views/Watch/Watch').SabrData} newSabrData
     */
    refresh(newSabrData) {
      noteCredentialsInstalled()

      credentials.poToken = base64ToU8(newSabrData.poToken)
      credentials.videoPlaybackUstreamerConfig = base64ToU8(newSabrData.ustreamerConfig)
      credentials.clientInfo = deepCopy(newSabrData.clientInfo)

      sabrStreamState.sabrUrl = newSabrData.url
      sabrStreamState.activeSabrContextTypes.clear()
      sabrStreamState.sabrContexts.clear()
      sabrStreamState.nextRequestPolicy = undefined
      sabrStreamState.playerReloadRequested = false
      sabrStreamState.requestNumber = 0
      sabrStreamState.refreshInFlight = false

      // Must precede the release below so parked requests observe the new
      // generation and rebuild their bodies against the new credentials
      sessionGeneration += 1

      const refresh = pendingRefresh
      pendingRefresh = null
      refresh?.resolve()
    },
    /**
     * Aborts a refresh that could not complete. Parked requests reject and
     * fall back to the full player reload.
     * @param {Error} error
     */
    abandonRefresh(error) {
      sabrStreamState.refreshInFlight = false

      const refresh = pendingRefresh
      pendingRefresh = null
      refresh?.reject(error)
    },
    /**
     * Format identifiers this session has served init data for. The caller
     * compares them against a fresh player response to decide whether the
     * existing buffer survives a refresh.
     * @returns {string[]}
     */
    getFormatIds() {
      return [...initDataCache.keys()]
    },
    cleanup,
  }
}
