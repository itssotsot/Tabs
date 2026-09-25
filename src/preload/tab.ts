// Runs in every web page, isolated from the page's own scripts.
// Regular sites get nothing exposed; browserr:// pages get the internal API.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type InternalAPI } from '@shared/api'
import { INTERNAL_SCHEME } from '@shared/url'

if (location.protocol === `${INTERNAL_SCHEME}:`) {
  const api: InternalAPI = {
    history: (query, limit) => ipcRenderer.invoke(IPC.internalHistory, query, limit),
    removeHistory: (url) => ipcRenderer.invoke(IPC.internalHistoryRemove, url),
    clearHistory: () => ipcRenderer.invoke(IPC.internalHistoryClear),
    topSites: () => ipcRenderer.invoke(IPC.internalTopSites),
    bookmarks: () => ipcRenderer.invoke(IPC.internalBookmarks),
    removeBookmark: (id) => ipcRenderer.invoke(IPC.internalBookmarkRemove, id),
    renameBookmark: (id, title) => ipcRenderer.invoke(IPC.internalBookmarkRename, id, title),
    getSettings: () => ipcRenderer.invoke(IPC.internalSettingsGet),
    setSettings: (patch) => ipcRenderer.invoke(IPC.internalSettingsSet, patch),
    clearBrowsingData: () => ipcRenderer.invoke(IPC.internalClearData),
    appInfo: () => ipcRenderer.invoke(IPC.internalAppInfo),
    makeDefaultBrowser: () => ipcRenderer.invoke(IPC.internalMakeDefault)
  }
  contextBridge.exposeInMainWorld('browserrInternal', api)
}

if (/(^|\.)youtube\.com$/.test(location.hostname) && window.top === window) {
  const BUTTON_ID = 'browserr-send-button'
  const SVG_NS = 'http://www.w3.org/2000/svg'

  // Built with DOM APIs because YouTube enforces Trusted Types (no innerHTML).
  const makeButton = (): HTMLButtonElement => {
    const button = document.createElement('button')
    button.id = BUTTON_ID
    button.className = 'ytp-button'
    button.title = 'Send to a friend (⌘⇧S)'
    button.setAttribute('aria-label', 'Send to a friend')
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'top'
    })

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '60%')
    svg.setAttribute('height', '60%')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'white')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    for (const d of ['M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'm21.854 2.147-10.94 10.939']) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    }
    button.appendChild(svg)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      ipcRenderer.send(IPC.pageShare)
    })
    return button
  }

  const inject = (): void => {
    if (document.getElementById(BUTTON_ID)) return
    const controls = document.querySelector('#movie_player .ytp-right-controls')
    if (controls) controls.prepend(makeButton())
  }

  const start = (): void => {
    inject()
    // YouTube is a single-page app that rebuilds the player, so keep re-checking (at most once per frame).
    let scheduled = false
    new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        inject()
      })
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
