import { BrowserWindow, screen, WebContentsView, type ContextMenuParams, type Input, type Rectangle as ElectronRect, type Result, type WebContents } from 'electron'
import { IPC } from '@shared/api'
import { SUGGESTION_PADDING, SUGGESTION_ROW_HEIGHT } from '@shared/constants'
import type { ChromeCommand, Insets, OverlayState, Rect, ShareDraft, Suggestion, WindowState } from '@shared/types'
import { NEW_TAB_URL } from '@shared/url'
import { chromePreload, profile, uiUrl, webSession } from './env'
import { showPageContextMenu } from './menu'
import { warmUp } from './predictor'
import { draftFromTab } from './share'
import { store, type SavedTab, type SavedWindow } from './store'
import { Tab, type TabHost, type TabSnapshot } from './tab'

const isMac = process.platform === 'darwin'
const CHROME_BG = '#161618'

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

export function controllerFor(wc: WebContents): BrowserWindowController | undefined {
  return owners.get(wc.id)
}

export function focusedController(): BrowserWindowController | null {
  const win = BrowserWindow.getFocusedWindow()
  const focused = [...BrowserWindowController.all].find((c) => c.win === win)
  return focused ?? (lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : null) ?? [...BrowserWindowController.all][0] ?? null
}

export function saveSessionNow(): void {
  if (sessionFrozen) return
  store.saveSession([...BrowserWindowController.all].map((c) => c.toSaved()))
}

/** Called on quit so windows closing one by one don't overwrite the saved session. */
export function freezeSession(): void {
  saveSessionNow()
  sessionFrozen = true
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
  private insets: Insets = { top: 84, right: 0 }
  private overlayState: OverlayState = { mode: 'hidden' }
  private overlayAttached = false
  private fullscreenTab: Tab | null = null
  private enteredFullscreenForTab = false
  private stateTimer: NodeJS.Timeout | null = null

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
      title: 'Browserr',
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
        this.tabs.push(tab)
      }
      this.activate(this.tabs[Math.min(saved.activeIndex, this.tabs.length - 1)] ?? this.tabs[0])
    } else if (options.urls?.length) {
      options.urls.forEach((url, i) => this.createTab(url, { active: i === 0 }))
    } else {
      this.createTab(NEW_TAB_URL)
    }

    this.win.once('ready-to-show', () => this.win.show())
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

    const overlay = this.overlay.webContents
    overlay.on('will-navigate', (e) => e.preventDefault())
    overlay.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlay.on('before-input-event', (e, input) => {
      if (this.handleInput(input)) e.preventDefault()
    })

    this.win.on('resize', () => this.layout())
    this.win.on('enter-full-screen', () => this.scheduleState())
    this.win.on('leave-full-screen', () => {
      if (this.fullscreenTab) {
        void this.fullscreenTab.wc.executeJavaScript('document.exitFullscreen?.()', true).catch(() => {})
      }
      this.scheduleState()
    })
    this.win.on('focus', () => (lastFocused = this))
    this.win.on('moved', scheduleSessionSave)
    this.win.on('resized', scheduleSessionSave)
    this.win.on('closed', () => this.dispose())
  }

  private dispose(): void {
    BrowserWindowController.all.delete(this)
    for (const [id, owner] of owners) if (owner === this) owners.delete(id)
    for (const tab of this.tabs) tab.destroy()
    this.tabs = []
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

  onWebContentsCreated(_tab: Tab, wc: WebContents): void {
    owners.set(wc.id, this)
  }

  onWebContentsDestroyed(_tab: Tab, wc: WebContents): void {
    owners.delete(wc.id)
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
              x: 0,
              y: this.insets.top,
              width: Math.max(0, width - this.insets.right),
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
    const state: WindowState = {
      tabs: this.tabs.map((t) => t.state),
      activeTabId: active?.id ?? null,
      htmlFullscreen: !!this.fullscreenTab,
      fullscreen: this.win.isFullScreen(),
      isBookmarked: !!active && !active.isInternal && !!store.findBookmark(active.url),
      profile
    }
    this.win.webContents.send(IPC.windowState, state)
    const app = profile ? `Browserr (${profile})` : 'Browserr'
    this.win.setTitle(active ? `${active.state.title} – ${app}` : app)
    scheduleSessionSave()
  }

  // ---- tabs ----

  createTab(
    url: string = NEW_TAB_URL,
    options: { active?: boolean; index?: number; lazy?: boolean; snapshot?: TabSnapshot } = {}
  ): Tab {
    const tab = new Tab(this, url, { lazy: options.lazy || !!options.snapshot, snapshot: options.snapshot })
    const index = options.index ?? this.tabs.length
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab)
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
    this.createTab(url, { active, index: this.tabs.indexOf(opener) + 1 })
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
    this.active = tab
    // Index 0 keeps the tab under the overlay when both are attached.
    this.win.contentView.addChildView(tab.view, 0)
    this.layout()
    tab.wc.focus()
    this.win.webContents.send(IPC.findState, { open: false, matches: 0, activeMatch: 0 })
    this.scheduleState()
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
    if (this.fullscreenTab === tab) this.onTabFullscreen(tab, false)
    if (this.active === tab) {
      this.win.contentView.removeChildView(tab.view)
      this.active = null
      const next = this.tabs[index] ?? this.tabs[index - 1]
      if (next) this.activate(next)
    }
    tab.destroy()
    if (!this.tabs.length) {
      this.win.close()
      return
    }
    this.scheduleState()
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
    if (last) this.createTab(last.url, { snapshot: snapshotOf(last) })
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
    // Pinning moves the tab to the end of the pinned group; unpinning to just after it.
    this.moveTab(tab.id, this.tabs.filter((t) => t.pinned && t !== tab).length)
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
    const tab = this.active ?? this.createTab(url)
    tab.load(url)
    tab.wc.focus()
  }

  onTabUpdated(): void {
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
    this.overlayState = state
    this.overlay.webContents.send(IPC.overlayState, state)
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

  openSendPicker(draft: ShareDraft): void {
    this.setOverlay({ mode: 'send', draft })
    this.attachOverlay()
    this.layout()
    this.overlay.webContents.focus()
  }

  async openSendPickerForTab(tab: Tab | null = this.active): Promise<void> {
    if (!tab) return
    const draft = await draftFromTab(tab)
    if (draft) this.openSendPicker(draft)
  }

  closeOverlay(): void {
    const wasSend = this.overlayState.mode === 'send'
    this.setOverlay({ mode: 'hidden' })
    this.detachOverlay()
    if (wasSend) this.active?.wc.focus()
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
