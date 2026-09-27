import { app, BrowserWindow, type WebContents } from 'electron'
import { INTERNAL_EVENT, type SenderTabInfo } from '@shared/extension-protocol'
import { NEW_TAB_URL } from '@shared/url'
import { browserEvents } from '../browser-events'
import type { Tab } from '../tab'
import { BrowserWindowController, controllerFor, focusedController } from '../window'
import { canSeeTabDetails, revokeActiveTab } from './access'
import { broadcastLive, emit, type CallContext } from './router'

/**
 * Chrome's view of our windows and tabs for the tabs and windows APIs.
 *
 * Tab ids are the id of the tab's page (its webContents), because Electron's own extension code
 * (tabs.sendMessage, scripting.executeScript, runtime.onMessage's sender.tab) uses those. A tab
 * that hasn't been opened since restore has no page yet and gets a stand-in id; a tab that wakes
 * from sleep gets a new page, and extensions hear about the new id through tabs.onReplaced.
 */

export const WINDOW_ID_NONE = -1
export const WINDOW_ID_CURRENT = -2
export const TAB_ID_NONE = -1

/** Windows that aren't browser windows: extension popups from windows.create({ type: 'popup' }). */
export interface ExtraWindow {
  readonly win: BrowserWindow
  readonly wc: WebContents
  readonly type: 'popup'
  readonly extensionId: string
  /** What it was opened with, reported as pendingUrl until it loads. */
  readonly requestedUrl?: string
}

const STAND_IN_BASE = 1_000_000
/** The tab group a tab is in (chrome.tabGroups), provided by that module; -1 for none. */
let groupIdOf: (tab: Tab, controller: BrowserWindowController) => number = () => -1

export function setGroupIdProvider(provider: (tab: Tab, controller: BrowserWindowController) => number): void {
  groupIdOf = provider
}
const tabIds = new WeakMap<Tab, number>()
const openers = new WeakMap<Tab, number>()
const extraWindows = new Set<ExtraWindow>()

export function chromeTabId(tab: Tab): number {
  const wc = tab.liveWc
  if (wc && !wc.isDestroyed()) return wc.id
  return tabIds.get(tab) ?? STAND_IN_BASE + tab.id
}

export function setOpener(tab: Tab, openerTabId: number): void {
  openers.set(tab, openerTabId)
}

export function windowIdOf(c: BrowserWindowController): number {
  return c.win.id
}

export interface FoundTab {
  tab: Tab
  controller: BrowserWindowController
  index: number
}

export function findTab(tabId: number): FoundTab | null {
  for (const controller of BrowserWindowController.all) {
    const tabs = controller.allTabs
    for (let index = 0; index < tabs.length; index++) {
      if (chromeTabId(tabs[index]) === tabId) return { tab: tabs[index], controller, index }
    }
  }
  return null
}

export function tabForWebContents(wc: WebContents): FoundTab | null {
  const controller = controllerFor(wc)
  const tab = controller?.tabFor(wc)
  if (!controller || !tab) return null
  return { tab, controller, index: controller.indexOf(tab) }
}

export function findWindow(windowId: number): BrowserWindowController | null {
  return [...BrowserWindowController.all].find((c) => !c.win.isDestroyed() && c.win.id === windowId) ?? null
}

export function findExtraWindow(windowId: number): ExtraWindow | null {
  return [...extraWindows].find((w) => !w.win.isDestroyed() && w.win.id === windowId) ?? null
}

export function extraWindowForWebContents(wc: WebContents): ExtraWindow | null {
  return [...extraWindows].find((w) => w.wc === wc) ?? null
}

export function allExtraWindows(): ExtraWindow[] {
  return [...extraWindows].filter((w) => !w.win.isDestroyed())
}

export function addExtraWindow(w: ExtraWindow): void {
  extraWindows.add(w)
  emit('windows.onCreated', (id) => [windowObject(w, false, id)])
  const tabId = w.wc.id
  emit('tabs.onCreated', (id) => [extraTabObject(w, id)])
  w.win.on('focus', () => emitFocus(w.win.id))
  w.win.once('closed', () => {
    extraWindows.delete(w)
    emit('tabs.onRemoved', [tabId, { windowId: w.win.id, isWindowClosing: true }])
    emit('windows.onRemoved', [w.win.id])
  })
}

/** The window an API call means by "current": the caller's own window, else the focused one. */
export function currentWindow(call?: CallContext): BrowserWindowController | null {
  if (call?.windowId !== undefined) {
    const own = findWindow(call.windowId)
    if (own) return own
  }
  return lastFocusedWindow()
}

