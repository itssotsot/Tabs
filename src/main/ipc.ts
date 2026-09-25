import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type DownloadAction } from '@shared/api'
import type { AppInfo, AppNotification, Insets, Rect, SearchEngine, Settings, SidebarPanel, Suggestion } from '@shared/types'
import { isInternalUrl, toNavigableUrl } from '@shared/url'
import { signInWithGoogle } from './auth'
import { bookmarksChanged, settingsChanged, toggleBookmark } from './broadcast'
import { downloadAction, listDownloads } from './downloads'
import { webSession } from './env'
import { showAppMenu, showBookmarkContextMenu, showSiteInfoMenu, showTabContextMenu } from './menu'
import { showNotification } from './notifications'
import { omniboxSuggestions } from './omnibox'
import { warmUp } from './predictor'
import { store } from './store'
import { BrowserWindowController, controllerFor, focusedController } from './window'

type Controller = BrowserWindowController

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isWebUrl = (v: unknown): v is string => isString(v) && /^https?:\/\//i.test(v)

/** The window whose browser UI (or overlay) sent this message, or null for anyone else. */
function chromeOf(e: IpcMainEvent | IpcMainInvokeEvent): Controller | null {
  const c = controllerFor(e.sender)
  return c && c.isChrome(e.sender) ? c : null
}

/** True only for the top frame of a tab showing a browserr:// page. */
function fromInternalPage(e: IpcMainInvokeEvent): boolean {
  const c = controllerFor(e.sender)
  const frame = e.senderFrame
  return !!c?.tabFor(e.sender) && !!frame && frame === e.sender.mainFrame && isInternalUrl(frame.url)
}

function onChrome(channel: string, fn: (c: Controller, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    const c = chromeOf(e)
    if (c) fn(c, ...args)
  })
}

function handleChrome(channel: string, fn: (c: Controller, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    const c = chromeOf(e)
    if (!c) throw new Error('Not allowed')
    return fn(c, ...args)
  })
}

function handleInternal(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromInternalPage(e)) throw new Error('Not allowed')
    return fn(...args)
  })
}

const ENGINES: SearchEngine[] = ['google', 'duckduckgo', 'bing', 'brave']
const BOOLEAN_SETTINGS = ['adblock', 'notifications', 'showBookmarksBar', 'restoreSession', 'memorySaver'] as const

function sanitizeSettings(patch: unknown): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out
  const p = patch as Record<string, unknown>
  if (ENGINES.includes(p.searchEngine as SearchEngine)) out.searchEngine = p.searchEngine as SearchEngine
  for (const key of BOOLEAN_SETTINGS) if (typeof p[key] === 'boolean') out[key] = p[key] as boolean
  return out
}

function updateSettings(patch: unknown): Settings {
  store.updateSettings(sanitizeSettings(patch))
  settingsChanged()
  return store.settings
}

export function handleNotificationClick(n: AppNotification): void {
  const c = focusedController() ?? new BrowserWindowController()
  if (n.url && isWebUrl(n.url)) c.createTab(n.url)
  if (n.shareId) {
    for (const w of BrowserWindowController.all) w.sendCommand({ type: 'share-opened', shareId: n.shareId })
  }
  if (n.panel) c.sendCommand({ type: 'open-sidebar', panel: n.panel })
  c.focus()
}

const PANELS: SidebarPanel[] = ['inbox', 'sent', 'friends', 'downloads']

