/**
 * Converts YouTube's content loudness measurement into the linear gain that
 * would bring the video to YouTube's reference loudness.
 *
 * This is the formula YouTube's own player uses. The difference is that YouTube
 * clamps the result to at most 1, which is exactly why quietly mastered videos
 * stay quiet there: the correction is only ever allowed to attenuate.
 *
 * @param {number} loudnessDb How much louder the content is than the reference
 * loudness, in dB. Positive for loud videos, negative for quiet ones.
 * @returns {number} The linear gain, where 1 means "no change".
 */
export function loudnessDbToGain(loudnessDb) {
  return 10 ** (-loudnessDb / 20)
}
