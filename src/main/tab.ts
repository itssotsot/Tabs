import {
  dialog,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type NativeImage,
  type NavigationEntry,
  type Result,
  type WebContents
} from 'electron'
import { IPC } from '@shared/api'
import type { MediaCommand, TabLink, TabMedia, TabState } from '@shared/types'
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
  /** The colors along the top of the tab's page changed. They change often while scrolling, so they skip the full tab update. */
  onTabEdge(tab: Tab, edge: { color: string; edge: string[] }): void
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

/** The shortest time between reads of the page's top colors, about a frame: scrolling asks for one every frame. */
const MIN_SAMPLE_GAP_MS = 16
/** The longest a read of the page's top colors waits for the page to draw. */
const CAPTURE_TIMEOUT_MS = 500
/** How long after the last scroll the page's top colors are read again. */
const SCROLL_SETTLE_MS = [80, 400]
/** After a page first paints, when to read its top color again, as its header finishes drawing. */
const FOLLOW_UP_SAMPLES_MS = [200, 600, 1500]

/**
 * Windows draws videos on a hardware overlay, and a capture takes them off it for a frame: the video flashes dark.
 * So there, the page's colors aren't read while it has a video, and the toolbar keeps the last ones.
 */
const CAPTURE_FLASHES_VIDEO = process.platform === 'win32'

/** Whether two #rrggbb colors look the same. Pages that fade their background shouldn't redraw the toolbar every frame. */
function sameColor(a: string, b: string | null): boolean {
  if (!b) return false
  for (let i = 1; i < 7; i += 2) if (Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) > 3) return false
  return true
}

/** How many colors are read across the top of the page, left to right. Few enough that each is a soft, blurry column. */
const EDGE_STOPS = 32
/** How tall a band along the top is read: a band rather than the top row, so a thin accent stripe (Stack Overflow's) doesn't win. */
const EDGE_BAND = 12

interface ColorBucket {
  n: number
  r: number
  g: number
  b: number
}

/**
 * Finds the most common color in a set of pixels, so a logo or a line of text doesn't tint it.
 * Pixels are grouped by their top 4 bits per channel, and the biggest group's average wins.
 */
class ColorCounter {
  private readonly buckets = new Map<number, ColorBucket>()
  private best: ColorBucket | null = null

  add(r: number, g: number, b: number): void {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    let bucket = this.buckets.get(key)
    if (!bucket) this.buckets.set(key, (bucket = { n: 0, r: 0, g: 0, b: 0 }))
    bucket.n++
    bucket.r += r
    bucket.g += g
    bucket.b += b
    if (!this.best || bucket.n > this.best.n) this.best = bucket
  }

