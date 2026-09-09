import { selectLiveManifest } from '../src/renderer/helpers/player/liveManifest.js'

let failures = 0

function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    console.log(`FAIL ${name}`)
    failures++
  }
}

const dash = selectLiveManifest({
  dash_manifest_url: 'https://example.test/live.mpd',
  hls_manifest_url: 'https://example.test/live.m3u8',
  adaptive_formats: [{ url: 'https://example.test/video' }]
})
check('DASH has first priority', dash.src.endsWith('.mpd') && dash.mimeType === 'application/dash+xml')

const hls = selectLiveManifest({
  hls_manifest_url: 'https://example.test/live.m3u8',
  adaptive_formats: [{ url: 'https://example.test/video' }]
})
check('HLS is used when DASH is absent', hls.src.endsWith('.m3u8') && hls.mimeType === 'application/x-mpegurl')

const absent = selectLiveManifest({
  adaptive_formats: [{ signature_cipher: 's=signature' }]
})
check('adaptive formats alone are not a live manifest', absent === null)
check('missing streaming data has no live manifest', selectLiveManifest(null) === null)

process.exitCode = failures === 0 ? 0 : 1
