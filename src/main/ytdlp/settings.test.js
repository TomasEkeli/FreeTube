import { describe, expect, it } from 'vitest'

import { createSettingsReader, isRendererWritableYtDlpSetting, parseCustomArgs } from './settings'

describe('yt-dlp settings', () => {
  describe('which settings the renderer may write', () => {
    it('refuses a download folder or executable from the renderer', () => {
      expect(isRendererWritableYtDlpSetting('ytDlpDownloadFolder', '/etc')).toBe(false)
      expect(isRendererWritableYtDlpSetting('ytDlpExecutablePath', '/usr/bin/evil')).toBe(false)
      expect(isRendererWritableYtDlpSetting('ytDlpDownloadFolder', null)).toBe(false)
    })

    it('lets the renderer clear them back to the default', () => {
      expect(isRendererWritableYtDlpSetting('ytDlpDownloadFolder', '')).toBe(true)
      expect(isRendererWritableYtDlpSetting('ytDlpExecutablePath', '')).toBe(true)
    })

    it('leaves every other setting alone', () => {
      expect(isRendererWritableYtDlpSetting('ytDlpEnabled', true)).toBe(true)
      expect(isRendererWritableYtDlpSetting('ytDlpCustomArgs', '["-x"]')).toBe(true)
      expect(isRendererWritableYtDlpSetting('baseTheme', 'dark')).toBe(true)
    })
  })

  it('reads the default for a setting never stored', async () => {
    const read = createSettingsReader(async id => (id === 'useProxy' ? { _id: id, value: true } : null))

    expect(await read('useProxy')).toBe(true)
    expect(await read('proxyPort')).toBe('9050')
    expect(await read('ytDlpCustomArgs')).toBe('[]')
  })

  it('parses custom arguments only when they are a JSON array of strings', () => {
    expect(parseCustomArgs('["-f", "bestaudio"]')).toEqual(['-f', 'bestaudio'])
    expect(parseCustomArgs('[1, 2]')).toEqual([])
    expect(parseCustomArgs('not json')).toEqual([])
    expect(parseCustomArgs(undefined)).toEqual([])
  })
})
