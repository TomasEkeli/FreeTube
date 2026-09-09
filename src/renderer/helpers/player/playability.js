const BOT_MESSAGE = 'Sign in to confirm you’re not a bot'

export function getPlayabilityExplanation(playabilityStatus) {
  return playabilityStatus.error_screen?.subreason?.text ??
    playabilityStatus.error_screen?.content?.description?.content
}

export function classifyPlayabilityError(playabilityStatus) {
  if (playabilityStatus.reason === BOT_MESSAGE || playabilityStatus.reason === 'Please sign in') {
    return 'ip-block'
  }

  const explanation = getPlayabilityExplanation(playabilityStatus)

  if (playabilityStatus.status === 'UNPLAYABLE' &&
    playabilityStatus.reason === 'Video unavailable' &&
    (!explanation || explanation === playabilityStatus.reason)) {
    return 'unexplained-refusal'
  }

  return null
}
