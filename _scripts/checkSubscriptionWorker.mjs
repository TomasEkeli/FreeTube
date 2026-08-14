/**
 * Checks the invariants of the subscription request manager.
 *
 * The manager exists to keep every subscription request — refresh, recovery and
 * back-fill alike — inside one budget. Its guarantees are the sort that break
 * quietly: nothing visibly goes wrong when the budget is exceeded or a cancelled
 * queue keeps grinding, it just stops achieving the thing it was built for, and
 * the evidence arrives days later as a mass failure. So they are asserted here.
 *
 * Run with `pnpm run check-subscription-worker`. There is no test runner in this
 * project, which is why this is a script.
 */

import {
  cancelAllSubscriptionWork,
  cancelSubscriptionLane,
  enqueueSubscriptionJobs,
  promoteSubscriptionJobs,
  resetSubscriptionWorkerForTests,
  setSubscriptionBudgetForTests,
  setSubscriptionWorkerDelayForTests,
  subscriptionBudget,
  subscriptionWorkerBusy,
  subscriptionWorkerProgress,
  takeSubscriptionPeakInFlight,
  LANE_DELAYS_MS,
  LANE_ENRICHMENT,
  LANE_RECOVERY,
  LANE_REFRESH,
  LANE_WIDTHS
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

/** A job that occupies a lane for `ms`, recording what overlapped with it. */
function tracker() {
  const inFlight = { refresh: 0, recovery: 0, enrichment: 0 }
  const peak = { refresh: 0, recovery: 0, enrichment: 0, total: 0 }
  const starts = []
  const order = []

  return {
    peak,
    starts,
    order,
    job: (lane, name, ms = 10) => ({
      key: `${lane}-${name}`,
      label: `${lane} ${name}`,
      run: async () => {
        starts.push({ lane, at: Date.now() })
        order.push(name)
        inFlight[lane]++

        const total = inFlight.refresh + inFlight.recovery + inFlight.enrichment

        peak[lane] = Math.max(peak[lane], inFlight[lane])
        peak.total = Math.max(peak.total, total)

        await sleep(ms)
        inFlight[lane]--
      }
    })
  }
}

// Lane widths are respected: each lane may only occupy so much of the budget
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(20, 1000)

  const { peak, job } = tracker()

  enqueueSubscriptionJobs(LANE_RECOVERY, Array.from({ length: 5 }, (_, i) => job('recovery', `r${i}`, 20)))
  enqueueSubscriptionJobs(LANE_ENRICHMENT, Array.from({ length: 6 }, (_, i) => job('enrichment', `e${i}`, 20)))

  await sleep(400)

  check(`recovery stays one at a time (peak ${peak.recovery})`, peak.recovery === LANE_WIDTHS.recovery)
  check(`enrichment stays within its width (peak ${peak.enrichment})`, peak.enrichment <= LANE_WIDTHS.enrichment)
  check('idle once drained', subscriptionWorkerProgress.lane === 'idle' && !subscriptionWorkerBusy())
}

// Nothing exceeds the budget, however many lanes are asking
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(6, 1000)

  const { peak, job } = tracker()

  enqueueSubscriptionJobs(LANE_REFRESH, Array.from({ length: 30 }, (_, i) => job('refresh', `f${i}`, 30)))
  enqueueSubscriptionJobs(LANE_RECOVERY, Array.from({ length: 5 }, (_, i) => job('recovery', `r${i}`, 30)))
  enqueueSubscriptionJobs(LANE_ENRICHMENT, Array.from({ length: 5 }, (_, i) => job('enrichment', `e${i}`, 30)))

  await sleep(150)

  const observedPeak = peak.total

  cancelAllSubscriptionWork()
  await sleep(100)

  check(`three lanes at once never exceed the budget (peak ${observedPeak} of 6)`, observedPeak <= 6)
  check(`and the budget is actually used (peak ${observedPeak})`, observedPeak >= 4)
}

// The start rate is held down as well as the concurrency: a burst of very short
// requests must not slip a second budget's worth through inside one window
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(4, 200)

  const { starts, job } = tracker()

  enqueueSubscriptionJobs(LANE_REFRESH, Array.from({ length: 12 }, (_, i) => job('refresh', `f${i}`, 1)))

  await sleep(900)

  const times = starts.map(start => start.at)
  // Allow a few milliseconds of timer slop; the guarantee is the window, not
  // the scheduler's precision
  const violations = times.filter((time, i) => i >= 4 && time - times[i - 4] < 195)

  check(
    `no more than the budget starts in one window (${times.length} starts, ${violations.length} too close)`,
    times.length === 12 && violations.length === 0
  )
}

