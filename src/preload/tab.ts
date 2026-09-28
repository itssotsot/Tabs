// Runs in every web page, isolated from the page's own scripts.
// Regular sites get nothing exposed; browserr:// pages get the internal API.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type InternalAPI } from '@shared/api'
import { INTERNAL_SCHEME } from '@shared/url'
import { installAdBlocking } from './adblock'
import { installCallControls } from './call-controls'
import { installCapture } from './capture'
import { installSharedLinkGuard } from './links'
import { installBackgroundMediaHold } from './media'
import { installMediaControls } from './media-controls'
import { installPageColorHints } from './page-color'
import { installPermissionStates } from './permission-states'
import { pageSite } from './sites'
import { followTheme } from './theme'

// Preloads also run in iframes (so extensions' user scripts can reach them); these are for the page itself.
const isTopFrame = window.top === window

if (isTopFrame) installPageColorHints()

// In iframes too: calls are often embedded in other pages.
if (/^https?:$/.test(location.protocol)) {
  installCapture()
  installPermissionStates()
}

if (/^https?:$/.test(location.protocol) && isTopFrame) {
  const site = pageSite(location.hostname)
  // Before the background hold, which puts back whatever play() it found when it lets go.
  installMediaControls(site)
  installBackgroundMediaHold()
  installAdBlocking(site)
  installCallControls(site)
  installSharedLinkGuard()
}

if (location.protocol === `${INTERNAL_SCHEME}:` && isTopFrame) {
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
    makeDefaultBrowser: () => ipcRenderer.invoke(IPC.internalMakeDefault),
    extensions: () => ipcRenderer.invoke(IPC.internalExtensions),
    setExtensionEnabled: (id, enabled) => ipcRenderer.invoke(IPC.internalExtensionSetEnabled, id, enabled),
    removeExtension: (id) => ipcRenderer.invoke(IPC.internalExtensionRemove, id),
    openExtensionOptions: (id) => ipcRenderer.invoke(IPC.internalExtensionOptions, id),
    openWebStore: () => ipcRenderer.invoke(IPC.internalOpenWebStore),
    setExtensionPinned: (id, pinned) => ipcRenderer.invoke(IPC.internalExtensionSetPinned, id, pinned),
    openImport: () => ipcRenderer.invoke(IPC.internalOpenImport),
    siteAccess: () => ipcRenderer.invoke(IPC.internalSiteAccess),
    setSitePermission: (origin, permission, decision) => ipcRenderer.invoke(IPC.internalSetSitePermission, origin, permission, decision),
    forgetSite: (origin) => ipcRenderer.invoke(IPC.internalForgetSite, origin)
  }
  contextBridge.exposeInMainWorld('browserrInternal', api)
  followTheme()
}
