/**
 * The lines FreeTube asks yt-dlp to write about a download, and how to read
 * them: where the file will go, before any bytes arrive; how far each part
 * has got; when merging starts; where the file ended up. Tagged, so that
 * yt-dlp's own messages and anything a user's custom arguments print are
 * told apart from them.
 */

const TAG = '[freetube]'

/**
 * The arguments that make yt-dlp write these lines. They go before the custom
 * arguments, so that a user's own `--progress-template` or `--no-progress`
 * wins; progress then simply stops arriving.
 */
export function progressArgs() {
  return [
    // Before downloading: the formats (e.g. "401+251", video and audio), the
    // height of the video (NA for audio only), the audio codec, and the final
    // path, after merging
    '--print', `before_dl:${TAG}dest %(format_id)s %(height)s %(acodec)s %(filename)s`,
    // Once the file is in its final place
    '--print', `after_move:${TAG}done %(filepath)s`,
    // --print implies --quiet, which hides progress unless asked for
    '--progress',
    '--newline',
    '--progress-delta', '1',
    '--progress-template',
    `download:${TAG}progress %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.format_id)s %(info.vcodec)s %(info.acodec)s`,
    '--progress-template',
    `postprocess:${TAG}post %(progress.status)s %(progress.postprocessor)s`,
  ]
}

/**
 * @typedef {(
 *   { kind: 'dest', formatIds: string[], height: number | null, acodec: string | null, path: string } |
 *   { kind: 'progress', status: string, downloadedBytes: number | null, totalBytes: number | null, speed: number | null, eta: number | null, formatId: string, partKind: 'video' | 'audio' | 'both' | null } |
 *   { kind: 'post', status: string, postprocessor: string } |
 *   { kind: 'done', path: string }
 * )} ProgressLine
 */

/**
 * @param {string} line
 * @returns {ProgressLine | null} null for anything that is not one of ours
 */
export function parseProgressLine(line) {
  if (!line.startsWith(TAG)) {
    return null
  }

  const rest = line.slice(TAG.length)
  const space = rest.indexOf(' ')
  if (space === -1) {
    return null
  }

  const kind = rest.slice(0, space)
  const body = rest.slice(space + 1)

  switch (kind) {
    case 'dest': {
      const match = /^(\S+) (\S+) (\S+) (.+)$/.exec(body)
      if (!match || match[4] === 'NA') {
        return null
      }
      return {
        kind: 'dest',
        formatIds: match[1] === 'NA' ? [] : match[1].split('+'),
        height: toNumber(match[2]),
        acodec: match[3] === 'NA' || match[3] === 'none' ? null : match[3],
        path: match[4],
      }
    }

    case 'done':
      return body === 'NA' ? null : { kind: 'done', path: body }

    case 'progress': {
      const fields = body.split(' ')
      if (fields.length !== 9) {
        return null
      }

      const [status, downloaded, total, estimate, speed, eta, formatId, vcodec, acodec] = fields
      const hasVideo = vcodec !== 'none' && vcodec !== 'NA'
      const hasAudio = acodec !== 'none' && acodec !== 'NA'

      return {
        kind: 'progress',
        status,
        downloadedBytes: toNumber(downloaded),
        totalBytes: toNumber(total) ?? toNumber(estimate),
        speed: toNumber(speed),
        eta: toNumber(eta),
        formatId,
        partKind: hasVideo && hasAudio ? 'both' : hasVideo ? 'video' : hasAudio ? 'audio' : null,
      }
    }

    case 'post': {
      const match = /^(\S+) (\S+)$/.exec(body)
      return match ? { kind: 'post', status: match[1], postprocessor: match[2] } : null
    }
  }

  return null
}

/**
 * @param {string} field
 */
function toNumber(field) {
  const number = Number(field)
  return field !== 'NA' && field !== '' && Number.isFinite(number) ? number : null
}
