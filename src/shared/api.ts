import type {
  AppInfo,
  AppNotification,
  Bookmark,
  ChromeCommand,
  DownloadState,
  FindState,
  GoogleCredential,
  HistoryEntry,
  Insets,
  OverlayState,
  Rect,
  Settings,
  ShareDraft,
  SidebarPanel,
  Suggestion,
  WindowState
} from './types'

export const IPC = {
  // chrome -> main
  tabCreate: 'tab:create',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabMove: 'tab:move',
  tabContextMenu: 'tab:context-menu',
  tabToggleMute: 'tab:toggle-mute',
  navigate: 'nav:navigate',
  navBack: 'nav:back',
  navForward: 'nav:forward',
  navReload: 'nav:reload',
  navStop: 'nav:stop',
  zoomReset: 'nav:zoom-reset',
  setInsets: 'chrome:set-insets',
  siteInfoMenu: 'chrome:site-info-menu',
  appMenu: 'chrome:app-menu',
  omniboxQuery: 'omnibox:query',
  omniboxShow: 'omnibox:show',
  omniboxHide: 'omnibox:hide',
  findStart: 'find:start',
  findStop: 'find:stop',
  bookmarkToggle: 'bookmark:toggle',
  bookmarksList: 'bookmarks:list',
  bookmarkOpen: 'bookmark:open',
  bookmarkContextMenu: 'bookmark:context-menu',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  downloadsList: 'downloads:list',
  downloadAction: 'downloads:action',
  shareOpenPicker: 'share:open-picker',
  signInWithGoogle: 'auth:google',
  notify: 'app:notify',
  setBadge: 'app:set-badge',
  openUrl: 'app:open-url',

  // main -> chrome
  windowState: 'window:state',
  findState: 'find:state',
  command: 'chrome:command',
  omniboxPick: 'omnibox:pick',
  bookmarksChanged: 'bookmarks:changed',
  settingsChanged: 'settings:changed',
  downloadsChanged: 'downloads:changed',

  // overlay <-> main
  overlayState: 'overlay:state',
  overlayPick: 'overlay:pick',
  overlayClose: 'overlay:close',
  overlayOpenPanel: 'overlay:open-panel',

  // web pages -> main
  pageShare: 'page:share',

  // internal pages -> main
  internalHistory: 'internal:history',
  internalHistoryRemove: 'internal:history-remove',
  internalHistoryClear: 'internal:history-clear',
  internalTopSites: 'internal:top-sites',
  internalBookmarks: 'internal:bookmarks',
  internalBookmarkRemove: 'internal:bookmark-remove',
  internalBookmarkRename: 'internal:bookmark-rename',
  internalSettingsGet: 'internal:settings-get',
  internalSettingsSet: 'internal:settings-set',
  internalClearData: 'internal:clear-data',
  internalAppInfo: 'internal:app-info',
  internalMakeDefault: 'internal:make-default'
} as const

export type DownloadAction = 'open' | 'show' | 'cancel' | 'pause' | 'resume' | 'remove' | 'clear'

export type Unsubscribe = () => void

/** Exposed as `window.browserr` to the browser UI and the overlay. */
export interface BrowserrAPI {
  platform: string
  tabs: {
    create(url?: string): void
    close(id: number): void
    activate(id: number): void
    move(id: number, toIndex: number): void
    contextMenu(id: number): void
    toggleMute(id: number): void
  }
  nav: {
    go(input: string): void
    back(): void
    forward(): void
    reload(): void
    stop(): void
    resetZoom(): void
  }
  onWindowState(cb: (state: WindowState) => void): Unsubscribe
  onCommand(cb: (cmd: ChromeCommand) => void): Unsubscribe
  setInsets(insets: Insets): void
  siteInfoMenu(): void
  appMenu(x: number, y: number): void
  omnibox: {
    query(text: string): Promise<Suggestion[]>
    show(items: Suggestion[], selected: number, rect: Rect): void
    hide(): void
    onPick(cb: (index: number) => void): Unsubscribe
  }
  find: {
    start(text: string, forward: boolean, findNext: boolean): void
    stop(): void
    onState(cb: (state: FindState) => void): Unsubscribe
  }
  bookmarks: {
    toggleCurrent(): void
    list(): Promise<Bookmark[]>
    open(url: string, newTab: boolean): void
    contextMenu(id: string): void
    onChanged(cb: (bookmarks: Bookmark[]) => void): Unsubscribe
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChanged(cb: (settings: Settings) => void): Unsubscribe
  }
  downloads: {
    list(): Promise<DownloadState[]>
    action(action: DownloadAction, id?: string): void
    onChanged(cb: (downloads: DownloadState[]) => void): Unsubscribe
  }
  share: {
    /** Opens the send picker for the active tab. */
    openPicker(): void
  }
  auth: {
    signInWithGoogle(): Promise<GoogleCredential>
  }
  notify(n: AppNotification): void
  setBadge(count: number): void
  openUrl(url: string, background?: boolean): void
  overlay: {
    onState(cb: (state: OverlayState) => void): Unsubscribe
    pick(index: number): void
    close(): void
    openPanel(panel: SidebarPanel): void
  }
}

/** Exposed as `window.browserrInternal` to browserr:// pages only. */
export interface InternalAPI {
  history(query: string, limit: number): Promise<HistoryEntry[]>
  removeHistory(url: string): Promise<void>
  clearHistory(): Promise<void>
  topSites(): Promise<HistoryEntry[]>
  bookmarks(): Promise<Bookmark[]>
  removeBookmark(id: string): Promise<void>
  renameBookmark(id: string, title: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  clearBrowsingData(): Promise<void>
  appInfo(): Promise<AppInfo>
  makeDefaultBrowser(): Promise<boolean>
}

export type { ShareDraft }
