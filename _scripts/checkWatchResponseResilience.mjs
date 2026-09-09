import { getLocalVideoTitle } from '../src/renderer/helpers/player/watchMetadata.js'

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
  'null localised title falls back to the basic title',
  getLocalVideoTitle({
    primary_info: { title: null },
    basic_info: { title: 'Basic title' }
  }) === 'Basic title'
)

check(
  'localised title wins and is trimmed',
  getLocalVideoTitle({
    primary_info: { title: { text: ' Localised title ' } },
    basic_info: { title: 'Basic title' }
  }) === 'Localised title'
)

check(
  'empty localised title falls back to the basic title',
  getLocalVideoTitle({
    primary_info: { title: { text: ' ' } },
    basic_info: { title: 'Basic title' }
  }) === 'Basic title'
)

check(
  'missing title containers produce an empty title',
  getLocalVideoTitle({ primary_info: null }) === ''
)

process.exitCode = failures === 0 ? 0 : 1
