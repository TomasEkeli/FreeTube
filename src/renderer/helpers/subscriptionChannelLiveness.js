import { getLocalChannel } from './api/local'

/**
 * Ask whether a channel actually exists, using an endpoint that is not the one
 * that just claimed it does not.
 *
 * The feed ladders decide "this channel is gone" from a 404 on its RSS playlist
 * feed, confirmed by a 404 on its RSS channel feed. Both of those come from the
 * same service, so the confirmation is worth nothing when the service itself is
 * the thing that is broken: on 2026-08-22 `youtube.com/feeds/videos.xml`
 * answered 404 for every valid id, while the channels' own pages loaded
 * normally, and the feed concluded that six hundred channels had been
 * terminated and cached emptiness for all of them.
 *
 * `getLocalChannel` is a different endpoint reached a different way, and it
 * reports termination explicitly rather than by absence, which is exactly the
 * second opinion the 404 branch needs.
 */

/**
 * How long a verdict is reused. Short, because this is only meant to spare the
 * three feeds asking the same question about the same channel within one
 * refresh: videos, live and shorts each reach the 404 branch separately, so an
 * outage would otherwise probe every channel three times over.
 */
const VERDICT_TTL_MS = 5 * 60 * 1000

/** @type {Map<string, { verdict: string, at: number }>} */
const cache = new Map()

/** @type {Map<string, Promise<string>>} */
const inFlight = new Map()

/**
 * @typedef {'gone' | 'alive' | 'unknown'} ChannelLiveness
 * `unknown` means the probe itself failed, which is not evidence either way.
 */

/**
 * @param {{ id: string }} channel
 * @returns {Promise<ChannelLiveness>}
 */
export function probeChannelLiveness(channel) {
  const known = cache.get(channel.id)

  if (known != null && Date.now() - known.at < VERDICT_TTL_MS) {
    return Promise.resolve(known.verdict)
  }

  // Three feeds can reach this for one channel at the same moment, and one
  // answer serves all of them
  const pending = inFlight.get(channel.id)

  if (pending != null) { return pending }

  const promise = runProbe(channel)
    .then((verdict) => {
      if (verdict !== 'unknown') {
        cache.set(channel.id, { verdict, at: Date.now() })
      }

      return verdict
    })
    .finally(() => {
      inFlight.delete(channel.id)
    })

  inFlight.set(channel.id, promise)

  return promise
}

/**
 * @param {{ id: string }} channel
 * @returns {Promise<ChannelLiveness>}
 */
async function runProbe(channel) {
  if (!process.env.SUPPORTS_LOCAL_API) {
    // Nothing independent to ask, so nothing is confirmed. The caller treats
    // that as "do not condemn the channel", which is the safe direction.
    return 'unknown'
  }

  try {
    const result = await getLocalChannel(channel.id)

    if (result == null) { return 'unknown' }

    // getLocalChannel reports a termination as an alert rather than throwing
    return result.alert != null ? 'gone' : 'alive'
  } catch {
    return 'unknown'
  }
}

/** Forget every verdict. For tests, and for a profile switch. */
export function clearChannelLivenessCache() {
  cache.clear()
}
