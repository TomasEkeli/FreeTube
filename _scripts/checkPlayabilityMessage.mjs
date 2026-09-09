import { classifyPlayabilityError, getPlayabilityExplanation } from '../src/renderer/helpers/player/playability.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

check(
  'bare unavailable response suggests changing the network',
  classifyPlayabilityError({
    status: 'UNPLAYABLE',
    reason: 'Video unavailable',
    error_screen: {
      content: {
        description: { content: 'Video unavailable' }
      }
    }
  }) === 'unexplained-refusal'
)

check(
  'explicit region block keeps the supplied reason',
  classifyPlayabilityError({
    status: 'UNPLAYABLE',
    reason: 'Video unavailable',
    error_screen: {
      content: {
        description: { content: 'The uploader has not made this video available in your country' }
      }
    }
  }) === null
)

check(
  'new interstitial exposes its explanation',
  getPlayabilityExplanation({
    error_screen: {
      content: {
        description: { content: 'The uploader has not made this video available in your country' }
      }
    }
  }) === 'The uploader has not made this video available in your country'
)

check(
  'bot refusal uses the existing IP block message',
  classifyPlayabilityError({ status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' }) === 'ip-block'
)

process.exitCode = failures === 0 ? 0 : 1