export function lastFocusedWindow(): BrowserWindowController | null {
  return focusedController()
}

/** Resolves chrome.windows.WINDOW_ID_CURRENT and friends to a window. */
export function resolveWindow(windowId: number | undefined, call?: CallContext): BrowserWindowController | null {
  if (windowId === undefined || windowId === WINDOW_ID_CURRENT) return currentWindow(call)
  return findWindow(windowId)
}

// ---- Chrome objects ----

function tabUrl(tab: Tab): string {
  return tab.url
}

export function toChromeTab(tab: Tab, controller: BrowserWindowController, extensionId?: string): chrome.tabs.Tab {
  const id = chromeTabId(tab)
  const index = controller.indexOf(tab)
  const active = controller.activeTab === tab
  const state = tab.state
  const url = tabUrl(tab)
  const bounds = tab.loaded ? tab.view.getBounds() : null
  const out: chrome.tabs.Tab = {
    id,
    index,
    windowId: windowIdOf(controller),
    highlighted: active,
    active,
    pinned: tab.pinned,
    audible: state.audible,
    discarded: !tab.loaded,
    autoDiscardable: true,
    frozen: tab.isFrozen,
    mutedInfo: { muted: state.muted, ...(state.muted ? { reason: 'user' as chrome.tabs.MutedInfoReason } : {}) },
    incognito: false,
    selected: active,
    status: tab.isLoading ? 'loading' : 'complete',
    groupId: groupIdOf(tab, controller),
    lastAccessed: tab.lastActiveAt,
    width: bounds?.width,
    height: bounds?.height
  } as chrome.tabs.Tab
  const opener = openers.get(tab)
  if (opener !== undefined) out.openerTabId = opener
  if (!extensionId || canSeeTabDetails(extensionId, url, id)) {
    out.url = url
    out.title = url.startsWith(NEW_TAB_URL) ? 'New Tab' : state.title
    if (state.favicon) out.favIconUrl = state.favicon
  }
  return out
}

function extraTabObject(w: ExtraWindow, extensionId?: string): chrome.tabs.Tab {
  const url = w.wc.getURL()
  const [width, height] = w.win.getContentSize()
  const out = {
    id: w.wc.id,
    index: 0,
    windowId: w.win.id,
    highlighted: true,
    active: true,
    pinned: false,
    audible: w.wc.isCurrentlyAudible(),
    discarded: false,
    autoDiscardable: false,
    frozen: false,
    mutedInfo: { muted: w.wc.isAudioMuted() },
    incognito: false,
    selected: true,
    status: w.wc.isLoading() ? 'loading' : 'complete',
    groupId: -1,
    width,
    height
  } as chrome.tabs.Tab
  if (!extensionId || canSeeTabDetails(extensionId, url || w.requestedUrl || '', w.wc.id)) {
    out.url = url
    out.title = w.wc.getTitle()
    if (!url && w.requestedUrl) out.pendingUrl = w.requestedUrl
  }
  return out
}

export function extraTabFor(tabId: number, extensionId?: string): { window: ExtraWindow; tab: chrome.tabs.Tab } | null {
  const w = allExtraWindows().find((x) => x.wc.id === tabId)
  return w ? { window: w, tab: extraTabObject(w, extensionId) } : null
}

function windowState(win: BrowserWindow): chrome.windows.WindowState {
  const state = win.isFullScreen() ? 'fullscreen' : win.isMinimized() ? 'minimized' : win.isMaximized() ? 'maximized' : 'normal'
  return state as chrome.windows.WindowState
}

function windowObject(target: BrowserWindowController | ExtraWindow, populate: boolean, extensionId?: string): chrome.windows.Window {
  const win = target.win
  const b = win.getBounds()
  const isExtra = !(target instanceof BrowserWindowController)
  const out: chrome.windows.Window = {
    id: win.id,
    focused: win.isFocused(),
    top: b.y,
    left: b.x,
    width: b.width,
    height: b.height,
    incognito: false,
    type: isExtra ? 'popup' : 'normal',
    state: windowState(win),
    alwaysOnTop: win.isAlwaysOnTop()
  }
  if (populate) {
    out.tabs = isExtra
      ? [extraTabObject(target as ExtraWindow, extensionId)]
      : (target as BrowserWindowController).allTabs.map((t) => toChromeTab(t, target as BrowserWindowController, extensionId))
  }
  return out
}

export function toChromeWindow(c: BrowserWindowController, populate: boolean, extensionId?: string): chrome.windows.Window {
  return windowObject(c, populate, extensionId)
}

export function extraToChromeWindow(w: ExtraWindow, populate: boolean, extensionId?: string): chrome.windows.Window {
  return windowObject(w, populate, extensionId)
}

