import { app, clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type DownloadAction, type PageAdblock } from '@shared/api'
import { SITE_PERMISSIONS, TAB_LAYOUTS, THEMES } from '@shared/constants'
import type { AppInfo, AppNotification, CallDevice, CallState, CaptureDevice, DeviceChoice, ImportChoice, Insets, MediaCommand, OmniboxAnchor, PermissionAnswer, PermissionDecision, Rect, SearchEngine, Settings, SidebarPanel, SitePermission, Suggestion, TabCapture, TabLayout, TabMedia, ThemeId } from '@shared/types'
import { pageKey } from '@shared/links'
import { isInternalUrl, toNavigableUrl } from '@shared/url'
import { blocksAdsOn, scriptletsFor } from './adblock'
import { signInWithGoogle } from './auth'
import { bookmarksChanged, settingsChanged, toggleBookmark, toggleBookmarkUrl } from './broadcast'
import { downloadAction, listDownloads } from './downloads'
import { webSession } from './env'
import {
  activateAction,
  closeSidePanel,
  extensionOptionsUrl,
  extensionsForPage,
  removeExtension,
  setExtensionEnabled,
  setPinned,
  setSidePanelBounds,
  showExtensionContextMenu,
  showExtensionsMenu,
  toolbarFor,
  WEB_STORE_URL
} from './extensions'
import { showAppMenu, showBookmarkContextMenu, showCaptureMenu, showRendererMenu, showSiteInfoMenu, showTabContextMenu, showTabGroupMenu } from './menu'
import { answerPrompt } from './permission-prompts'
import { devicesFor, permissionStates } from './permissions'
import { showNotification } from './notifications'
import { findImportSources, openFullDiskAccessSettings, previewImport, runImport } from './import'
import { draftFromLink, draftFromUrl } from './share'
import { omniboxSuggestions } from './omnibox'
import { enterOmniboxInput, omniboxClosed } from './extensions/omnibox-bridge'
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
const isMediaCommand = (v: unknown): v is MediaCommand => {
  const c = v as MediaCommand | null
  return !!c && typeof c === 'object' && (c.type === 'toggle' || (c.type === 'seek' && isNumber(c.time)))
}
const isCallDevice = (v: unknown): v is CallDevice => v === 'mic' || v === 'camera'
/** A page's report on its call's own controls (see CallState); null if it's not in one or the report doesn't make sense. */
function callState(v: unknown): CallState | null {
  const c = v as CallState | null
  const isState = (x: unknown): x is boolean | null => x === null || typeof x === 'boolean'
  if (!c || typeof c !== 'object' || !isState(c.mic) || !isState(c.camera) || (c.mic === null && c.camera === null)) return null
  return { mic: c.mic, camera: c.camera }
}
/** A page's report on its video (see TabMedia), cleaned up; null if there's none or it doesn't make sense. */
function tabMedia(v: unknown): TabMedia | null {
  const m = v as TabMedia | null
  if (!m || typeof m !== 'object' || ![m.time, m.rate, m.at].every(isNumber)) return null
  if (m.duration !== null && !(isNumber(m.duration) && m.duration > 0)) return null
  return { paused: m.paused === true, time: Math.max(0, m.time), duration: m.duration, rate: Math.max(0, m.rate), at: m.at }
}
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
const BOOLEAN_SETTINGS = ['adblock', 'notifications', 'restoreSession', 'memorySaver', 'groupTabsBySite', 'showTabAge', 'showGroupLines'] as const
const MAX_UNGROUPED_SITES = 500
const SITE_RE = /^[a-z0-9.-]{1,253}$/
const ORIGIN_RE = /^https?:\/\/[^\s/]{1,253}$/
const MAX_DEVICE_NAME = 200

