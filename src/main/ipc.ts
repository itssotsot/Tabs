import { app, clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type DownloadAction } from '@shared/api'
import { TAB_LAYOUTS } from '@shared/constants'
import type { AppInfo, AppNotification, Insets, Rect, SearchEngine, Settings, SidebarPanel, Suggestion, TabLayout } from '@shared/types'
import { isInternalUrl, pageKey, toNavigableUrl } from '@shared/url'
import { signInWithGoogle } from './auth'
import { bookmarksChanged, settingsChanged, toggleBookmark, toggleBookmarkUrl } from './broadcast'
import { downloadAction, listDownloads } from './downloads'
import { webSession } from './env'
import { extensionOptionsUrl, listExtensions, removeExtension, setExtensionEnabled, WEB_STORE_URL } from './extensions'
import { showAppMenu, showBookmarkContextMenu, showRendererMenu, showSiteInfoMenu, showTabContextMenu, showTabGroupMenu, showTabLayoutMenu } from './menu'
import { showNotification } from './notifications'
import { draftFromLink, draftFromUrl } from './share'
import { omniboxSuggestions } from './omnibox'
import { warmUp } from './predictor'
import { store } from './store'
import { installUpdate, pendingUpdate } from './updater'
import { BrowserWindowController, controllerFor, focusedController } from './window'

type Controller = BrowserWindowController

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** A rectangle from a renderer (getBoundingClientRect). */
const isRect = (v: unknown): v is Rect => {
  const r = v as Rect | null
  return !!r && typeof r === 'object' && [r.x, r.y, r.width, r.height].every(isNumber)
}
const isWebUrl = (v: unknown): v is string => isString(v) && /^https?:\/\//i.test(v)
/** A shared link's key: `${roomId}/${messageId}`, maybe with `#n`. */
const isLinkKey = (v: unknown): v is string => isString(v) && /^[\w-]{1,128}\/[\w-]{1,128}(#\d{1,3})?$/.test(v)

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

/** Like handleInternal, for requests that act on the page's own window. */
function handleInternalInWindow(channel: string, fn: (c: Controller, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    const c = controllerFor(e.sender)
    if (!c || !fromInternalPage(e)) throw new Error('Not allowed')
    return fn(c, ...args)
  })
}

const ENGINES: SearchEngine[] = ['google', 'duckduckgo', 'bing', 'brave']
const BOOLEAN_SETTINGS = ['adblock', 'notifications', 'restoreSession', 'memorySaver', 'groupTabsBySite'] as const
const MAX_UNGROUPED_SITES = 500
const SITE_RE = /^[a-z0-9.-]{1,253}$/

function sanitizeSettings(patch: unknown): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out
  const p = patch as Record<string, unknown>
  if (ENGINES.includes(p.searchEngine as SearchEngine)) out.searchEngine = p.searchEngine as SearchEngine
  if (TAB_LAYOUTS.some((l) => l.id === p.tabLayout)) out.tabLayout = p.tabLayout as TabLayout
  for (const key of BOOLEAN_SETTINGS) if (typeof p[key] === 'boolean') out[key] = p[key] as boolean
  if (Array.isArray(p.ungroupedSites)) {
    const sites = p.ungroupedSites.filter((s): s is string => isString(s) && SITE_RE.test(s))
    out.ungroupedSites = [...new Set(sites)].slice(0, MAX_UNGROUPED_SITES)
  }
  return out
}

function updateSettings(patch: unknown): Settings {
  store.updateSettings(sanitizeSettings(patch))
  settingsChanged()
  return store.settings
}

export function handleNotificationClick(n: AppNotification): void {
  const c = focusedController() ?? new BrowserWindowController()
  if (n.url && isWebUrl(n.url)) c.createTab(n.url, { fromLink: isLinkKey(n.linkKey) ? n.linkKey : undefined })
  if (isString(n.roomId)) {
    if (n.url) {
      for (const w of BrowserWindowController.all) w.sendCommand({ type: 'room-read', roomId: n.roomId })
    } else {
      c.sendCommand({ type: 'open-room', roomId: n.roomId })
    }
  }
  if (n.panel) c.sendCommand({ type: 'open-sidebar', panel: n.panel })
  c.focus()
}

const PANELS: SidebarPanel[] = ['inbox', 'friends', 'downloads']

