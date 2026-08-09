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
 * How many credential refreshes to attempt before giving up on a video. Each
 * refresh mints a fresh PO token, which the server may or may not trust, so
 * retrying is worth something. Looping forever is not.
 */
const ATTESTATION_REFRESH_LIMIT = 5

/**
 * Survives player teardown, so that recovery attempts triggered by a
 * distrusted PO token can be counted even across a full reload. Scoped to a
 * single video.
 */
const attestationState = {
  /** @type {?string} */
  videoId: null,
  refreshes: 0,
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
 * Asks the watch view to reload the player. Requests already in flight abort
 * themselves once `playerReloadRequested` is set.
 * @param {CurrentState} currentState
 */
function requestPlayerReload(currentState) {
  currentState.sabrStreamState.playerReloadRequested = true
  if (!currentState.abortController.signal.aborted) {
    currentState.abortController.abort()
    currentState.eventEmitter.emit('reload')
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
    if (currentState.abortStatus.cancelled) {
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
        switch (part.type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(part, StreamProtectionStatus)
            protectionStatus = streamProtectionStatus?.status ?? 0
            if (protectionStatus === 1) {
              // The token is trusted, so earlier attestation failures no longer apply
              attestationState.refreshes = 0
            }
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

  // The server answered without media because it does not trust the PO token
  // (attestation pending). Retrying sends an identical request, so it cannot
  // succeed. Reloading mints a new token, which sometimes is trusted.
  const attestationBlocked = !invalidPoToken &&
    protectionStatus >= 2 &&
    !receivedMediaPart &&
    currentState.cumulativeRetryDueToNextRequestPolicy >= ATTESTATION_RETRY_LIMIT

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

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
    if (attestationState.refreshes >= ATTESTATION_REFRESH_LIMIT) {
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

  // A new session gets a full refresh budget, whatever produced it: a new
  // video, the user reopening a walled one, or a recovery reload. Carrying a
  // spent budget into a fresh session made every attempt after the first give
  // up on its first block, which is why reopening a walled video only
  // sometimes helped.
  attestationState.videoId = sabrData.videoId
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
     * Swaps in fresh credentials without tearing down the player. Protocol
     * state tied to the old streaming session is discarded; the init data
     * cache is kept because the caller has verified the formats are
     * unchanged.
     * @param {import('../../views/Watch/Watch').SabrData} newSabrData
     */
    refresh(newSabrData) {
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
