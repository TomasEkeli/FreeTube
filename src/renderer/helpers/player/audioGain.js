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

/**
 * How long a gain change is ramped over, in seconds. Stepping the gain
 * instantaneously puts a discontinuity in the waveform, which is audible as a click.
 */
const GAIN_RAMP_SECONDS = 0.02

/**
 * Amplification beyond what the video element can do on its own.
 *
 * `HTMLMediaElement.volume` is capped at 1 by specification, so going louder
 * means routing the element's audio through Web Audio instead:
 *
 * `MediaElementAudioSourceNode` → `GainNode` → `DynamicsCompressorNode` → `destination`
 *
 * The compressor acts as a soft limiter and is deliberately neither optional nor
 * configurable: gain above 1 on a passage that was already near full scale clips,
 * and the limiter is the difference between "louder" and "distorted".
 *
 * The graph is built lazily, the first time a gain above 1 is actually asked for.
 * Anyone who never boosts therefore keeps a completely untouched audio path.
 * `createMediaElementSource` cannot be undone for an element, so once the graph
 * exists it stays for as long as the element does.
 *
 * The element's own `volume` and `muted` still apply, as they take effect before
 * the audio reaches the source node, so muting continues to work while boosted.
 */
export class AudioGainStage {
  /**
   * @param {HTMLMediaElement} element
   */
  constructor(element) {
    /** @private */
    this.element_ = element

    /** @private {AudioContext|null} */
    this.context_ = null

    /** @private {MediaElementAudioSourceNode|null} */
    this.source_ = null

    /** @private {GainNode|null} */
    this.gainNode_ = null

    /** @private {DynamicsCompressorNode|null} */
    this.limiter_ = null

    /** @private */
    this.gain_ = 1

    /**
     * A suspended `AudioContext` doesn't just stop the graph, it silences the
     * routed element completely, so every opportunity to resume it is taken.
     * @private
     */
    this.resume_ = () => {
      if (this.context_?.state === 'suspended') {
        this.context_.resume()
      }
    }
  }

  /**
   * The gain currently asked for, where 1 means "no amplification".
   * @returns {number}
   */
  get gain() {
    return this.gain_
  }

  /**
   * @param {number} gain 1 means "no amplification"
   */
  setGain(gain) {
    if (this.gainNode_ === null) {
      // Everything up to 1 is the video element's own job, so as long as that is
      // all that has ever been asked for, the graph doesn't need to exist at all.
      if (gain <= 1) {
        this.gain_ = gain
        return
      }

      if (!this.build_()) {
        // Nothing was amplified, so don't claim otherwise. The next request
        // tries again, which is usually after the user has interacted.
        this.gain_ = 1
        return
      }
    }

    this.gain_ = gain

    const now = this.context_.currentTime
    const gainParam = this.gainNode_.gain

    gainParam.cancelScheduledValues(now)
    gainParam.setValueAtTime(gainParam.value, now)
    gainParam.linearRampToValueAtTime(gain, now + GAIN_RAMP_SECONDS)

    this.resume_()
  }

  /**
   * Builds the audio graph. Only ever called once, unless it fails.
   * @returns {boolean} whether the graph is now in place
   * @private
   */
  build_() {
    const context = new AudioContext()

    // An `AudioContext` that isn't running silences the element that feeds it,
    // and it can only be started by a user gesture. Since routing an element
    // through Web Audio can't be undone, that has to be settled before the
    // element is connected: playing at normal volume is a far better outcome
    // than playing silently.
    if (context.state !== 'running') {
      // TEMPORARY, see the volume decision log in ft-shaka-video-player.js
      console.warn('[ft volume] gain stage refused, context state was %o', context.state)

      context.close()

      return false
    }

    // TEMPORARY, see the volume decision log in ft-shaka-video-player.js
    console.warn('[ft volume] gain stage built')

    this.context_ = context
    this.source_ = context.createMediaElementSource(this.element_)

    this.gainNode_ = context.createGain()
    this.gainNode_.gain.value = 1

    this.limiter_ = context.createDynamicsCompressor()
    this.limiter_.threshold.value = -1
    this.limiter_.knee.value = 0
    this.limiter_.ratio.value = 20
    this.limiter_.attack.value = 0.003
    this.limiter_.release.value = 0.25

    this.source_.connect(this.gainNode_)
    this.gainNode_.connect(this.limiter_)
    this.limiter_.connect(context.destination)

    this.element_.addEventListener('play', this.resume_)
    context.addEventListener('statechange', this.resume_)

    return true
  }

  release() {
    // TEMPORARY, see the volume decision log in ft-shaka-video-player.js
    console.warn('[ft volume] gain stage releasing, graph existed: %o', this.context_ !== null)

    if (this.context_ === null) {
      return
    }

    this.element_.removeEventListener('play', this.resume_)
    this.context_.removeEventListener('statechange', this.resume_)

    this.source_.disconnect()
    this.gainNode_.disconnect()
    this.limiter_.disconnect()

    this.context_.close()

    this.context_ = null
    this.source_ = null
    this.gainNode_ = null
    this.limiter_ = null
  }
}
