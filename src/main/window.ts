import { BrowserWindow, screen, WebContentsView, type ContextMenuParams, type Input, type Rectangle as ElectronRect, type Result, type WebContents } from 'electron'
import { IPC } from '@shared/api'
import {
  GROUP_PEEK_HEAD_HEIGHT,
  GROUP_PEEK_MARGIN,
  GROUP_PEEK_PADDING,
  GROUP_PEEK_ROW_HEIGHT,
  GROUP_PEEK_WIDTH,
  SUGGESTION_PADDING,
  SUGGESTION_ROW_HEIGHT
} from '@shared/constants'
import type { ChromeCommand, Insets, OmniboxAnchor, OverlayState, Rect, ShareDraft, Suggestion, TabLink, WindowState } from '@shared/types'
import { NEW_TAB_URL, pageKey } from '@shared/url'
import { browserEvents } from './browser-events'
import { extensionHooks } from './extension-hooks'
import { chromePreload, profile, uiUrl, webSession } from './env'
import { showChromeContextMenu, showPageContextMenu } from './menu'
import { warmUp } from './predictor'
import { draftFromTab } from './share'
import { arrangeGroups, groupKey, siteColor, siteGroups, siteName } from './sites'
import { store, type SavedTab, type SavedWindow } from './store'
import { Tab, type TabHost, type TabSnapshot } from './tab'

const isMac = process.platform === 'darwin'
const CHROME_BG = '#161618'
/** How often the active page's top color is re-read for the toolbar, for changes that come without a paint or scroll hint. */
const COLOR_SAMPLE_MS = 1000

/** Every webContents we own (UI, overlay, tabs) -> its window controller. */
const owners = new Map<number, BrowserWindowController>()
/** Recently closed tabs (with their history), most recent last. Shared across windows like Chrome. */
const closedTabs: SavedTab[] = []

function snapshotOf(saved: SavedTab): TabSnapshot {
  return {
    url: saved.url,
    title: saved.title ?? '',
    favicon: saved.favicon ?? null,
    entries: saved.entries?.map((e) => ({ url: e.url, title: e.title })),
    index: saved.index
  }
}

let lastFocused: BrowserWindowController | null = null
let sessionTimer: NodeJS.Timeout | null = null
let sessionFrozen = false

/** Recently closed tabs, most recent first (for chrome.sessions). */
export function recentlyClosedTabs(): readonly SavedTab[] {
  return [...closedTabs].reverse()
}

/** Reopens a recently closed tab (by its position in recentlyClosedTabs) in the window. Returns the new tab. */
export function reopenClosedTabAt(position: number, c: BrowserWindowController): Tab | null {
  const index = closedTabs.length - 1 - position
  const saved = closedTabs[index]
  if (!saved) return null
  closedTabs.splice(index, 1)
  return c.createTab(saved.url, { snapshot: snapshotOf(saved), fromLink: saved.fromLink })
}

export function controllerFor(wc: WebContents): BrowserWindowController | undefined {
  return owners.get(wc.id)
}

export function focusedController(): BrowserWindowController | null {
  const win = BrowserWindow.getFocusedWindow()
  const focused = [...BrowserWindowController.all].find((c) => c.win === win)
  return focused ?? (lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : null) ?? [...BrowserWindowController.all][0] ?? null
}

export function saveSessionNow(): void {
  // With no windows left, keep the last window's session. On Windows and Linux, closing the
  // last window quits the app, and before-quit only fires after that window is gone.
  if (sessionFrozen || !BrowserWindowController.all.size) return
  store.saveSession([...BrowserWindowController.all].map((c) => c.toSaved()))
}

/** Called on quit so windows closing one by one don't overwrite the saved session. */
export function freezeSession(): void {
  saveSessionNow()
  sessionFrozen = true
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = null
}

function scheduleSessionSave(): void {
  if (sessionTimer || sessionFrozen) return
  sessionTimer = setTimeout(() => {
    sessionTimer = null
    saveSessionNow()
  }, 1000)
}

function boundsOnScreen(bounds: ElectronRect | null | undefined): ElectronRect | undefined {
  if (!bounds) return undefined
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y
  })
  return visible ? bounds : undefined
}

