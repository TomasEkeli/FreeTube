/**
 * The proxy URL from FreeTube's proxy settings, in the one place it is built,
 * for Electron's own proxy and for the programs FreeTube runs alike.
 *
 * Credentials are only included when given, and Electron is never given them
 * this way: it asks for them through its `login` event instead.
 *
 * @param {object} proxy
 * @param {string} proxy.protocol
 * @param {string} proxy.hostname
 * @param {string | number} proxy.port
 * @param {string} [proxy.username]
 * @param {string} [proxy.password]
 */
export function buildProxyUrl({ protocol, hostname, port, username, password }) {
  const credentials = username
    ? `${encodeURIComponent(username)}${password ? ':' + encodeURIComponent(password) : ''}@`
    : ''

  return `${protocol}://${credentials}${hostname}:${port}`
}

/**
 * @param {string | URL} url
 */
export function isFreeTubeUrl(url) {
  let url_

  if (url instanceof URL) {
    url_ = url
  } else {
    url_ = URL.parse(url)
  }

  if (process.env.NODE_ENV === 'development') {
    return url_ !== null && url_.protocol === 'http:' && url_.host === 'localhost:9080' && (url_.pathname === '/' || url_.pathname === '/index.html')
  } else {
    return url_ !== null && url_.protocol === 'app:' && url_.host === 'bundle' && (url_.pathname === '/' || url_.pathname === '/index.html')
  }
}
