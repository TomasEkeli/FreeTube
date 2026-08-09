/**
 * Checks the invariants of the serial subscription worker.
 *
 * The worker exists to keep background subscription requests to a trickle. Its
 * guarantees are the sort that break quietly: nothing visibly goes wrong when
 * two requests overlap or a cancelled queue keeps grinding, it just stops
 * achieving the thing it was built for. So they are asserted here.
 *
 * Run with `pnpm run check-subscription-worker`. There is no test runner in this
 * project, which is why this is a script.
 */

import {
  cancelAllSubscriptionWork,
  cancelSubscriptionLane,
  enqueueSubscriptionJobs,
  resetSubscriptionWorkerForTests,
  setSubscriptionWorkerDelayForTests,
  subscriptionWorkerBusy,
  subscriptionWorkerProgress,
  LANE_DELAYS_MS,
  LANE_ENRICHMENT,
  LANE_RECOVERY
} from '../src/renderer/helpers/subscriptionWorker.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

// One request at a time, and recovery ahead of queued enrichment
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(5)

  let inFlight = 0
  let peak = 0
  const order = []

  const job = (lane, n) => ({
    key: `${lane}-${n}`,
    label: `${lane} ${n}`,
    run: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      order.push(`${lane}${n}`)
      await sleep(10)
      inFlight--
    }
  })

  enqueueSubscriptionJobs(LANE_ENRICHMENT, [job('e', 1), job('e', 2)])
  enqueueSubscriptionJobs(LANE_RECOVERY, [job('r', 1), job('r', 2)])

  await sleep(300)

  check('never more than one request in flight', peak === 1)
  check('all jobs ran', order.length === 4)
  // The first enqueue starts the drain synchronously, so e1 is already running
  // before recovery is offered. Priority governs what is queued, not what is in
  // flight, so both recovery jobs must precede the still-queued e2.
  check(
    `recovery preempts queued enrichment (${order.join(',')})`,
    order.indexOf('r1') < order.indexOf('e2') && order.indexOf('r2') < order.indexOf('e2')
  )
  check('idle once drained', subscriptionWorkerProgress.lane === 'idle' && !subscriptionWorkerBusy())
}

// The same channel offered twice is fetched once
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)

  let runs = 0
  const job = { key: 'same', run: async () => { runs++ } }
  const added = enqueueSubscriptionJobs(LANE_ENRICHMENT, [job, { ...job }, { ...job }])

  await sleep(200)

  check(`duplicate keys collapse to one (added ${added}, ran ${runs})`, added === 1 && runs === 1)
}

// A failing job must not stop the queue: the list being ground through is
// partly broken by definition
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)

  let after = 0

  enqueueSubscriptionJobs(LANE_RECOVERY, [
    { key: 'throws', run: async () => { throw new Error('deliberate, expected in output') } },
    { key: 'after', run: async () => { after++ } }
  ])

  await sleep(200)

  check('queue survives a throwing job', after === 1)
}

// Cancelling drops queued work and releases the keys
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(40)

  let ran = 0

  enqueueSubscriptionJobs(
    LANE_ENRICHMENT,
    Array.from({ length: 8 }, (_, i) => ({ key: `c${i}`, run: async () => { ran++ } }))
  )

  await sleep(60)
  cancelSubscriptionLane(LANE_ENRICHMENT)

  const ranAtCancel = ran

  await sleep(300)

  check(`cancel stops further work (${ranAtCancel} then ${ran} of 8)`, ran <= ranAtCancel + 1 && ran < 8)
  check(
    'cancelled keys can be offered again',
    enqueueSubscriptionJobs(LANE_ENRICHMENT, [{ key: 'c7', run: async () => {} }]) === 1
  )
}

// Progress is reported while running and cleared afterwards
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(5)

  const jobs = Array.from({ length: 3 }, (_, i) => ({ key: `p${i}`, label: `channel ${i}`, run: () => sleep(5) }))

  enqueueSubscriptionJobs(LANE_RECOVERY, jobs)

  await sleep(12)

  check(`lane reported while running (${subscriptionWorkerProgress.lane})`, subscriptionWorkerProgress.lane === 'recovery')
  check(`label reported (${subscriptionWorkerProgress.label})`, String(subscriptionWorkerProgress.label).startsWith('channel'))

  await sleep(300)

  check('counters cleared when idle', subscriptionWorkerProgress.done === 0 && subscriptionWorkerProgress.queued === 0)
}

// Progress is not writable from outside
{
  resetSubscriptionWorkerForTests()

  let rejected = true

  try {
    subscriptionWorkerProgress.done = 999

    if (subscriptionWorkerProgress.done === 999) { rejected = false }
  } catch {
    // readonly() throws in some builds and warns in others; both are fine
  }

  check('progress is not externally writable', rejected)
}

// Enqueueing mid-drain joins the running drain instead of starting a second one
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(5)

  let inFlight = 0
  let peak = 0

  const job = key => ({
    key,
    run: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(20)
      inFlight--
    }
  })

  enqueueSubscriptionJobs(LANE_ENRICHMENT, [job('x1')])
  await sleep(5)
  enqueueSubscriptionJobs(LANE_RECOVERY, [job('y1')])

  await sleep(300)

  check('enqueue during a drain does not start a second runner', peak === 1)
}

// Recovery is paced more slowly than the back-fill on purpose: it only runs
// because something already refused us
{
  const recovery = LANE_DELAYS_MS[LANE_RECOVERY]
  const enrichment = LANE_DELAYS_MS[LANE_ENRICHMENT]

  check(`recovery waits longer between jobs than the back-fill (${recovery}ms vs ${enrichment}ms)`, recovery > enrichment)
}

// And the gap actually observed matches the lane that ran
{
  resetSubscriptionWorkerForTests()

  const started = []
  const jobs = lane => Array.from({ length: 3 }, (_, i) => ({
    key: `${lane}-timed-${i}`,
    run: async () => { started.push(Date.now()) }
  }))

  enqueueSubscriptionJobs(LANE_ENRICHMENT, jobs('e'))

  await sleep(LANE_DELAYS_MS[LANE_ENRICHMENT] * 4)

  const gaps = started.slice(1).map((time, i) => time - started[i])
  const slowest = Math.max(...gaps)

  check(
    `back-fill gaps follow its own lane (${gaps.join(', ')}ms)`,
    started.length === 3 && slowest < LANE_DELAYS_MS[LANE_RECOVERY]
  )
}

cancelAllSubscriptionWork()

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
