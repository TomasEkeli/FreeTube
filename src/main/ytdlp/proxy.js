import { buildProxyUrl } from '../utils'

// yt-dlp looks names up itself for socks5 and socks4 proxies, which would send
// every YouTube hostname to the local resolver, around Tor or whatever else
// the proxy is for. The socks5h and socks4a forms send the lookup through the
// proxy, as Chromium does for FreeTube's own traffic.
const REMOTE_DNS = {
  socks5: 'socks5h',
  socks4: 'socks4a',
}

/**
 * How yt-dlp is to go through FreeTube's proxy, for downloads and self-updates
 * alike: nothing when the proxy is off, a `--proxy` argument when it is on,
 * or, when it has credentials, the proxy environment variables yt-dlp also
 * reads, so that the password stays off the command line, where every other
 * user of the machine can read it.
 *
 * @param {(id: keyof typeof import('./settings').SETTING_DEFAULTS) => Promise<any>} readSetting
 * @returns {Promise<{ args: string[], env: Record<string, string> }>}
 */
export async function ytDlpProxy(readSetting) {
  if (!await readSetting('useProxy')) {
    return { args: [], env: {} }
  }

  const protocol = await readSetting('proxyProtocol')
  // FreeTube only takes credentials for HTTP proxies
  const withCredentials = protocol === 'http' || protocol === 'https'
  const username = withCredentials ? await readSetting('proxyUsername') : ''

  const url = buildProxyUrl({
    protocol: REMOTE_DNS[protocol] ?? protocol,
    hostname: await readSetting('proxyHostname'),
    port: await readSetting('proxyPort'),
    username,
    password: withCredentials ? await readSetting('proxyPassword') : '',
  })

  if (username) {
    return { args: [], env: { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url } }
  }

  return { args: ['--proxy', url], env: {} }
}