  get color(): string | null {
    const best = this.best
    if (!best) return null
    const hex = (sum: number): string => Math.round(sum / best.n).toString(16).padStart(2, '0')
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`
  }
}

/** The top of the page: its most common color, and the most common color in each column across it. */
function readEdge(image: NativeImage): { color: string; edge: string[] } | null {
  if (image.isEmpty()) return null
  // BGRA, the native order on macOS and Windows. The bitmap is in device pixels, so its row width comes from its length.
  const px = image.toBitmap()
  const size = image.getSize()
  const scale = Math.sqrt(px.length / 4 / (size.width * size.height))
  const rowWidth = Math.round(size.width * scale)
  if (!rowWidth) return null
  const rows = Math.floor(px.length / 4 / rowWidth)
  // One pixel per point is plenty: this runs every frame while scrolling, and Retina has four times as many.
  const step = Math.max(1, Math.round(scale))
  const overall = new ColorCounter()
  const columns = Array.from({ length: EDGE_STOPS }, () => new ColorCounter())
  for (let y = 0; y < rows; y += step) {
    for (let x = 0; x < rowWidth; x += step) {
      const i = (y * rowWidth + x) * 4
      const b = px[i]
      const g = px[i + 1]
      const r = px[i + 2]
      overall.add(r, g, b)
      columns[Math.min(EDGE_STOPS - 1, Math.floor((x * EDGE_STOPS) / rowWidth))].add(r, g, b)
    }
  }
  const color = overall.color
  return color ? { color, edge: columns.map((c) => c.color ?? color) } : null
}

function sameEdge(a: string[], b: string[] | null): boolean {
  return !!b && a.length === b.length && a.every((c, i) => sameColor(c, b[i]))
}

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
  /** When the tab was opened. Tabs restored at startup keep theirs; a reopened closed tab starts again. */
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
  /** The page's video, as its preload last reported it. */
  private media: TabMedia | null = null
  /** Something on the page has played since it loaded; its video may still be showing, even paused. */
  private playedMedia = false
  /** The top of the page, which the toolbar extends: its main color, and its colors left to right. */
  private pageColor: string | null = null
  private pageEdge: string[] | null = null
  /** False between a navigation committing and its page being ready, when the view still shows a blank page. */
  private painted = false
  private sampling = false
  /** A read was asked for while one was running: do another when it's done, so the last scroll position is never missed. */
  private resample = false
  private lastSampleAt = 0
  private sampleTimer: NodeJS.Timeout | null = null
  private settleTimers: NodeJS.Timeout[] = []

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
      media: wc ? this.media : null,
      pinned: this.pinned,
      zoomPercent: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      // Extension pages come from the extension's own files, like browserr:// pages.
      secure: url.startsWith('https:') || url.startsWith('chrome-extension:') || this.isInternal,
      internal: this.isInternal,
      sleeping: !wc,
      fromLink: this.fromLink,
      createdAt: this.createdAt,
      color: this.pageColor,
      edge: this.pageEdge
    }
  }

  /** The page painted for the first time, or scrolled: the top of it may be a new color. */
  pageRepainted(first: boolean): void {
    if (!first) {
      void this.sampleColor()
      // More reads once scrolling settles: in case the last one caught the frame before, and for sites that
      // switch their header's color a moment after you stop (with no animation to tell us).
      for (const timer of this.settleTimers) clearTimeout(timer)
      this.settleTimers = SCROLL_SETTLE_MS.map((ms) => setTimeout(() => void this.sampleColor(), ms))
      return
    }
    this.painted = true
    void this.sampleColor()
    // Many sites draw their header with scripts just after the first paint.
    for (const ms of FOLLOW_UP_SAMPLES_MS) setTimeout(() => void this.sampleColor(), ms)
  }

  /**
   * Reads the colors along the top of the page, for the toolbar to extend upward.
   * Only works while the tab is on screen, so the window calls it for its active tab.
   */
  async sampleColor(): Promise<void> {
    const wc = this.liveWc
    if (!wc || wc.isDestroyed() || !this.painted) return
    if (CAPTURE_FLASHES_VIDEO && this.playedMedia) return
    if (this.sampling) return void (this.resample = true)
    const wait = this.lastSampleAt + MIN_SAMPLE_GAP_MS - Date.now()
    if (wait > 0) {
      this.sampleTimer ??= setTimeout(() => {
        this.sampleTimer = null
        void this.sampleColor()
      }, wait)
      return
    }
    const { width } = this.view.getBounds()
    if (!width) return
    this.sampling = true
    this.lastSampleAt = Date.now()
    try {
      // A capture waits for the page's next frame, and a window that's fully covered draws none: give up rather
      // than hold up every read after it.
      const image = await Promise.race([
        wc.capturePage({ x: 0, y: 0, width, height: EDGE_BAND }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS))
      ])
      if (!image) return
      const read = readEdge(image)
      if (read && !(sameColor(read.color, this.pageColor) && sameEdge(read.edge, this.pageEdge))) {
        this.pageColor = read.color
        this.pageEdge = read.edge
        this.host.onTabEdge(this, read)
      }
    } catch {
      // The page went away mid-capture.
    } finally {
      this.sampling = false
      if (this.resample) {
        this.resample = false
        void this.sampleColor()
      }
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
    this.media = null
    this.playedMedia = false
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

  /** What the page's player reported: its video's state, or null when there's none. */
  setMedia(media: TabMedia | null): void {
    this.media = media
    this.host.onTabUpdated(this)
  }

  async controlMedia(command: MediaCommand): Promise<void> {
    if (!this.media) return
    // A paused video's tab may have been frozen to save power.
    await this.thaw()
    this.liveWc?.send(IPC.pageMediaCommand, command)
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
      void this.sampleColor()
    })
    wc.on('dom-ready', () => {
      this.painted = true
      // Give the page a moment to paint its header.
      setTimeout(() => void this.sampleColor(), 150)
    })
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) onNavigationStart(wc.session, details.url)
    })
    wc.on('did-navigate', (_e, url) => {
      this.painted = false
      if (!url.startsWith(`${INTERNAL_SCHEME}://${ERROR_HOST}/`)) this.failedUrl = null
      this.favicon = null
      this.media = null
      this.playedMedia = false
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
      setTimeout(() => void this.sampleColor(), 150)
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
    wc.on('media-started-playing', () => (this.playedMedia = true))
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction))

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || isInternalUrl(url)) return
      this.showError(url, String(code), description)
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      this.loading = false
      this.media = null
      this.playedMedia = false
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