const isSitePermission = (v: unknown): v is SitePermission => isString(v) && v in SITE_PERMISSIONS
const isCaptureDevice = (v: unknown): v is CaptureDevice => v === 'camera' || v === 'microphone' || v === 'screen'
const deviceName = (v: unknown): string | null => (isString(v) && v.length > 0 && v.length <= MAX_DEVICE_NAME ? v : null)
function deviceChoice(v: unknown): DeviceChoice | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Record<string, unknown>
  return { camera: deviceName(d.camera), microphone: deviceName(d.microphone), speaker: deviceName(d.speaker) }
}
function permissionAnswer(v: unknown): PermissionAnswer | null {
  const a = v as PermissionAnswer | null
  if (!a || typeof a !== 'object' || !isNumber(a.id)) return null
  if (a.decision === 'open-system-settings') return { id: a.id, decision: a.decision }
  if (!['once', 'always', 'block', 'dismiss'].includes(a.decision)) return null
  const devices = 'devices' in a ? deviceChoice(a.devices) : null
  return { id: a.id, decision: a.decision, ...(devices && { devices }) }
}
/** A page's report on the devices it uses (see TabCapture). */
function tabCapture(v: unknown): TabCapture {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { camera: c.camera === true, microphone: c.microphone === true, screen: c.screen === true }
}