export function registerIpc(): void {
  // Tabs and navigation
  onChrome(IPC.tabCreate, (c, url) => c.createTab(isString(url) ? toNavigableUrl(url, store.settings.searchEngine) : undefined))
  onChrome(IPC.tabClose, (c, id) => isNumber(id) && c.closeById(id))
  onChrome(IPC.tabActivate, (c, id) => isNumber(id) && c.activateById(id))
  onChrome(IPC.tabMove, (c, id, to) => isNumber(id) && isNumber(to) && c.moveTab(id, to))
  onChrome(IPC.tabContextMenu, (c, id) => {
    const tab = isNumber(id) ? c.tabById(id) : undefined
    if (tab) showTabContextMenu(c, tab)
  })
  onChrome(IPC.tabToggleMute, (c, id) => (isNumber(id) ? c.tabById(id) : undefined)?.toggleMute())
  onChrome(IPC.navigate, (c, input) => isString(input) && c.navigate(toNavigableUrl(input, store.settings.searchEngine)))
  onChrome(IPC.navBack, (c) => c.activeTab?.goBack())
  onChrome(IPC.navForward, (c) => c.activeTab?.goForward())
  onChrome(IPC.navReload, (c) => c.activeTab?.reload())
  onChrome(IPC.navStop, (c) => c.activeTab?.wc.stop())
  onChrome(IPC.zoomReset, (c) => c.activeTab?.zoom('reset'))
  onChrome(IPC.openUrl, (c, url, background) => isWebUrl(url) && c.createTab(url, { active: background !== true }))

  // Browser UI layout and menus
  onChrome(IPC.setInsets, (c, insets) => {
    const i = insets as Insets
    if (i && isNumber(i.top) && isNumber(i.right)) c.setInsets({ top: Math.max(0, i.top), right: Math.max(0, i.right) })
  })
  onChrome(IPC.siteInfoMenu, (c) => showSiteInfoMenu(c))
  onChrome(IPC.appMenu, (c, x, y) => isNumber(x) && isNumber(y) && showAppMenu(c, x, y))

  // Address bar
  handleChrome(IPC.omniboxQuery, (_c, text) => (isString(text) ? omniboxSuggestions(text) : []))
  onChrome(IPC.omniboxShow, (c, items, selected, rect) => {
    if (Array.isArray(items) && isNumber(selected) && rect && typeof rect === 'object') {
      c.showSuggestions(items as Suggestion[], selected, rect as Rect)
      // Start connecting to whatever Enter would open, like Chrome's omnibox does.
      const target = (items as Suggestion[])[selected]?.url
      if (isWebUrl(target)) warmUp(webSession(), target, 2)
    }
  })
  onChrome(IPC.omniboxHide, (c) => c.hideSuggestions())

  // Find in page
  onChrome(IPC.findStart, (c, text, forward, findNext) => isString(text) && c.startFind(text, forward !== false, findNext === true))
  onChrome(IPC.findStop, (c) => c.stopFind())

  // Bookmarks
  onChrome(IPC.bookmarkToggle, (c) => toggleBookmark(c))
  handleChrome(IPC.bookmarksList, () => store.bookmarks)
  onChrome(IPC.bookmarkOpen, (c, url, newTab) => {
    if (!isString(url)) return
    if (newTab === true) c.createTab(url, { active: false })
    else c.navigate(url)
  })
  onChrome(IPC.bookmarkContextMenu, (c, id) => isString(id) && showBookmarkContextMenu(c, id))

  // Settings
  handleChrome(IPC.settingsGet, () => store.settings)
  handleChrome(IPC.settingsSet, (_c, patch) => updateSettings(patch))

  // Downloads
  handleChrome(IPC.downloadsList, () => listDownloads())
  onChrome(IPC.downloadAction, (_c, action, id) => isString(action) && downloadAction(action as DownloadAction, isString(id) ? id : undefined))

  // Sharing
  onChrome(IPC.shareOpenPicker, (c) => void c.openSendPickerForTab())
  ipcMain.on(IPC.pageAdblockEnabled, (e) => {
    e.returnValue = store.settings.adblock
  })
  ipcMain.on(IPC.pageShare, (e) => {
    const c = controllerFor(e.sender)
    const tab = c?.tabFor(e.sender)
    if (c && tab) void c.openSendPickerForTab(tab)
  })
  handleChrome(IPC.signInWithGoogle, async (c) => {
    try {
      return await signInWithGoogle()
    } finally {
      if (process.platform === 'darwin') app.focus({ steal: true })
      c.focus()
    }
  })
  onChrome(IPC.notify, (_c, n) => {
    const note = n as AppNotification
    if (note && isString(note.key) && isString(note.title) && isString(note.body)) showNotification(note, handleNotificationClick)
  })
  onChrome(IPC.setBadge, (_c, count) => isNumber(count) && app.setBadgeCount(Math.max(0, Math.floor(count))))

  // Overlay
  onChrome(IPC.overlayPick, (c, index) => isNumber(index) && c.pickSuggestion(index))
  onChrome(IPC.overlayClose, (c) => c.closeOverlay())
  onChrome(IPC.overlayOpenPanel, (c, panel) => {
    c.closeOverlay()
    if (PANELS.includes(panel as SidebarPanel)) c.sendCommand({ type: 'open-sidebar', panel: panel as SidebarPanel })
  })

  // Internal pages (browserr://...)
  handleInternal(IPC.internalHistory, (query, limit) =>
    store.searchHistory(isString(query) ? query : '', isNumber(limit) ? Math.min(Math.max(limit, 1), 1000) : 200)
  )
  handleInternal(IPC.internalHistoryRemove, (url) => isString(url) && store.removeHistory(url))
  handleInternal(IPC.internalHistoryClear, () => store.clearHistory())
  handleInternal(IPC.internalTopSites, () => store.topSites(8))
  handleInternal(IPC.internalBookmarks, () => store.bookmarks)
  handleInternal(IPC.internalBookmarkRemove, (id) => {
    if (!isString(id)) return
    store.removeBookmark(id)
    bookmarksChanged()
  })
  handleInternal(IPC.internalBookmarkRename, (id, title) => {
    if (!isString(id) || !isString(title)) return
    store.renameBookmark(id, title.slice(0, 300))
    bookmarksChanged()
  })
  handleInternal(IPC.internalSettingsGet, () => store.settings)
  handleInternal(IPC.internalSettingsSet, (patch) => updateSettings(patch))
  handleInternal(IPC.internalClearData, async () => {
    const ses = webSession()
    await ses.clearStorageData()
    await ses.clearCache()
    store.clearHistory()
    store.clearSitePermissions()
  })
  handleInternal(
    IPC.internalAppInfo,
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      isDefaultBrowser: app.isDefaultProtocolClient('https')
    })
  )
  handleInternal(IPC.internalMakeDefault, async () => {
    const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https')
    // Windows 10+ only lets the user pick the default browser in Settings.
    if (process.platform === 'win32') await shell.openExternal('ms-settings:defaultapps')
    return ok
  })
}