/** Every tab in every window, in window then tab order. */
export function allTabs(): FoundTab[] {
  const out: FoundTab[] = []
  for (const controller of BrowserWindowController.all) {
    if (controller.win.isDestroyed()) continue
    controller.allTabs.forEach((tab, index) => out.push({ tab, controller, index }))
  }
  return out
}

// ---- change events ----

interface Snapshot {
  windowId: number
  index: number
  active: boolean
  pinned: boolean
  status: 'loading' | 'complete'
  url: string
  title: string
  favIconUrl: string | undefined
  audible: boolean
  muted: boolean
  discarded: boolean
  frozen: boolean
}

const snapshots = new Map<Tab, Snapshot & { id: number }>()
const activeByWindow = new Map<number, number>()
let lastFocusedWindowId = WINDOW_ID_NONE

function snapshotOf(tab: Tab, c: BrowserWindowController): Snapshot {
  const state = tab.state
  return {
    windowId: windowIdOf(c),
    index: c.indexOf(tab),
    active: c.activeTab === tab,
    pinned: tab.pinned,
    status: tab.isLoading ? 'loading' : 'complete',
    url: tab.url,
    title: tab.url.startsWith(NEW_TAB_URL) ? 'New Tab' : state.title,
    favIconUrl: state.favicon ?? undefined,
    audible: state.audible,
    muted: state.muted,
    discarded: !tab.loaded,
    frozen: tab.isFrozen
  }
}

type ChangeInfo = chrome.tabs.OnUpdatedInfo

function changeInfoFor(prev: Snapshot, next: Snapshot): ChangeInfo {
  const info: Record<string, unknown> = {}
  if (prev.status !== next.status) info.status = next.status
  if (prev.url !== next.url) info.url = next.url
  if (prev.title !== next.title) info.title = next.title
  if (prev.favIconUrl !== next.favIconUrl && next.favIconUrl) info.favIconUrl = next.favIconUrl
  if (prev.pinned !== next.pinned) info.pinned = next.pinned
  if (prev.audible !== next.audible) info.audible = next.audible
  if (prev.muted !== next.muted) info.mutedInfo = { muted: next.muted }
  if (prev.discarded !== next.discarded) info.discarded = next.discarded
  if (prev.frozen !== next.frozen) info.frozen = next.frozen
  return info as ChangeInfo
}

const PRIVATE_KEYS = ['url', 'title', 'favIconUrl'] as const

function emitUpdated(tab: Tab, c: BrowserWindowController, info: ChangeInfo): void {
  const tabId = chromeTabId(tab)
  emit('tabs.onUpdated', (extensionId) => {
    const chromeTab = toChromeTab(tab, c, extensionId)
    const visible: Record<string, unknown> = { ...info }
    if (chromeTab.url === undefined) for (const key of PRIVATE_KEYS) delete visible[key]
    return Object.keys(visible).length ? [tabId, visible, chromeTab] : null
  })
}

/** Longest increasing subsequence of positions: tabs outside it are the ones that moved. */
function movedTabs(order: { tab: Tab; from: number }[]): Set<Tab> {
  const n = order.length
  const tails: number[] = []
  const prevIdx = new Array<number>(n).fill(-1)
  const tailIdx: number[] = []
  for (let i = 0; i < n; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < order[i].from) lo = mid + 1
      else hi = mid
    }
    tails[lo] = order[i].from
    tailIdx[lo] = i
    prevIdx[i] = lo > 0 ? tailIdx[lo - 1] : -1
  }
  const keep = new Set<number>()
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prevIdx[i]) keep.add(i)
  return new Set(order.filter((_, i) => !keep.has(i)).map((o) => o.tab))
}

function diffWindow(c: BrowserWindowController): void {
  if (c.win.isDestroyed()) return
  const windowId = windowIdOf(c)
  const tabs = c.allTabs
  const surviving: { tab: Tab; from: number }[] = []
  for (const tab of tabs) {
    const prev = snapshots.get(tab)
    const next = snapshotOf(tab, c)
    const id = chromeTabId(tab)
    if (!prev) {
      snapshots.set(tab, { ...next, id })
      emit('tabs.onCreated', (extensionId) => [toChromeTab(tab, c, extensionId)])
      continue
    }
    if (prev.id !== id) {
      // The tab got a new page (woken from sleep): same tab, new id.
      emit('tabs.onReplaced', [id, prev.id])
      revokeActiveTab(prev.id)
    }
    if (prev.windowId === windowId) surviving.push({ tab, from: prev.index })
    const info = changeInfoFor(prev, next)
    if (info.url !== undefined) revokeActiveTab(id)
    snapshots.set(tab, { ...next, id })
    if (Object.keys(info).length) emitUpdated(tab, c, info)
  }
  for (const tab of movedTabs(surviving)) {
    const prev = surviving.find((s) => s.tab === tab)!.from
    const to = c.indexOf(tab)
    if (prev !== to) emit('tabs.onMoved', [chromeTabId(tab), { windowId, fromIndex: prev, toIndex: to }])
  }
  const active = c.activeTab
  const activeId = active ? chromeTabId(active) : undefined
  if (activeId !== undefined && activeByWindow.get(windowId) !== activeId) {
    activeByWindow.set(windowId, activeId)
    emit('tabs.onActivated', [{ tabId: activeId, windowId }])
    emit('tabs.onHighlighted', [{ windowId, tabIds: [activeId] }])
  }
  scheduleCache()
}