function sanitizeSettings(patch: unknown): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (!patch || typeof patch !== 'object') return out
  const p = patch as Record<string, unknown>
  if (ENGINES.includes(p.searchEngine as SearchEngine)) out.searchEngine = p.searchEngine as SearchEngine
  if (TAB_LAYOUTS.some((l) => l.id === p.tabLayout)) out.tabLayout = p.tabLayout as TabLayout
  if (THEMES.some((t) => t.id === p.theme)) out.theme = p.theme as ThemeId
  for (const key of BOOLEAN_SETTINGS) if (typeof p[key] === 'boolean') out[key] = p[key] as boolean
  if (Array.isArray(p.blockedPermissions)) out.blockedPermissions = [...new Set(p.blockedPermissions.filter(isSitePermission))]
  const devices = deviceChoice(p.devices)
  if (devices) out.devices = devices
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
  onChrome(IPC.tabCreate, (c, url) => {
    if (isString(url) && enterOmniboxInput(url.trim(), 'newForegroundTab')) return
    c.createTab(isString(url) ? toNavigableUrl(url, store.settings.searchEngine) : undefined)
  })
  onChrome(IPC.tabClose, (c, id) => isNumber(id) && c.closeById(id))
  onChrome(IPC.tabActivate, (c, id) => isNumber(id) && c.activateById(id))
  onChrome(IPC.tabMove, (c, id, to, into) => {
    if (isNumber(id) && isNumber(to)) c.dragTab(id, to, isString(into) || into === null ? into : undefined)
  })
  onChrome(IPC.tabMoveGroup, (c, group, to, place) => {
    if (isString(group) && isNumber(to)) c.moveGroup(group, to, place === 'before' || place === 'after' ? place : undefined)
  })
  onChrome(IPC.tabPeekGroup, (c, group, anchor) => isString(group) && isRect(anchor) && c.peekGroup(group, anchor))
  onChrome(IPC.tabUnpeekGroup, (c, now) => c.unpeekGroup(now === true))
  onChrome(IPC.tabGroupMenu, (c, group) => isString(group) && showTabGroupMenu(c, group))
  onChrome(IPC.tabContextMenu, (c, id) => {
    const tab = isNumber(id) ? c.tabById(id) : undefined
    if (tab) showTabContextMenu(c, tab)
  })
  onChrome(IPC.tabToggleMute, (c, id) => (isNumber(id) ? c.tabById(id) : undefined)?.toggleMute())
  onChrome(IPC.tabMedia, (c, id, command) => {
    if (isNumber(id) && isMediaCommand(command)) void c.tabById(id)?.controlMedia(command)
  })
  onChrome(IPC.tabStopCapture, (c, id, device) => {
    if (isNumber(id) && isCaptureDevice(device)) c.tabById(id)?.stopCapture(device)
  })
  onChrome(IPC.tabCall, (c, id, device) => {
    if (isNumber(id) && isCallDevice(device)) c.tabById(id)?.controlCall(device)
  })
  onChrome(IPC.navigate, (c, input) => {
    if (!isString(input) || enterOmniboxInput(input.trim(), 'currentTab')) return
    c.navigate(toNavigableUrl(input, store.settings.searchEngine))
  })
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
  onChrome(IPC.captureMenu, (c) => showCaptureMenu(c))
  onChrome(IPC.appMenu, (c, x, y) => isNumber(x) && isNumber(y) && showAppMenu(c, x, y))
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
  onChrome(IPC.omniboxAnchor, (c, anchor) => {
    const a = anchor as Partial<OmniboxAnchor> | null
    const color = (v: unknown): v is string => isString(v) && v.length < 1000
    const size = (v: unknown): v is number => isNumber(v) && v >= 0 && v < 100_000
    if (
      a &&
      isString(a.chromeClass) &&
      /^[\w -]{1,200}$/.test(a.chromeClass) &&
      size(a.left) &&
      size(a.top) &&
      size(a.before) &&
      size(a.after) &&
      color(a.background) &&
      color(a.foreground)
    ) {
      const { chromeClass, left, top, before, after, background, foreground } = a
      c.setOmniboxAnchor({ chromeClass, left, top, before, after, background, foreground })
    }
  })
  onChrome(IPC.omniboxHide, (c) => {
    c.hideSuggestions()
    omniboxClosed()
  })

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
  ipcMain.on(IPC.pageAdblock, (e, url) => {
    if (!store.settings.adblock || !isWebUrl(url) || !blocksAdsOn(url)) return void (e.returnValue = null)
    const adblock: PageAdblock = { scriptlets: scriptletsFor(e.sender.session, url) }
    e.returnValue = adblock
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
  ipcMain.on(IPC.pageMediaState, (e, media) => {
    const tab = controllerFor(e.sender)?.tabFor(e.sender)
    if (tab && e.senderFrame === e.sender.mainFrame) tab.setMedia(tabMedia(media))
  })
  ipcMain.on(IPC.pageCallState, (e, call) => {
    const tab = controllerFor(e.sender)?.tabFor(e.sender)
    if (tab && e.senderFrame === e.sender.mainFrame) tab.setCall(callState(call))
  })
  ipcMain.on(IPC.pageCapture, (e, capture) => {
    controllerFor(e.sender)?.tabFor(e.sender)?.setCapture(e.processId, e.frameId, tabCapture(capture))
  })
  ipcMain.handle(IPC.pagePermissionStates, (e) => {
    const url = e.senderFrame?.url
    return url && isWebUrl(url) ? permissionStates(e.sender, url) : null
  })
  ipcMain.handle(IPC.pageDevices, (e) => {
    const url = e.senderFrame?.url
    return url && isWebUrl(url) ? devicesFor(e.sender, url) : null
  })
  ipcMain.on(IPC.pageRepainted, (e, first) => {
    const tab = controllerFor(e.sender)?.tabFor(e.sender)
    if (tab && e.senderFrame === e.sender.mainFrame) tab.pageRepainted(first === true)
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

  // Not private, and every page of the browser's own needs it before it draws anything.
  ipcMain.on(IPC.themeGet, (e) => {
    e.returnValue = store.settings.theme
  })

  // First-run intro and importing from other browsers
  ipcMain.on(IPC.introPending, (e) => {
    // BROWSERR_INTRO=1 shows it on every launch of a development build, for working on it.
    const forced = !app.isPackaged && process.env.BROWSERR_INTRO === '1'
    e.returnValue = !!chromeOf(e) && (forced || !store.introDone)
  })
  onChrome(IPC.introFinish, () => {
    store.finishIntro()
    for (const w of BrowserWindowController.all) w.sendCommand({ type: 'intro-finished' })
  })
  handleChrome(IPC.importSources, () => findImportSources())
  handleChrome(IPC.importPreview, (_c, id) => previewImport(id))
  handleChrome(IPC.importRun, (c, id, choice) => {
    const what = choice as ImportChoice | null
    return runImport(id, { favorites: what?.favorites === true, history: what?.history === true, tabs: what?.tabs === true }, (tabs) =>
      c.importTabs(tabs)
    )
  })
  onChrome(IPC.importOpenAccess, () => openFullDiskAccessSettings())

  // Updates
  handleChrome(IPC.updateGet, () => pendingUpdate())
  onChrome(IPC.updateInstall, () => void installUpdate())

  // Overlay
  // Extension buttons and side panels
  handleChrome(IPC.extensionsGet, (c) => toolbarFor(c))
  onChrome(IPC.extensionActivate, (c, id, anchor) => isString(id) && isRect(anchor) && activateAction(c, id, anchor))
  onChrome(IPC.extensionContextMenu, (c, id) => isString(id) && showExtensionContextMenu(c, id))
  onChrome(IPC.extensionsMenu, (c, anchor) => isRect(anchor) && showExtensionsMenu(c, anchor))
  onChrome(IPC.extensionPanelBounds, (c, rect) => setSidePanelBounds(c, isRect(rect) ? rect : null))
  onChrome(IPC.extensionPanelClose, (c) => closeSidePanel(c))

  onChrome(IPC.overlayPick, (c, index) => isNumber(index) && c.pickSuggestion(index))
  onChrome(IPC.overlayClose, (c) => c.closeOverlay())
  onChrome(IPC.overlayPermissionAnswer, (_c, raw) => {
    const answer = permissionAnswer(raw)
    if (!answer) return
    // The devices you picked while answering are the ones sites use from now on.
    if ('devices' in answer && answer.devices && (answer.decision === 'once' || answer.decision === 'always')) updateSettings({ devices: answer.devices })
    answerPrompt(answer)
  })
  onChrome(IPC.overlayPromptHeight, (c, height) => isNumber(height) && c.setPromptHeight(height))
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
  handleInternal(IPC.internalExtensions, () => extensionsForPage())
  handleInternal(IPC.internalExtensionSetEnabled, async (id, enabled) => {
    if (isString(id) && typeof enabled === 'boolean') await setExtensionEnabled(id, enabled)
    return extensionsForPage()
  })
  handleInternal(IPC.internalExtensionRemove, async (id) => {
    if (isString(id)) await removeExtension(id)
    return extensionsForPage()
  })
  handleInternal(IPC.internalExtensionSetPinned, (id, pinned) => {
    if (isString(id) && typeof pinned === 'boolean') setPinned(id, pinned)
    return extensionsForPage()
  })
  handleInternalInWindow(IPC.internalExtensionOptions, (c, id) => {
    const url = isString(id) ? extensionOptionsUrl(id) : null
    if (url) c.createTab(url)
  })
  handleInternalInWindow(IPC.internalOpenWebStore, (c) => void c.createTab(WEB_STORE_URL))
  handleInternalInWindow(IPC.internalOpenImport, (c) => c.sendCommand({ type: 'show-import' }))
  handleInternal(IPC.internalSiteAccess, () => store.siteAccess())
  handleInternal(IPC.internalSetSitePermission, (origin, permission, decision) => {
    if (isString(origin) && ORIGIN_RE.test(origin) && isSitePermission(permission) && (decision === 'allow' || decision === 'deny' || decision === null)) {
      store.setPermission(origin, permission, decision as PermissionDecision | null)
    }
    return store.siteAccess()
  })
  handleInternal(IPC.internalForgetSite, (origin) => {
    if (isString(origin) && ORIGIN_RE.test(origin)) store.clearSitePermissions(origin)
    return store.siteAccess()
  })
}
