import {
  dialog,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type NavigationEntry,
  type Result,
  type WebContents
} from 'electron'
import { IPC } from '@shared/api'
import type { TabLink, TabState } from '@shared/types'
import { INTERNAL_SCHEME, isInternalUrl, NEW_TAB_URL, pageKey, prettyUrl } from '@shared/url'
import { tabPreload, webSession } from './env'
import { browserEvents } from './browser-events'
import { extensionHooks } from './extension-hooks'
import { applyIdentity } from './identity'
import { onNavigationStart } from './predictor'
import { learnSiteName, siteOf, type Groupable } from './sites'
import { store, type SavedTab } from './store'

/** What a tab needs from the window that owns it. */
export interface TabHost {
  readonly win: BrowserWindow
  onTabUpdated(tab: Tab): void
  onWebContentsCreated(tab: Tab, wc: WebContents): void
  onWebContentsDestroyed(tab: Tab, wc: WebContents): void
  openTab(url: string, options: { active: boolean; opener: Tab }): void
  onTabFullscreen(tab: Tab, fullscreen: boolean): void
  onFindResult(tab: Tab, result: Result): void
  showPageContextMenu(tab: Tab, params: ContextMenuParams): void
  handleInput(input: Input): boolean
}

/** Everything needed to bring back a tab whose page isn't loaded. */
export interface TabSnapshot {
  url: string
  title: string
  favicon: string | null
  entries?: NavigationEntry[]
  index?: number
}

const ERROR_HOST = 'error'
const ERR_ABORTED = -3
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
/** Back/forward entries kept when a tab is unloaded or saved. */
const MAX_HISTORY_ENTRIES = 50

let nextTabId = 1

/** Keeps at most `max` entries around `index`, returning the new list and index. */
function trimHistory(entries: NavigationEntry[], index: number, max: number): { entries: NavigationEntry[]; index: number } {
  if (entries.length <= max) return { entries, index }
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), entries.length - max))
  return { entries: entries.slice(start, start + max), index: index - start }
}

/**
 * A browser tab. Its page (a WebContentsView) is created on demand, so restored
 * tabs cost nothing until opened and idle tabs can be unloaded to free memory.
 */
export class Tab implements Groupable {
  readonly id = nextTabId++
  pinned = false
  pulledOutOf: string | null = null
  joinedGroup: string | null = null
  /** When the tab was opened. Restored and reopened tabs keep theirs. */
  createdAt = Date.now()
  /** The link from a chat this tab was opened from. */
  fromLink: TabLink | null = null
  /** False until the page opened from `fromLink` commits, which tells us where its redirects led. */
  private linkLanded = true
  /** The site the window last grouped this tab by, to notice when it changes. Undefined until it's placed. */
  groupedSite: string | null | undefined = undefined
  /** When the user last looked at this tab. */
  lastActiveAt = Date.now()
  /** Opened in the background and not looked at yet: its videos wait until the tab is shown. */
  private holdMedia: boolean
  private viewInstance: WebContentsView | null = null
  /** Present while the page isn't loaded (lazy restore or unloaded to save memory). */
  private snapshot: TabSnapshot | null = null
  private favicon: string | null = null
  private loading = false
  /** Paused via the page lifecycle API: no scripts or timers run until thawed. */
  private frozen = false
  /** Set while showing our error page, so the address bar keeps the URL that failed. */
  private failedUrl: string | null = null
  private requestedUrl: string
  private siteCache: { url: string; site: string | null } | null = null
  /** An extension's page standing in for the new tab page (chrome_url_overrides), while it's showing. */
  private newTabPage: string | null = null

  constructor(
    private readonly host: TabHost,
    url: string,
    options: { lazy?: boolean; snapshot?: TabSnapshot; background?: boolean } = {}
  ) {
    this.requestedUrl = url
    this.holdMedia = !!options.background
    if (options.lazy) {
      this.snapshot = options.snapshot ?? { url, title: '', favicon: null }
    } else {
      this.load(url)
    }
  }

