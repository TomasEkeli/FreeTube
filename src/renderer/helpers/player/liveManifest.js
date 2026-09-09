const MANIFEST_TYPE_DASH = 'application/dash+xml'
const MANIFEST_TYPE_HLS = 'application/x-mpegurl'

export function selectLiveManifest(streamingData) {
  if (streamingData?.dash_manifest_url) {
    return { src: streamingData.dash_manifest_url, mimeType: MANIFEST_TYPE_DASH }
  }

  if (streamingData?.hls_manifest_url) {
    return { src: streamingData.hls_manifest_url, mimeType: MANIFEST_TYPE_HLS }
  }

  return null
}
