import { dialog, WebContentsView, type BrowserWindow, type ContextMenuParams, type Input, type Result } from 'electron'
import type { TabState } from '@shared/types'
import { INTERNAL_SCHEME, isInternalUrl, NEW_TAB_URL, prettyUrl } from '@shared/url'
import { tabPreload, webSession } from './env'
import { store } from './store'

/** What a tab needs from the window that owns it. */
export interface TabHost {
  readonly win: BrowserWindow
  onTabUpdated(tab: Tab): void
  openTab(url: string, options: { active: boolean; opener: Tab }): void
  onTabFullscreen(tab: Tab, fullscreen: boolean): void
  onFindResult(tab: Tab, result: Result): void
  showPageContextMenu(tab: Tab, params: ContextMenuParams): void
  handleInput(input: Input): boolean
}

const ERROR_HOST = 'error'
const ERR_ABORTED = -3
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

let nextTabId = 1

export class Tab {
  readonly id = nextTabId++
  readonly view: WebContentsView
  pinned = false
  private favicon: string | null = null
  private loading = false
  /** Set while showing our error page, so the address bar keeps the URL that failed. */
  private failedUrl: string | null = null
  private requestedUrl: string

  constructor(
    private readonly host: TabHost,
    url: string
  ) {
    this.requestedUrl = url
    this.view = new WebContentsView({
      webPreferences: {
        session: webSession(),
        preload: tabPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        scrollBounce: true
      }
    })
    this.view.setBackgroundColor('#ffffff')
    // Each pending executeJavaScript (ours and the ad blocker's) briefly adds a load listener.
    this.wc.setMaxListeners(50)
    this.wire()
    this.load(url)
  }

  get wc(): Electron.WebContents {
    return this.view.webContents
  }

  /** The URL to restore, bookmark, or share (never the error page itself). */
  get url(): string {
    return this.failedUrl ?? (this.wc.getURL() || this.requestedUrl)
  }

  get isInternal(): boolean {
    return !this.failedUrl && isInternalUrl(this.url)
  }

  get title(): string {
    return this.wc.getTitle()
  }

  get state(): TabState {
    const url = this.url
    const isNewTab = url.startsWith(NEW_TAB_URL)
    const history = this.wc.navigationHistory
    const rawTitle = this.wc.getTitle()
    const title = !rawTitle || rawTitle === this.wc.getURL() ? (isNewTab ? 'New Tab' : prettyUrl(url)) : rawTitle
    return {
      id: this.id,
      url: isNewTab ? '' : url,
      title,
      favicon: this.isInternal ? null : this.favicon,
      loading: this.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      audible: this.wc.isCurrentlyAudible(),
      muted: this.wc.isAudioMuted(),
      pinned: this.pinned,
      zoomPercent: Math.round(this.wc.getZoomFactor() * 100),
      secure: url.startsWith('https:') || this.isInternal,
      internal: this.isInternal
    }
  }

  load(url: string): void {
    this.requestedUrl = url
    this.failedUrl = null
    this.wc.loadURL(url).catch(() => {
      // Failures are reported through did-fail-load.
    })
  }

  reload(ignoreCache = false): void {
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
    this.wc.setAudioMuted(!this.wc.isAudioMuted())
    this.host.onTabUpdated(this)
  }

  toggleDevTools(): void {
    if (this.wc.isDevToolsOpened()) this.wc.closeDevTools()
    else this.wc.openDevTools({ mode: 'detach' })
  }

  destroy(): void {
    if (!this.wc.isDestroyed()) this.wc.close()
  }

  private showError(url: string, code: string, description: string): void {
    const params = new URLSearchParams({ url, code, description })
    this.wc.loadURL(`${INTERNAL_SCHEME}://${ERROR_HOST}/?${params}`).catch(() => {})
    this.failedUrl = url
    this.host.onTabUpdated(this)
  }

  private wire(): void {
    const wc = this.wc
    const update = (): void => this.host.onTabUpdated(this)

    wc.on('did-start-loading', () => {
      this.loading = true
      update()
    })
    wc.on('did-stop-loading', () => {
      this.loading = false
      update()
    })
    wc.on('did-navigate', (_e, url) => {
      if (!url.startsWith(`${INTERNAL_SCHEME}://${ERROR_HOST}/`)) this.failedUrl = null
      this.favicon = null
      store.recordVisit(url, wc.getTitle())
      update()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      store.recordVisit(url, wc.getTitle())
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