  /** Whether the page currently exists (false for sleeping tabs). */
  get loaded(): boolean {
    return this.viewInstance !== null
  }

  /** The tab's view, creating and loading the page if it's asleep. */
  get view(): WebContentsView {
    return this.viewInstance ?? this.wake()
  }

  get wc(): WebContents {
    return this.view.webContents
  }

  /** The page's webContents only if it's already loaded. Never wakes the tab. */
  get liveWc(): WebContents | null {
    return this.viewInstance?.webContents ?? null
  }

  /** The URL to restore, bookmark, or share (never the error page itself). */
  get url(): string {
    if (this.failedUrl) return this.failedUrl
    if (this.snapshot) return this.snapshot.url
    const current = this.liveWc?.getURL() || this.requestedUrl
    return this.newTabPage && current === this.newTabPage ? NEW_TAB_URL : current
  }

  get isInternal(): boolean {
    return !this.failedUrl && isInternalUrl(this.url)
  }

  get site(): string | null {
    const url = this.url
    if (this.siteCache?.url !== url) this.siteCache = { url, site: siteOf(url) }
    return this.siteCache.site
  }

  get title(): string {
    return this.snapshot ? this.snapshot.title : (this.liveWc?.getTitle() ?? '')
  }

  get holdingMedia(): boolean {
    return this.holdMedia
  }

  /** The tab is being shown for the first time: videos it held back may play now. */
  releaseMedia(): void {
    if (!this.holdMedia) return
    this.holdMedia = false
    this.liveWc?.send(IPC.pageReleaseMedia)
  }

  get isLoading(): boolean {
    return this.loading
  }

  get muted(): boolean {
    return this.liveWc?.isAudioMuted() ?? false
  }

  get audible(): boolean {
    return this.liveWc?.isCurrentlyAudible() ?? false
  }

  /** The tab's state for the browser UI; the window adds which group it's in. */
  /** Marks the tab as opened from a shared link. `landedUrl` is known for restored tabs; new ones learn it when the page loads. */
  openedFrom(key: string, landedUrl?: string): void {
    this.fromLink = { key, landedUrl: landedUrl ?? this.url }
    this.linkLanded = landedUrl !== undefined
  }

  /** On the page a chat's link opened, so the tab shows in the chat's group. Going anywhere else opens a new tab. */
  get onSharedLink(): boolean {
    return !!this.fromLink && pageKey(this.url) === pageKey(this.fromLink.landedUrl)
  }

  get state(): Omit<TabState, 'group'> {
    const url = this.url
    const isNewTab = url.startsWith(NEW_TAB_URL)
    const wc = this.liveWc
    const rawTitle = this.title
    const title = !rawTitle || rawTitle === url ? (isNewTab ? 'New Tab' : prettyUrl(url)) : rawTitle
    const snap = this.snapshot
    return {
      id: this.id,
      url: isNewTab ? '' : url,
      title,
      favicon: this.isInternal ? null : (snap ? snap.favicon : this.favicon),
      loading: this.loading,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : (snap?.index ?? 0) > 0,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : (snap?.index ?? 0) < (snap?.entries?.length ?? 1) - 1,
      audible: this.audible,
      muted: this.muted,
      pinned: this.pinned,
      zoomPercent: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      // Extension pages come from the extension's own files, like browserr:// pages.
      secure: url.startsWith('https:') || url.startsWith('chrome-extension:') || this.isInternal,
      internal: this.isInternal,
      sleeping: !wc,
      fromLink: this.fromLink,
      createdAt: this.createdAt
    }
  }

