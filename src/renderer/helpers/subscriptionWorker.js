import { reactive, readonly } from 'vue'

/**
 * One serial queue for every background subscription request.
 *
 * Recovering a failed refresh and filling in details missing from RSS both want
 * to make a slow trickle of requests, and they must not do it independently:
 * two trickles are one burst, which is the thing being avoided. So there is one
 * worker, one request in flight, and a fixed gap between requests, with
 * recovery served before enrichment.
 *
 * The queues hold closures, so they stay out of the store; only the progress
 * the interface needs is reactive. It lives at module scope rather than in a
 * component so that switching tabs, or navigating away entirely, does not
 * abandon work that takes minutes to finish.
 */

/** Recovering channels a refresh could not reach. Served first. */
export const LANE_RECOVERY = 'recovery'

/** Filling in details RSS does not carry. Served when nothing is recovering. */
export const LANE_ENRICHMENT = 'enrichment'

const LANES = [LANE_RECOVERY, LANE_ENRICHMENT]

/** Long enough to be a trickle rather than a burst. Tune against FT_SUBS_TRACE. */
export const WORKER_DELAY_MS = 1500

/**
 * @typedef {object} WorkerJob
 * @property {string} key deduplication key, usually feed + channel id
 * @property {string} [label] shown to the user while it runs
 * @property {() => Promise<void>} run
 */

/** @type {Record<string, WorkerJob[]>} */
const queues = {
  [LANE_RECOVERY]: [],
  [LANE_ENRICHMENT]: []
}

/**
 * Keys currently queued or running, so the same channel is not fetched twice
 * because it appeared in two batches.
 * @type {Record<string, Set<string>>}
 */
const claimed = {
  [LANE_RECOVERY]: new Set(),
  [LANE_ENRICHMENT]: new Set()
}

const progress = reactive({
  /** @type {'idle' | 'recovery' | 'enrichment'} */
  lane: 'idle',
  /** Jobs finished since the current run began. */
  done: 0,
  /** Jobs still queued, across both lanes. */
  queued: 0,
  /** @type {string | null} */
  label: null
})

/** Progress for the interface to read. Mutated only in here. */
export const subscriptionWorkerProgress = readonly(progress)

let running = false
let cancelledLanes = new Set()

/**
 * Incremented for every drain. A drain only clears the shared progress if it is
 * still the current one, so a loop that has been abandoned cannot report itself
 * idle over the top of the run that replaced it.
 */
let generation = 0

/** Overridable so tests do not have to wait in real time. */
let delayMs = WORKER_DELAY_MS

/** @param {number} ms */
export function setSubscriptionWorkerDelayForTests(ms) {
  delayMs = ms
}

function queuedCount() {
  return LANES.reduce((total, lane) => total + queues[lane].length, 0)
}

function syncQueuedCount() {
  progress.queued = queuedCount()
}

/**
 * Add jobs to a lane. Jobs whose key is already queued or running are dropped,
 * so callers can re-offer the visible feed without worrying about duplicates.
 *
 * @param {string} lane
 * @param {WorkerJob[]} jobs
 */
export function enqueueSubscriptionJobs(lane, jobs) {
  // Offering work to a lane means we are no longer cancelling it
  cancelledLanes.delete(lane)

  let added = 0

  for (const job of jobs) {
    if (claimed[lane].has(job.key)) { continue }

    claimed[lane].add(job.key)
    queues[lane].push(job)
    added++
  }

  syncQueuedCount()

  if (added > 0) {
    // Deliberately not awaited: callers enqueue and carry on
    drain()
  }

  return added
}

/**
 * Queue one job and resolve once it has run, so a caller can sequence work
 * across the queue without holding it open. A job dropped as a duplicate
 * resolves immediately: the work is already accounted for either way, and a
 * caller waiting forever on a job that will never run would be worse.
 *
 * @param {string} lane
 * @param {WorkerJob} job
 * @returns {Promise<void>}
 */
export function enqueueSubscriptionJob(lane, job) {
  return new Promise((resolve) => {
    const added = enqueueSubscriptionJobs(lane, [{
      ...job,
      run: async () => {
        try {
          await job.run()
        } finally {
          resolve()
        }
      }
    }])

    if (added === 0) { resolve() }
  })
}

/**
 * Drop everything queued for a lane. The job already in flight is allowed to
 * finish, since there is nothing to abort a request with here and its result is
 * still worth having.
 *
 * @param {string} lane
 */
export function cancelSubscriptionLane(lane) {
  cancelledLanes.add(lane)

  for (const job of queues[lane]) {
    claimed[lane].delete(job.key)
  }

  queues[lane] = []
  syncQueuedCount()
}

export function cancelAllSubscriptionWork() {
  for (const lane of LANES) {
    cancelSubscriptionLane(lane)
  }
}

/** @returns {string | null} */
function nextLane() {
  for (const lane of LANES) {
    if (queues[lane].length > 0) { return lane }
  }

  return null
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function drain() {
  if (running) { return }

  running = true

  const thisGeneration = ++generation

  progress.done = 0

  try {
    let lane = nextLane()

    while (lane != null) {
      const job = queues[lane].shift()

      progress.lane = lane
      progress.label = job.label ?? null
      syncQueuedCount()

      try {
        await job.run()
      } catch (error) {
        // A failing job must not stop the queue: the whole point is to keep
        // grinding through a list that is partly broken.
        console.error(error)
      } finally {
        claimed[lane].delete(job.key)
      }

      progress.done++

      lane = nextLane()

      if (lane != null) {
        await sleep(delayMs)
        // Cancelling during the gap should take effect immediately
        lane = nextLane()
      }
    }
  } finally {
    if (thisGeneration === generation) {
      running = false
      cancelledLanes = new Set()
      progress.lane = 'idle'
      progress.label = null
      progress.done = 0
      syncQueuedCount()
    }
  }
}

/** Whether the worker currently has anything to do. */
export function subscriptionWorkerBusy() {
  return running
}

/** Test seam: forget all state between cases. */
export function resetSubscriptionWorkerForTests() {
  for (const lane of LANES) {
    queues[lane] = []
    claimed[lane].clear()
  }

  cancelledLanes = new Set()
  running = false
  // Abandons any drain still in flight, which the generation guard stops from
  // reporting itself idle later
  generation++
  progress.lane = 'idle'
  progress.done = 0
  progress.queued = 0
  progress.label = null
  delayMs = WORKER_DELAY_MS
}