export function registerIpc(): void {
  // Tabs and navigation
  onChrome(IPC.tabCreate, (c, url) => c.createTab(isString(url) ? toNavigableUrl(url, store.settings.searchEngine) : undefined))
  onChrome(IPC.tabClose, (c, id) => isNumber(id) && c.closeById(id))
  onChrome(IPC.tabActivate, (c, id) => isNumber(id) && c.activateById(id))
  onChrome(IPC.tabMove, (c, id, to, into) => {
    if (isNumber(id) && isNumber(to)) c.dragTab(id, to, isString(into) || into === null ? into : undefined)
  })
  onChrome(IPC.tabMoveGroup, (c, group, to) => isString(group) && isNumber(to) && c.moveGroup(group, to))
  onChrome(IPC.tabPeekGroup, (c, group, anchor) => isString(group) && isRect(anchor) && c.peekGroup(group, anchor))
  onChrome(IPC.tabUnpeekGroup, (c, now) => c.unpeekGroup(now === true))
  onChrome(IPC.tabGroupMenu, (c, group) => isString(group) && showTabGroupMenu(c, group))
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
  onChrome(IPC.pasteAndGo, async (c) => {
    const text = (await clipboard.readText()).trim()
    if (text) c.navigate(toNavigableUrl(text.slice(0, 4096), store.settings.searchEngine))
  })
  onChrome(IPC.openUrl, (c, url, background, fromLink) => {
    if (isWebUrl(url)) c.createTab(url, { active: background !== true, fromLink: isLinkKey(fromLink) ? fromLink : undefined })
  })

  // Browser UI layout and menus
  onChrome(IPC.setInsets, (c, insets) => {
    const i = insets as Insets
    if (i && isNumber(i.top) && isNumber(i.right)) {
      c.setInsets({ top: Math.max(0, i.top), right: Math.max(0, i.right), left: isNumber(i.left) ? Math.max(0, i.left) : 0 })
    }
  })
  onChrome(IPC.siteInfoMenu, (c) => showSiteInfoMenu(c))
  onChrome(IPC.appMenu, (c, x, y) => isNumber(x) && isNumber(y) && showAppMenu(c, x, y))
  onChrome(IPC.tabLayoutMenu, (c, x, y) => isNumber(x) && isNumber(y) && showTabLayoutMenu(c, x, y))
  handleChrome(IPC.showMenu, (c, items) => showRendererMenu(c, items))

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
  onChrome(IPC.bookmarkToggleUrl, (_c, url, title) => isWebUrl(url) && toggleBookmarkUrl(url, isString(title) ? title.slice(0, 500) : url))
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
  onChrome(IPC.shareOpenPickerForLink, (c, url, title) => {
    const draft = isWebUrl(url) ? draftFromLink(url, isString(title) ? title.slice(0, 500) : '') : null
    if (draft) c.openSendPicker(draft)
  })
  handleChrome(IPC.sharePreview, (_c, url) => {
    if (!isWebUrl(url) || url.length > 4096) return null
    // A tab that already shows the page has the best title (and is signed in, if the site needs it).
    const same = (a: string): string => a.replace(/#.*$/, '').replace(/\/+$/, '')
    const tab = [...BrowserWindowController.all].flatMap((w) => w.allTabs).find((t) => t.loaded && same(t.url) === same(url))
    return draftFromUrl(url, tab)
  })
  ipcMain.on(IPC.pageAdblockEnabled, (e) => {
    e.returnValue = store.settings.adblock
  })
  ipcMain.on(IPC.pageHoldMedia, (e) => {
    e.returnValue = controllerFor(e.sender)?.tabFor(e.sender)?.holdingMedia === true
  })
  // A link or search followed from a chat's link: true if it opened in a new tab, so the page stays put.
  ipcMain.on(IPC.pageLeaveSharedLink, (e, url) => {
    const c = controllerFor(e.sender)
    const tab = c?.tabFor(e.sender)
    const leave = !!c && !!tab && e.senderFrame === e.sender.mainFrame && isWebUrl(url) && tab.onSharedLink && pageKey(url) !== pageKey(tab.url)
    if (leave) c.openTab(url, { active: true, opener: tab })
    e.returnValue = leave
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

  // Updates
  handleChrome(IPC.updateGet, () => pendingUpdate())
  onChrome(IPC.updateInstall, () => void installUpdate())

  // Overlay
  onChrome(IPC.overlayPick, (c, index) => isNumber(index) && c.pickSuggestion(index))
  onChrome(IPC.overlayClose, (c) => c.closeOverlay())
  onChrome(IPC.overlayPeekHover, (c, inside) => c.peekHover('panel', inside === true))
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

  // Extensions
  handleInternal(IPC.internalExtensions, () => listExtensions())
  handleInternal(IPC.internalExtensionSetEnabled, async (id, enabled) => {
    if (isString(id) && typeof enabled === 'boolean') await setExtensionEnabled(id, enabled)
    return listExtensions()
  })
  handleInternal(IPC.internalExtensionRemove, async (id) => {
    if (isString(id)) await removeExtension(id)
    return listExtensions()
  })
  handleInternalInWindow(IPC.internalExtensionOptions, (c, id) => {
    const url = isString(id) ? extensionOptionsUrl(id) : null
    if (url) c.createTab(url)
  })
  handleInternalInWindow(IPC.internalOpenWebStore, (c) => void c.createTab(WEB_STORE_URL))
}