  /** Creates the page and brings back whatever it was showing. */
  wake(): WebContentsView {
    if (this.viewInstance) return this.viewInstance
    const view = new WebContentsView({
      webPreferences: {
        session: webSession(),
        preload: tabPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Preloads run in iframes too (sandboxed, so no Node): extensions' user scripts are injected from there.
        nodeIntegrationInSubFrames: true,
        spellcheck: true,
        scrollBounce: true
      }
    })
    view.setBackgroundColor('#ffffff')
    // Each pending executeJavaScript (ours and the ad blocker's) briefly adds a load listener.
    view.webContents.setMaxListeners(50)
    this.viewInstance = view
    this.wire(view.webContents)
    this.host.onWebContentsCreated(this, view.webContents)

    const snap = this.snapshot
    this.snapshot = null
    if (snap) {
      this.favicon = snap.favicon
      if (snap.entries?.length) {
        // Restores the whole back/forward list, including scroll position and form contents.
        view.webContents.navigationHistory
          .restore({ entries: snap.entries, index: snap.index })
          .catch(() => this.load(snap.url))
      } else {
        this.load(snap.url)
      }
    }
    return view
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  /**
   * Pauses the page (like Chrome's tab freezing). Uses the DevTools protocol, so skipped while
   * DevTools is open. The debugger stays attached: it also carries the browser identity override.
   */
  async freeze(): Promise<boolean> {
    const wc = this.liveWc
    if (!wc || this.frozen || wc.isDevToolsOpened()) return false
    try {
      applyIdentity(wc)
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' })
      this.frozen = true
      return true
    } catch {
      return false
    }
  }

  /** Resumes a frozen page. */
  async thaw(): Promise<void> {
    const wc = this.liveWc
    if (!wc || !this.frozen) return
    this.frozen = false
    try {
      await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' })
    } catch {
      // Page navigated or was reloaded; it's active anyway.
    }
  }

  /** Unloads the page to free memory; it comes back when the tab is opened. */
  sleep(): boolean {
    const wc = this.liveWc
    if (!wc || wc.isDestroyed()) return false
    this.snapshot = this.captureSnapshot(true)
    this.host.onWebContentsDestroyed(this, wc)
    this.viewInstance = null
    this.loading = false
    this.failedUrl = null
    this.frozen = false
    wc.close()
    this.host.onTabUpdated(this)
    return true
  }

  private captureSnapshot(withPageState: boolean): TabSnapshot {
    if (this.snapshot) return this.snapshot
    const wc = this.liveWc
    const base = { url: this.url, title: this.state.title, favicon: this.favicon }
    // The error page isn't worth restoring; retry the real URL instead.
    if (!wc || this.failedUrl) return base
    const history = wc.navigationHistory
    const all = history.getAllEntries().map((e) => (withPageState ? e : { url: e.url, title: e.title }))
    const { entries, index } = trimHistory(all, history.getActiveIndex(), MAX_HISTORY_ENTRIES)
    return entries.length ? { ...base, entries, index } : base
  }

  /** What the session file keeps for this tab (history without page state, to stay small). */
  toSaved(): SavedTab {
    const snap = this.captureSnapshot(false)
    const entries = snap.entries?.map((e) => ({ url: e.url, title: e.title }))
    return {
      url: snap.url,
      pinned: this.pinned,
      title: snap.title,
      favicon: snap.favicon,
      entries,
      index: snap.index,
      fromLink: this.fromLink ?? undefined,
      createdAt: this.createdAt,
      joinedGroup: this.joinedGroup ?? undefined
    }
  }

  load(url: string): void {
    this.requestedUrl = url
    this.failedUrl = null
    this.snapshot = null
    const override = url.startsWith(NEW_TAB_URL) ? extensionHooks.newTabOverride() : null
    this.newTabPage = override
    this.wc.loadURL(override ?? url).catch(() => {
      // Failures are reported through did-fail-load.
    })
  }

  reload(ignoreCache = false): void {
    if (!this.loaded) return void this.wake()
    if (this.failedUrl) return this.load(this.failedUrl)
    if (ignoreCache) this.wc.reloadIgnoringCache()
    else this.wc.reload()
  }

  goBack(): void {
    if (this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack()
  }

  goForward(): void {
    if (this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward()
  }

  zoom(direction: 'in' | 'out' | 'reset'): void {
    const current = this.wc.getZoomFactor()
    let next = 1
    if (direction === 'in') next = ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1)!
    if (direction === 'out') next = [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]
    this.wc.setZoomFactor(next)
    this.host.onTabUpdated(this)
  }

  toggleMute(): void {
    const wc = this.liveWc
    if (!wc) return
    wc.setAudioMuted(!wc.isAudioMuted())
    this.host.onTabUpdated(this)
  }

  toggleDevTools(): void {
    if (this.wc.isDevToolsOpened()) this.wc.closeDevTools()
    else this.wc.openDevTools({ mode: 'detach' })
  }

  destroy(): void {
    const wc = this.liveWc
    this.viewInstance = null
    if (!wc) return
    this.host.onWebContentsDestroyed(this, wc)
    if (!wc.isDestroyed()) wc.close()
  }

  private showError(url: string, code: string, description: string): void {
    const params = new URLSearchParams({ url, code, description })
    this.wc.loadURL(`${INTERNAL_SCHEME}://${ERROR_HOST}/?${params}`).catch(() => {})
    this.failedUrl = url
    this.host.onTabUpdated(this)
  }

  private wire(wc: WebContents): void {
    const update = (): void => this.host.onTabUpdated(this)
    // Single-page sites (YouTube) often only name themselves on some pages, so in-page navigations count too.
    const learnName = (): void => void learnSiteName(wc).then((learned) => learned && update())

    wc.on('did-start-loading', () => {
      this.loading = true
      update()
      browserEvents.emit('tab-loading', this, true)
    })
    wc.on('did-stop-loading', () => {
      this.loading = false
      update()
      browserEvents.emit('tab-loading', this, false)
    })
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) onNavigationStart(wc.session, details.url)
    })
    wc.on('did-navigate', (_e, url) => {
      if (!url.startsWith(`${INTERNAL_SCHEME}://${ERROR_HOST}/`)) this.failedUrl = null
      this.favicon = null
      if (this.fromLink && !this.linkLanded && !isInternalUrl(url)) {
        this.fromLink = { ...this.fromLink, landedUrl: url }
        this.linkLanded = true
      }
      store.recordVisit(url, wc.getTitle())
      update()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      store.recordVisit(url, wc.getTitle())
      learnName()
      update()
    })
    wc.on('page-title-updated', (_e, title) => {
      store.updateTitle(wc.getURL(), title)
      update()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons[0] ?? null
      update()
    })
    wc.on('did-finish-load', learnName)
    wc.on('audio-state-changed', update)
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction))

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || isInternalUrl(url)) return
      this.showError(url, String(code), description)
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      this.loading = false
      this.showError(this.url, 'crashed', 'This page crashed.')
    })

    // Web pages must never navigate themselves (or their iframes) to browserr:// pages.
    wc.on('will-frame-navigate', (e) => {
      if (isInternalUrl(e.url) && (!e.isMainFrame || !isInternalUrl(wc.getURL()))) e.preventDefault()
    })

    // Without this, a page's beforeunload handler silently blocks navigation.
    wc.on('will-prevent-unload', (e) => {
      const choice = dialog.showMessageBoxSync(this.host.win, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave site?',
        detail: 'Changes you made may not be saved.'
      })
      if (choice === 0) e.preventDefault()
    })

    wc.on('found-in-page', (_e, result) => this.host.onFindResult(this, result))
    wc.on('context-menu', (_e, params) => this.host.showPageContextMenu(this, params))
    wc.on('enter-html-full-screen', () => this.host.onTabFullscreen(this, true))
    wc.on('leave-html-full-screen', () => this.host.onTabFullscreen(this, false))
    wc.on('before-input-event', (e, input) => {
      if (this.host.handleInput(input)) e.preventDefault()
    })

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Real popups (window.open with features) stay popups so OAuth flows keep window.opener.
      if (disposition === 'new-window') {
        // An extension blocked popups on this site (chrome.contentSettings).
        if (extensionHooks.contentSetting('popups', wc.getURL()) === 'block') return { action: 'deny' }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, backgroundColor: '#ffffff' }
        }
      }
      this.host.openTab(url, { active: disposition !== 'background-tab', opener: this })
      return { action: 'deny' }
    })
  }
}