export interface WindowOptions {
  urls?: string[]
  restore?: SavedWindow
}

export class BrowserWindowController implements TabHost {
  static readonly all = new Set<BrowserWindowController>()

  readonly win: BrowserWindow
  private readonly overlay: WebContentsView
  private tabs: Tab[] = []
  private active: Tab | null = null
  private insets: Insets = { top: 84, right: 0, left: 0 }
  private overlayState: OverlayState = { mode: 'hidden' }
  /** The collapsed group whose tabs the overlay shows, and whether the pointer is on its chip or the panel. */
  private peek: { group: string; anchor: Rect; overChip: boolean; overPanel: boolean } | null = null
  private peekTimer: NodeJS.Timeout | null = null
  private overlayAttached = false
  /** Where the address bar is and how it looks, reported by the browser UI. The send picker grows out of it. */
  private omniboxAnchor: OmniboxAnchor | null = null
  private fullscreenTab: Tab | null = null
  private enteredFullscreenForTab = false
  private stateTimer: NodeJS.Timeout | null = null
  /** Re-reads the active page's top color, so the toolbar follows it as you scroll. */
  private colorTimer: NodeJS.Timeout
  /** Sites whose group was broken up with Ungroup. It forms again when another tab from the site opens. */
  private readonly suspendedSites = new Set<string>()