function onTabLoading(tab: Tab): void {
  const found = allTabs().find((t) => t.tab === tab)
  const prev = snapshots.get(tab)
  if (!found || !prev) return
  const next = snapshotOf(tab, found.controller)
  // Only the loading state (and the URL, which changes with it) here; the rest comes with the window's update.
  const info = changeInfoFor(prev, next) as Record<string, unknown>
  const quick: Record<string, unknown> = {}
  if ('status' in info) quick.status = info.status
  if ('url' in info) quick.url = info.url
  if (!Object.keys(quick).length) return
  snapshots.set(tab, { ...prev, status: next.status, url: next.url, id: chromeTabId(tab) })
  if ('url' in quick) revokeActiveTab(chromeTabId(tab))
  emitUpdated(tab, found.controller, quick as ChangeInfo)
}

function emitFocus(windowId: number): void {
  if (windowId === lastFocusedWindowId) return
  lastFocusedWindowId = windowId
  emit('windows.onFocusChanged', [windowId])
}

let cacheTimer: NodeJS.Timeout | null = null

function scheduleCache(): void {
  if (cacheTimer) return
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    broadcastLive(INTERNAL_EVENT.tabsCache, [tabsCache()])
  }, 30)
}

export function tabsCache(): Record<number, SenderTabInfo> {
  const cache: Record<number, SenderTabInfo> = {}
  for (const { tab, controller, index } of allTabs()) {
    const active = controller.activeTab === tab
    cache[chromeTabId(tab)] = { windowId: windowIdOf(controller), index, active, highlighted: active, pinned: tab.pinned, discarded: !tab.loaded }
  }
  for (const w of allExtraWindows()) {
    cache[w.wc.id] = { windowId: w.win.id, index: 0, active: true, highlighted: true, pinned: false, discarded: false }
  }
  return cache
}

export function startTabsModel(): void {
  browserEvents.on('window-state', diffWindow)
  browserEvents.on('tab-loading', onTabLoading)
  browserEvents.on('tab-opened', (tab, opener) => setOpener(tab, chromeTabId(opener)))
  browserEvents.on('window-created', (c) => {
    emit('windows.onCreated', (id) => [toChromeWindow(c, false, id)])
  })
  browserEvents.on('window-focused', (c) => emitFocus(windowIdOf(c)))
  browserEvents.on('window-bounds', (c) => emit('windows.onBoundsChanged', (id) => [toChromeWindow(c, false, id)]))
  browserEvents.on('tab-webcontents-destroyed', (tab, wc) => {
    // Remember the id while the tab sleeps, so it keeps it until it wakes with a new page.
    tabIds.set(tab, wc.id)
    revokeActiveTab(wc.id)
  })
  browserEvents.on('tab-closed', (tab, c, windowClosing) => {
    const prev = snapshots.get(tab)
    const tabId = prev?.id ?? chromeTabId(tab)
    snapshots.delete(tab)
    revokeActiveTab(tabId)
    emit('tabs.onRemoved', [tabId, { windowId: windowIdOf(c), isWindowClosing: windowClosing }])
    scheduleCache()
  })
  browserEvents.on('window-closed', (c) => {
    const windowId = windowIdOf(c)
    activeByWindow.delete(windowId)
    emit('windows.onRemoved', [windowId])
    if (lastFocusedWindowId === windowId) lastFocusedWindowId = WINDOW_ID_NONE
  })
  // The whole app lost focus.
  app.on('browser-window-blur', () => {
    setTimeout(() => {
      if (!BrowserWindow.getFocusedWindow()) emitFocus(WINDOW_ID_NONE)
    }, 50)
  })
  // Tabs that exist already (windows opened before extensions loaded).
  for (const c of BrowserWindowController.all) diffWindow(c)
}
