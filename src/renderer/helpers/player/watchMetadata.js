export function getLocalVideoTitle(videoInfo) {
  return videoInfo.primary_info?.title?.text?.trim() || videoInfo.basic_info?.title?.trim() || ''
}