  constructor(options: WindowOptions = {}) {
    const saved = options.restore
    const bounds = boundsOnScreen(saved?.bounds)
    this.win = new BrowserWindow({
      width: 1360,
      height: 880,
      ...bounds,
      minWidth: 560,
      minHeight: 380,
      show: false,
      title: 'Tabs',
      backgroundColor: CHROME_BG,
      titleBarStyle: 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: CHROME_BG, symbolColor: '#d4d4d8', height: 40 } }),
      webPreferences: {
        preload: chromePreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    if (saved?.maximized) this.win.maximize()

    this.overlay = new WebContentsView({
      webPreferences: { preload: chromePreload, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.overlay.setBackgroundColor('#00000000')

    BrowserWindowController.all.add(this)
    owners.set(this.win.webContents.id, this)
    owners.set(this.overlay.webContents.id, this)
    lastFocused = this

    this.wireWindow()

    this.win.webContents.loadURL(uiUrl('index'))
    this.overlay.webContents.loadURL(uiUrl('overlay'))

    if (saved?.tabs.length) {
      // Only the tab you'll see loads now; the rest load when you open them.
      for (const t of saved.tabs) {
        const tab = new Tab(this, t.url, { lazy: true, snapshot: snapshotOf(t) })
        tab.pinned = t.pinned
        if (t.fromLink) tab.openedFrom(t.fromLink.key, t.fromLink.landedUrl)
        if (t.createdAt) tab.createdAt = t.createdAt
        if (t.joinedGroup) tab.joinedGroup = t.joinedGroup
        this.tabs.push(tab)
      }
      this.regroup()
      this.activate(this.tabs[Math.min(saved.activeIndex, this.tabs.length - 1)] ?? this.tabs[0])
    } else if (options.urls?.length) {
      options.urls.forEach((url, i) => this.createTab(url, { active: i === 0 }))
    } else {
      this.createTab(NEW_TAB_URL)
    }

    this.win.once('ready-to-show', () => this.win.show())
    this.colorTimer = setInterval(() => {
      if (this.win.isFocused() && this.active?.loaded) void this.active.sampleColor()
    }, COLOR_SAMPLE_MS)
    browserEvents.emit('window-created', this)
  }

  // ---- window plumbing ----

  private wireWindow(): void {
    const chrome = this.win.webContents
    chrome.on('will-navigate', (e) => e.preventDefault())
    chrome.setWindowOpenHandler(() => ({ action: 'deny' }))
    chrome.on('did-finish-load', () => this.pushState())
    chrome.on('before-input-event', (e, input) => {
      if (this.handleInput(input)) e.preventDefault()
    })
    chrome.on('context-menu', (_e, params) => showChromeContextMenu(this, chrome, params))

    const overlay = this.overlay.webContents
    overlay.on('will-navigate', (e) => e.preventDefault())
    overlay.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlay.on('before-input-event', (e, input) => {
      if (this.handleInput(input)) e.preventDefault()
    })
    overlay.on('context-menu', (_e, params) => showChromeContextMenu(this, overlay, params))

    this.win.on('resize', () => this.layout())
    this.win.on('enter-full-screen', () => this.scheduleState())
    this.win.on('leave-full-screen', () => {
      if (this.fullscreenTab) {
        void this.fullscreenTab.wc.executeJavaScript('document.exitFullscreen?.()', true).catch(() => {})
      }
      this.scheduleState()
    })
    this.win.on('focus', () => {
      lastFocused = this
      browserEvents.emit('window-focused', this)
    })
    this.win.on('moved', () => {
      scheduleSessionSave()
      browserEvents.emit('window-bounds', this)
    })
    this.win.on('resized', () => {
      scheduleSessionSave()
      browserEvents.emit('window-bounds', this)
    })
    this.win.on('closed', () => this.dispose())
  }

  private dispose(): void {
    clearInterval(this.colorTimer)
    BrowserWindowController.all.delete(this)
    for (const [id, owner] of owners) if (owner === this) owners.delete(id)
    for (const tab of this.tabs) {
      browserEvents.emit('tab-closed', tab, this, true)
      tab.destroy()
    }
    this.tabs = []
    browserEvents.emit('window-closed', this)
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close()
    if (lastFocused === this) lastFocused = null
    // Closing the last window keeps its tabs in the session, so reopening the app restores them.
    if (BrowserWindowController.all.size > 0) scheduleSessionSave()
  }

  isChrome(wc: WebContents): boolean {
    return wc === this.win.webContents || wc === this.overlay.webContents
  }

  tabById(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  indexOf(tab: Tab): number {
    return this.tabs.indexOf(tab)
  }

  tabFor(wc: WebContents): Tab | undefined {
    return this.tabs.find((t) => t.liveWc === wc)
  }

  get allTabs(): readonly Tab[] {
    return this.tabs
  }

  onWebContentsCreated(tab: Tab, wc: WebContents): void {
    owners.set(wc.id, this)
    browserEvents.emit('tab-webcontents-created', tab, wc)
  }

  onWebContentsDestroyed(tab: Tab, wc: WebContents): void {
    owners.delete(wc.id)
    browserEvents.emit('tab-webcontents-destroyed', tab, wc)
  }

  get activeTab(): Tab | null {
    return this.active
  }

  toSaved(): SavedWindow {
    return {
      bounds: this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      tabs: this.tabs.filter((t) => !t.url.startsWith(NEW_TAB_URL) || t.pinned).map((t) => t.toSaved()),
      activeIndex: Math.max(0, this.active ? this.tabs.filter((t) => !t.url.startsWith(NEW_TAB_URL) || t.pinned).indexOf(this.active) : 0)
    }
  }

  sendCommand(cmd: ChromeCommand): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.command, cmd)
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  setInsets(insets: Insets): void {
    this.insets = insets
    this.layout()
  }

  private layout(): void {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    if (this.active) {
      this.active.view.setBounds(
        this.fullscreenTab === this.active
          ? { x: 0, y: 0, width, height }
          : {
              x: this.insets.left,
              y: this.insets.top,
              width: Math.max(0, width - this.insets.left - this.insets.right),
              height: Math.max(0, height - this.insets.top)
            }
      )
    }
    if (this.overlayState.mode === 'send') this.overlay.setBounds({ x: 0, y: 0, width, height })
  }

  private scheduleState(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.pushState()
    }, 16)
  }

  pushState(): void {
    if (this.win.isDestroyed()) return
    const active = this.active
    const groups = this.currentGroups()
    const groupNames: Record<string, string> = {}
    const groupColors: Record<string, string> = {}
    for (const site of groups.values()) {
      groupNames[site] ??= siteName(site)
      groupColors[site] ??= siteColor(site)
    }
    const state: WindowState = {
      tabs: this.tabs.map((t) => ({ ...t.state, group: groups.get(t) ?? null })),
      groupNames,
      groupColors,
      activeTabId: active?.id ?? null,
      htmlFullscreen: !!this.fullscreenTab,
      fullscreen: this.win.isFullScreen(),
      isBookmarked: !!active && !active.isInternal && !!store.findBookmark(active.url),
      profile
    }
    this.win.webContents.send(IPC.windowState, state)
    // The group panel follows its tabs (titles, closing, switching).
    if (this.peek) this.showPeek()
    const app = profile ? `Tabs (${profile})` : 'Tabs'
    this.win.setTitle(active ? `${active.state.title} – ${app}` : app)
    scheduleSessionSave()
    browserEvents.emit('window-state', this)
  }

  // ---- tabs ----

  createTab(
    url: string = NEW_TAB_URL,
    options: { active?: boolean; index?: number; lazy?: boolean; snapshot?: TabSnapshot; fromLink?: string | TabLink } = {}
  ): Tab {
    const background = options.active === false && !!this.active
    const tab = new Tab(this, url, { lazy: options.lazy || !!options.snapshot, snapshot: options.snapshot, background })
    const link = options.fromLink
    if (link) tab.openedFrom(typeof link === 'string' ? link : link.key, typeof link === 'string' ? undefined : link.landedUrl)
    const index = options.index ?? this.tabs.length
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab)
    this.placeTab(tab)
    if (options.active !== false || !this.active) this.activate(tab)
    if (options.active !== false && url === NEW_TAB_URL) {
      this.focusOmnibox()
      // A new tab usually leads to one of your regular sites; get their connections ready.
      for (const site of store.topSites(4)) warmUp(webSession(), site.url)
    }
    this.scheduleState()
    return tab
  }

