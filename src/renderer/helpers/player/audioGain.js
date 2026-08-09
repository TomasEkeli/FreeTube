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
 * The window's one and only `AudioContext`, created the first time something needs
 * amplifying and then kept for the rest of the window's life.
 *
 * One shared context rather than one per video, because an `AudioContext` is an
 * expensive, limited resource: browsers cap how many a page may have at once, and
 * creating and closing one per video would churn through that budget while a
 * playlist plays. Nothing needs closing at teardown either, which keeps the
 * riskiest moment, the video element being destroyed, as simple as possible.
 *
 * @type {AudioContext|null}
 */
let sharedContext = null

/**
 * @returns {AudioContext|null} the shared context, or `null` when it isn't safe to
 * route an element through it
 */
function getRunningSharedContext() {
  if (sharedContext === null || sharedContext.state === 'closed') {
    const context = new AudioContext()

    if (context.state !== 'running') {
      // A context that isn't running silences the elements feeding it rather than
      // merely stopping the graph, and only a user gesture can start it. Since
      // routing an element through Web Audio cannot be undone, nothing is
      // connected until the context is known to be running: playing at normal
      // volume is a far better outcome than playing silently.
      console.warn('Volume boost unavailable, the audio context would not start')

      context.close()

      return null
    }

    // A context can be suspended later on, by the browser or the machine
    context.addEventListener('statechange', () => {
      if (context.state === 'suspended') {
        context.resume()
      }
    })

    sharedContext = context
  }

  if (sharedContext.state !== 'running') {
    // Ask for it back and let the next request use it. Resuming is asynchronous,
    // so there is no way to connect an element safely in this moment.
    sharedContext.resume()

    return null
  }

  return sharedContext
}

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

    /** @private {MediaElementAudioSourceNode|null} */
    this.source_ = null

    /** @private {GainNode|null} */
    this.gainNode_ = null

    /** @private {DynamicsCompressorNode|null} */
    this.limiter_ = null

    /** @private */
    this.gain_ = 1

    /**
     * A suspended context silences the element it is fed by, so every opportunity
     * to get it running again is taken.
     * @private
     */
    this.resume_ = () => {
      if (sharedContext?.state === 'suspended') {
        sharedContext.resume()
      }
    }
  }

  /**
   * The gain currently in force, where 1 means "no amplification".
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

    const now = this.gainNode_.context.currentTime
    const gainParam = this.gainNode_.gain

    gainParam.cancelScheduledValues(now)
    gainParam.setValueAtTime(gainParam.value, now)
    gainParam.linearRampToValueAtTime(gain, now + GAIN_RAMP_SECONDS)

    this.resume_()
  }

  /**
   * Routes this element through the shared context. Only ever called once, unless
   * it fails.
   * @returns {boolean} whether the graph is now in place
   * @private
   */
  build_() {
    const context = getRunningSharedContext()

    if (context === null) {
      return false
    }

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

    return true
  }

  release() {
    if (this.gainNode_ === null) {
      return
    }

    this.element_.removeEventListener('play', this.resume_)

    // Disconnecting is what lets the element and its source node be collected.
    // The context itself is shared and outlives this stage, so it stays open.
    this.source_.disconnect()
    this.gainNode_.disconnect()
    this.limiter_.disconnect()

    this.source_ = null
    this.gainNode_ = null
    this.limiter_ = null
  }
}