// Priority is positional: a lane is offered the budget before the lanes below it
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  // One at a time, so that what runs next is purely a question of priority
  setSubscriptionBudgetForTests(1, 1)

  const { order, job } = tracker()

  enqueueSubscriptionJobs(LANE_ENRICHMENT, [job('enrichment', 'e1', 10), job('enrichment', 'e2', 10)])
  enqueueSubscriptionJobs(LANE_RECOVERY, [job('recovery', 'r1', 10), job('recovery', 'r2', 10)])
  enqueueSubscriptionJobs(LANE_REFRESH, [job('refresh', 'f1', 10), job('refresh', 'f2', 10)])

  await sleep(400)

  // e1 was already running before the other lanes were offered anything:
  // priority governs what is queued, not what is in flight
  check(
    `refresh outruns recovery, and both outrun queued enrichment (${order.join(',')})`,
    order.length === 6 &&
    order.indexOf('f1') < order.indexOf('r1') &&
    order.indexOf('r1') < order.indexOf('e2')
  )
}

// The back-fill still gets a share while a refresh is saturating the budget,
// which is the whole reason they share a manager
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(8, 50)

  const { peak, job } = tracker()

  enqueueSubscriptionJobs(LANE_REFRESH, Array.from({ length: 40 }, (_, i) => job('refresh', `f${i}`, 40)))
  enqueueSubscriptionJobs(LANE_ENRICHMENT, Array.from({ length: 4 }, (_, i) => job('enrichment', `e${i}`, 40)))

  await sleep(250)

  const enrichmentRan = peak.enrichment

  cancelAllSubscriptionWork()
  await sleep(100)

  check(`enrichment runs during a refresh (peak ${enrichmentRan})`, enrichmentRan > 0)
}

// What is on screen can be moved to the front of a queue it is already in
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(1, 1)

  const { order, job } = tracker()

  enqueueSubscriptionJobs(LANE_ENRICHMENT, ['a', 'b', 'c', 'd'].map(name => job('enrichment', name, 10)))

  const moved = promoteSubscriptionJobs(LANE_ENRICHMENT, ['enrichment-d', 'enrichment-c'])

  await sleep(300)

  check(`promotion moves queued jobs to the front, in the order asked for (${order.join(',')})`,
    moved === 2 && order.join(',') === 'a,d,c,b')
  check('and does not repeat them', order.length === 4)
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

  check(`cancel stops further work (${ranAtCancel} then ${ran} of 8)`, ran <= ranAtCancel + 2 && ran < 8)
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
  check('per-lane counts are exposed', subscriptionWorkerProgress.lanes.recovery.inFlight === 1)

  await sleep(300)

  check(
    'counters cleared when idle',
    subscriptionWorkerProgress.done === 0 &&
    subscriptionWorkerProgress.queued === 0 &&
    subscriptionWorkerProgress.inFlight === 0
  )
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

// The peak is reported for the run that produced it, and reading it resets it
{
  resetSubscriptionWorkerForTests()
  setSubscriptionWorkerDelayForTests(1)
  setSubscriptionBudgetForTests(5, 1000)

  takeSubscriptionPeakInFlight()

  enqueueSubscriptionJobs(
    LANE_REFRESH,
    Array.from({ length: 10 }, (_, i) => ({ key: `pk${i}`, run: () => sleep(30) }))
  )

  await sleep(400)

  const peak = takeSubscriptionPeakInFlight()

  check(`peak in flight is reported (${peak})`, peak > 1 && peak <= 5)
  check('and reading it resets it', takeSubscriptionPeakInFlight() === 0)
}

// Recovery is paced more slowly than the back-fill on purpose: it only runs
// because something already refused us
{
  const recovery = LANE_DELAYS_MS[LANE_RECOVERY]
  const enrichment = LANE_DELAYS_MS[LANE_ENRICHMENT]

  check(`recovery waits longer between requests than the back-fill (${recovery}ms vs ${enrichment}ms)`, recovery > enrichment)
  check(`the refresh is paced by the budget alone (${LANE_DELAYS_MS[LANE_REFRESH]}ms)`, LANE_DELAYS_MS[LANE_REFRESH] === 0)
}

// And the gap actually observed matches the lane that ran
{
  resetSubscriptionWorkerForTests()

  const started = []
  const jobs = lane => Array.from({ length: 3 }, (_, i) => ({
    key: `${lane}-timed-${i}`,
    run: async () => { started.push(Date.now()) }
  }))

  enqueueSubscriptionJobs(LANE_RECOVERY, jobs('r'))

  await sleep(LANE_DELAYS_MS[LANE_RECOVERY] * 3)

  const gaps = started.slice(1).map((time, i) => time - started[i])

  check(
    `recovery keeps its own gap between requests (${gaps.join(', ')}ms)`,
    started.length === 3 && gaps.every(gap => gap >= LANE_DELAYS_MS[LANE_RECOVERY] - 20)
  )
}

// The budget default is the measured one unless the environment says otherwise
resetSubscriptionWorkerForTests()

check(`budget defaults to the measured 50 (${subscriptionBudget()})`, subscriptionBudget() === 50)

cancelAllSubscriptionWork()

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nall checks passed')