  openTab(url: string, { active, opener }: { active: boolean; opener: Tab }): void {
    const tab = this.createTab(url, { active, index: this.tabs.indexOf(opener) + 1 })
    browserEvents.emit('tab-opened', tab, opener, url)
  }

  activate(tab: Tab): void {
    if (this.active === tab) return
    if (this.active) {
      this.active.wc.stopFindInPage('clearSelection')
      this.win.contentView.removeChildView(this.active.view)
      this.active.lastActiveAt = Date.now()
    }
    tab.lastActiveAt = Date.now()
    void tab.thaw()
    tab.releaseMedia()
    this.active = tab
    // Index 0 keeps the tab under the overlay when both are attached.
    this.win.contentView.addChildView(tab.view, 0)
    this.layout()
    tab.wc.focus()
    this.win.webContents.send(IPC.findState, { open: false, matches: 0, activeMatch: 0 })
    this.scheduleState()
    void tab.sampleColor()
  }

  activateById(id: number): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab) this.activate(tab)
  }

  closeTab(tab: Tab): void {
    const index = this.tabs.indexOf(tab)
    if (index === -1) return
    if (!tab.url.startsWith(NEW_TAB_URL)) {
      closedTabs.push(tab.toSaved())
      if (closedTabs.length > 25) closedTabs.shift()
    }
    this.tabs.splice(index, 1)
    browserEvents.emit('tab-closed', tab, this, false)
    if (this.fullscreenTab === tab) this.onTabFullscreen(tab, false)
    if (this.active === tab) {
      this.win.contentView.removeChildView(tab.view)
      this.active = null
      const next = this.tabs[index] ?? this.tabs[index - 1]
      if (next) this.activate(next)
    }
    tab.destroy()
    // Closing the last tab leaves the window open on a new tab; Close Window (⇧⌘W) is how you close it.
    if (!this.tabs.length) {
      this.createTab(NEW_TAB_URL)
      return
    }
    // A group down to one tab breaks up, and that tab joins the ones in no group.
    this.arrange()
  }

  closeById(id: number): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab) this.closeTab(tab)
  }

  closeActiveTab(): void {
    if (this.active) this.closeTab(this.active)
  }

  closeOtherTabs(keep: Tab): void {
    for (const tab of [...this.tabs]) if (tab !== keep && !tab.pinned) this.closeTab(tab)
  }

  closeTabsToRight(of: Tab): void {
    for (const tab of this.tabs.slice(this.tabs.indexOf(of) + 1)) this.closeTab(tab)
  }

  reopenClosedTab(): void {
    const last = closedTabs.pop()
    if (!last) return
    this.createTab(last.url, { snapshot: snapshotOf(last), fromLink: last.fromLink })
  }

  duplicateTab(tab: Tab): void {
    this.createTab(tab.url, { index: this.tabs.indexOf(tab) + 1, snapshot: snapshotOf(tab.toSaved()) })
  }

  moveTab(id: number, toIndex: number): void {
    const from = this.tabs.findIndex((t) => t.id === id)
    if (from === -1) return
    const [tab] = this.tabs.splice(from, 1)
    // Pinned tabs stay in front of unpinned ones.
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    const clamped = tab.pinned ? Math.min(toIndex, pinnedCount) : Math.max(toIndex, pinnedCount)
    this.tabs.splice(Math.min(clamped, this.tabs.length), 0, tab)
    this.scheduleState()
  }

  setPinned(tab: Tab, pinned: boolean): void {
    tab.pinned = pinned
    // Pinning moves the tab to the end of the pinned tabs; unpinning to just after them (or into its site's group).
    this.moveTab(tab.id, this.tabs.filter((t) => t.pinned && t !== tab).length)
    this.arrange(pinned ? undefined : tab)
  }

  /**
   * A tab dragged to a new place. With `into`, the list said where it landed: in that group (a site's),
   * or in no group for null. Without it, dropping it away from the rest of its group takes it out of the
   * group until it goes to another site; dropping it back next to its site's tabs puts it back.
   */
  dragTab(id: number, toIndex: number, into?: string | null): void {
    const tab = this.tabById(id)
    if (!tab) return
    if (into !== undefined && !tab.pinned) {
      this.moveTab(id, toIndex)
      if (into === null) this.leaveGroups(tab)
      else {
        tab.joinedGroup = into === tab.site ? null : into
        tab.pulledOutOf = null
      }
      this.arrange()
      return
    }
    const wasGrouped = this.currentGroups().has(tab)
    this.moveTab(id, toIndex)
    const key = groupKey(tab)
    const i = this.tabs.indexOf(tab)
    const sameGroup = (t: Tab | undefined): boolean => !!t && !t.pinned && groupKey(t) === key && t.pulledOutOf !== key
    const nextToGroup = sameGroup(this.tabs[i - 1]) || sameGroup(this.tabs[i + 1])
    if (wasGrouped && !nextToGroup) this.leaveGroups(tab)
    else if (tab.pulledOutOf && nextToGroup) tab.pulledOutOf = null
    this.arrange()
  }

  // ---- site groups ----

  /** The group each tab is in: its site, when grouping is on and at least two tabs share it. */
  private currentGroups(): Map<Tab, string> {
    const { groupTabsBySite, ungroupedSites } = store.settings
    if (!groupTabsBySite) return new Map()
    return siteGroups(this.tabs, new Set([...ungroupedSites, ...this.suspendedSites]))
  }

  /** Keeps each group's tabs together. `moved` joins the end of its group. */
  private arrange(moved?: Tab): void {
    this.dropBrokenJoins()
    const order = arrangeGroups(this.tabs, this.currentGroups(), moved)
    if (order) this.tabs = order
    this.scheduleState()
  }

  /**
   * A tab dragged into a group that has since broken up (its other tabs closed) goes back to its own site.
   * Not while grouping is off or the group was ungrouped: the tab comes back with the group.
   */
  private dropBrokenJoins(): void {
    const { groupTabsBySite, ungroupedSites } = store.settings
    if (!groupTabsBySite) return
    const groups = this.currentGroups()
    for (const tab of this.tabs) {
      const joined = tab.joinedGroup
      if (joined && !groups.has(tab) && !ungroupedSites.includes(joined) && !this.suspendedSites.has(joined)) tab.joinedGroup = null
    }
  }

  /** Puts a tab that just opened or went to another site into its group (its site's, unless it was dragged into another). */
  private placeTab(tab: Tab): void {
    if (!this.tabs.includes(tab)) return
    const site = tab.site
    tab.groupedSite = site
    tab.pulledOutOf = null
    // Another tab from a site that was ungrouped brings its group back.
    if (site) this.suspendedSites.delete(site)
    this.arrange(tab)
  }

  /** Groups every tab again, e.g. after the grouping settings change. */
  regroup(): void {
    for (const tab of this.tabs) tab.groupedSite = tab.site
    this.arrange()
  }

  groupOf(tab: Tab): string | undefined {
    return this.currentGroups().get(tab)
  }

  groupTabs(site: string): Tab[] {
    const groups = this.currentGroups()
    return this.tabs.filter((t) => groups.get(t) === site)
  }

  /** Moves a whole group to where it was dropped: onto the tab at `toIndex`, like dragging a single tab. */
  /**
   * Moves a site group's tabs, together, next to the tab at `toIndex` (or that tab's whole group). `place` says
   * which side; without it, the group goes past the tab in the direction it moved.
   */
  moveGroup(site: string, toIndex: number, place?: 'before' | 'after'): void {
    const groups = this.currentGroups()
    const members = this.tabs.filter((t) => groups.get(t) === site)
    const target = this.tabs[toIndex]
    if (!members.length || !target || members.includes(target)) return
    const after = place ? place === 'after' : toIndex > this.tabs.indexOf(members[0])
    // Dropped on another group, it goes before or after that whole group.
    const other = groups.get(target)
    const edge = other ? (after ? this.tabs.findLast((t) => groups.get(t) === other)! : this.tabs.find((t) => groups.get(t) === other)!) : target
    const rest = this.tabs.filter((t) => !members.includes(t))
    const at = Math.max(rest.indexOf(edge) + (after ? 1 : 0), rest.filter((t) => t.pinned).length)
    rest.splice(at, 0, ...members)
    this.tabs = rest
    this.arrange()
  }

  closeGroup(site: string): void {
    // The active tab goes last, so closing doesn't switch to (and load) a tab that's about to close too.
    const tabs = this.groupTabs(site).sort((a, b) => Number(a === this.active) - Number(b === this.active))
    for (const tab of tabs) this.closeTab(tab)
  }

  ungroup(site: string): void {
    this.suspendedSites.add(site)
    this.arrange()
  }

  removeFromGroup(tab: Tab): void {
    if (!this.groupOf(tab)) return
    this.leaveGroups(tab)
    this.arrange()
  }

  /** Takes a tab out of the group it was dragged into and its own site's, until it goes to another site. */
  private leaveGroups(tab: Tab): void {
    tab.joinedGroup = null
    tab.pulledOutOf = tab.site
  }

  cycleTab(delta: number): void {
    if (!this.active || this.tabs.length < 2) return
    const i = this.tabs.indexOf(this.active)
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length])
  }

  selectTab(index: number): void {
    // Cmd+9 always means "last tab".
    const tab = index >= 8 ? this.tabs.at(-1) : this.tabs[index]
    if (tab) this.activate(tab)
  }

  navigate(url: string): void {
    const active = this.active
    // A chat's link stays open in its tab.
    if (active?.onSharedLink && pageKey(url) !== pageKey(active.url)) return this.openTab(url, { active: true, opener: active })
    const tab = active ?? this.createTab(url)
    tab.load(url)
    tab.wc.focus()
  }

  onTabEdge(tab: Tab, edge: { color: string; edge: string[] }): void {
    if (tab === this.active && !this.win.isDestroyed()) this.win.webContents.send(IPC.pageEdge, { tabId: tab.id, ...edge })
  }

  onTabUpdated(tab: Tab): void {
    if (tab.site !== tab.groupedSite) this.placeTab(tab)
    this.scheduleState()
  }

  focusOmnibox(): void {
    this.win.webContents.focus()
    this.sendCommand({ type: 'focus-omnibox' })
  }

  // ---- fullscreen video ----

  onTabFullscreen(tab: Tab, fullscreen: boolean): void {
    if (fullscreen) {
      this.fullscreenTab = tab
      if (!this.win.isFullScreen()) {
        this.enteredFullscreenForTab = true
        this.win.setFullScreen(true)
      }
    } else if (this.fullscreenTab === tab) {
      this.fullscreenTab = null
      if (this.enteredFullscreenForTab) {
        this.enteredFullscreenForTab = false
        this.win.setFullScreen(false)
      }
    }
    this.layout()
    this.scheduleState()
  }

  // ---- find in page ----

  startFind(text: string, forward: boolean, findNext: boolean): void {
    if (!this.active) return
    if (!text) {
      this.active.wc.stopFindInPage('clearSelection')
      this.win.webContents.send(IPC.findState, { open: true, matches: 0, activeMatch: 0 })
      return
    }
    this.active.wc.findInPage(text, { forward, findNext })
  }

  stopFind(): void {
    this.active?.wc.stopFindInPage('clearSelection')
    this.active?.wc.focus()
  }

  onFindResult(tab: Tab, result: Result): void {
    if (tab !== this.active) return
    this.win.webContents.send(IPC.findState, {
      open: true,
      matches: result.matches,
      activeMatch: result.activeMatchOrdinal
    })
  }

  // ---- overlay (address-bar dropdown and send picker) ----

  private attachOverlay(): void {
    // Re-adding moves the view to the top of the stack.
    this.win.contentView.addChildView(this.overlay)
    this.overlayAttached = true
  }

  private detachOverlay(): void {
    if (!this.overlayAttached) return
    this.win.contentView.removeChildView(this.overlay)
    this.overlayAttached = false
  }

  private setOverlay(state: OverlayState): void {
    if (state.mode !== 'group') this.forgetPeek()
    const wasSend = this.overlayState.mode === 'send'
    this.overlayState = state
    this.overlay.webContents.send(IPC.overlayState, state)
    // The address bar squares off while the picker grows out of it, and rounds again once it's gone.
    if (state.mode === 'send' && state.anchor && !wasSend) this.sendCommand({ type: 'send-picker', open: true })
    else if (wasSend && state.mode !== 'send') this.sendCommand({ type: 'send-picker', open: false })
  }

  showSuggestions(items: Suggestion[], selected: number, rect: Rect): void {
    if (this.overlayState.mode === 'send') return
    if (!items.length) return this.hideSuggestions()
    this.setOverlay({ mode: 'suggestions', items, selected })
    this.overlay.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: items.length * SUGGESTION_ROW_HEIGHT + SUGGESTION_PADDING * 2 + 8
    })
    if (!this.overlayAttached) this.attachOverlay()
  }

  hideSuggestions(): void {
    if (this.overlayState.mode !== 'suggestions') return
    this.setOverlay({ mode: 'hidden' })
    this.detachOverlay()
  }

  setOmniboxAnchor(anchor: OmniboxAnchor): void {
    this.omniboxAnchor = anchor
    // An open picker follows the bar, as the window is resized.
    const state = this.overlayState
    if (state.mode === 'send' && state.anchor) this.setOverlay({ ...state, anchor })
  }

  openSendPicker(draft: ShareDraft, more?: ShareDraft[]): void {
    // Full size before the picker renders, so it lays itself out against the whole window.
    const [width, height] = this.win.getContentSize()
    this.overlay.setBounds({ x: 0, y: 0, width, height })
    // A full-screen video hides the address bar.
    this.setOverlay({ mode: 'send', draft, more, anchor: this.fullscreenTab ? null : this.omniboxAnchor, windowWidth: width })
    this.attachOverlay()
    this.layout()
    this.overlay.webContents.focus()
  }

  async openSendPickerForTab(tab: Tab | null = this.active): Promise<void> {
    if (!tab) return
    const draft = await draftFromTab(tab)
    if (draft) this.openSendPicker(draft)
  }

  /** Opens the send picker for several tabs at once (a whole group). */
  async openSendPickerForTabs(tabs: Tab[]): Promise<void> {
    const drafts = (await Promise.all(tabs.map(draftFromTab))).filter((d): d is ShareDraft => !!d)
    const [first, ...more] = drafts
    if (first) this.openSendPicker(first, more)
  }

  closeOverlay(): void {
    const wasSend = this.overlayState.mode === 'send'
    this.setOverlay({ mode: 'hidden' })
    this.detachOverlay()
    if (wasSend) this.active?.wc.focus()
  }

  // ---- the panel of a collapsed group's tabs ----

  peekGroup(group: string, anchor: Rect): void {
    // Not over the address-bar dropdown or the send picker.
    if (this.overlayState.mode === 'suggestions' || this.overlayState.mode === 'send') return
    // Coming from another group's chip, its panel was about to close; this one replaces it instead.
    this.forgetPeek()
    this.peek = { group, anchor, overChip: true, overPanel: false }
    this.showPeek()
  }

  unpeekGroup(now: boolean): void {
    if (now) this.closePeek()
    else this.peekHover('chip', false)
  }

  /** The panel closes a moment after the pointer is off both the chip and the panel, so it can cross between them. */
  peekHover(where: 'chip' | 'panel', inside: boolean): void {
    const peek = this.peek
    if (!peek) return
    if (where === 'chip') peek.overChip = inside
    else peek.overPanel = inside
    if (this.peekTimer) clearTimeout(this.peekTimer)
    this.peekTimer = peek.overChip || peek.overPanel ? null : setTimeout(() => this.closePeek(), 250)
  }

  private showPeek(): void {
    const peek = this.peek!
    const tabs = this.groupTabs(peek.group)
    if (!tabs.length) return this.closePeek()
    this.setOverlay({
      mode: 'group',
      group: peek.group,
      name: siteName(peek.group),
      color: siteColor(peek.group),
      tabs: tabs.map((t) => ({ ...t.state, group: peek.group })),
      activeTabId: this.active?.id ?? null
    })
    // Beside the sidebar, its first row level with the chip, and inside the window.
    const [width, height] = this.win.getContentSize()
    const m = GROUP_PEEK_MARGIN
    const boxHeight = Math.min(GROUP_PEEK_HEAD_HEIGHT + tabs.length * GROUP_PEEK_ROW_HEIGHT + GROUP_PEEK_PADDING * 2 + m * 2, height)
    const left = Math.max(peek.anchor.x + peek.anchor.width, this.insets.left) + 8
    const top = peek.anchor.y - GROUP_PEEK_PADDING - (GROUP_PEEK_HEAD_HEIGHT - peek.anchor.height) / 2
    this.overlay.setBounds({
      x: Math.round(Math.min(left - m, width - GROUP_PEEK_WIDTH - m * 2)),
      y: Math.round(Math.max(0, Math.min(top - m, height - boxHeight))),
      width: GROUP_PEEK_WIDTH + m * 2,
      height: Math.round(boxHeight)
    })
    if (!this.overlayAttached) this.attachOverlay()
  }

  private closePeek(): void {
    this.forgetPeek()
    if (this.overlayState.mode !== 'group') return
    this.setOverlay({ mode: 'hidden' })
    this.detachOverlay()
  }

  private forgetPeek(): void {
    if (this.peekTimer) clearTimeout(this.peekTimer)
    this.peekTimer = null
    this.peek = null
  }

  pickSuggestion(index: number): void {
    this.win.webContents.send(IPC.omniboxPick, index)
  }

  // ---- context menus & keyboard ----

  showPageContextMenu(tab: Tab, params: ContextMenuParams): void {
    showPageContextMenu(this, tab, params)
  }

  /** Shortcuts the app menu can't express. Returns true when handled. */
  handleInput(input: Input): boolean {
    if (input.type !== 'keyDown') return false
    if (extensionHooks.shortcut(input, this)) return true
    const mod = isMac ? input.meta : input.control
    const key = input.key

    if (input.control && key === 'Tab') {
      this.cycleTab(input.shift ? -1 : 1)
      return true
    }
    if (input.control && (key === 'PageDown' || key === 'PageUp')) {
      this.cycleTab(key === 'PageDown' ? 1 : -1)
      return true
    }
    if (isMac && input.meta && input.alt && (key === 'ArrowRight' || key === 'ArrowLeft')) {
      this.cycleTab(key === 'ArrowRight' ? 1 : -1)
      return true
    }
    if (isMac && input.meta && input.shift && (key === '}' || key === '{' || key === ']' || key === '[')) {
      this.cycleTab(key === '}' || key === ']' ? 1 : -1)
      return true
    }
    if (!isMac && input.alt && !input.control && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      if (key === 'ArrowLeft') this.active?.goBack()
      else this.active?.goForward()
      return true
    }
    if (key === 'F5') {
      this.active?.reload(input.control || input.shift)
      return true
    }
    if (key === 'F12') {
      this.active?.toggleDevTools()
      return true
    }
    if (key === 'F6' || (!isMac && input.alt && key.toLowerCase() === 'd')) {
      this.focusOmnibox()
      return true
    }
    if (mod && input.shift && (key === '+' || key === '=')) {
      this.active?.zoom('in')
      return true
    }
    return false
  }
}
