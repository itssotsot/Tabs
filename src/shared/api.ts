import type {
  AppInfo,
  AppNotification,
  Bookmark,
  ChromeCommand,
  DownloadState,
  ExtensionInfo,
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
  UpdateReady,
  WindowState
} from './types'

export const IPC = {
  // chrome -> main
  tabCreate: 'tab:create',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabMove: 'tab:move',
  tabMoveGroup: 'tab:move-group',
  tabPeekGroup: 'tab:peek-group',
  tabUnpeekGroup: 'tab:unpeek-group',
  tabGroupMenu: 'tab:group-menu',
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
  tabLayoutMenu: 'chrome:tab-layout-menu',
  showMenu: 'chrome:show-menu',
  pasteAndGo: 'nav:paste-and-go',
  shareOpenPickerForLink: 'share:open-picker-for-link',
  omniboxQuery: 'omnibox:query',
  omniboxShow: 'omnibox:show',
  omniboxHide: 'omnibox:hide',
  findStart: 'find:start',
  findStop: 'find:stop',
  bookmarkToggle: 'bookmark:toggle',
  bookmarkToggleUrl: 'bookmark:toggle-url',
  bookmarksList: 'bookmarks:list',
  bookmarkOpen: 'bookmark:open',
  bookmarkContextMenu: 'bookmark:context-menu',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  downloadsList: 'downloads:list',
  downloadAction: 'downloads:action',
  shareOpenPicker: 'share:open-picker',
  sharePreview: 'share:preview',
  signInWithGoogle: 'auth:google',
  notify: 'app:notify',
  setBadge: 'app:set-badge',
  openUrl: 'app:open-url',
  updateGet: 'update:get',
  updateInstall: 'update:install',

  // main -> chrome
  windowState: 'window:state',
  findState: 'find:state',
  command: 'chrome:command',
  omniboxPick: 'omnibox:pick',
  bookmarksChanged: 'bookmarks:changed',
  settingsChanged: 'settings:changed',
  downloadsChanged: 'downloads:changed',
  updateChanged: 'update:changed',

  // overlay <-> main
  overlayState: 'overlay:state',
  overlayPick: 'overlay:pick',
  overlayClose: 'overlay:close',
  overlayPeekHover: 'overlay:peek-hover',
  overlayOpenPanel: 'overlay:open-panel',

  // web pages -> main
  pageShare: 'page:share',
  pageAdblockEnabled: 'page:adblock-enabled',
  pageHoldMedia: 'page:hold-media',
  pageLeaveSharedLink: 'page:leave-shared-link',

  // main -> web pages
  pageReleaseMedia: 'page:release-media',

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
  internalMakeDefault: 'internal:make-default',
  internalExtensions: 'internal:extensions',
  internalExtensionSetEnabled: 'internal:extension-set-enabled',
  internalExtensionRemove: 'internal:extension-remove',
  internalExtensionOptions: 'internal:extension-options',
  internalOpenWebStore: 'internal:open-web-store'
} as const

/** Roles the browser UI may put in its own menus; they act on whatever is focused. */
export const MENU_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const

/** A right-click menu the browser UI describes; the main process shows it natively. */
export interface MenuSpec {
  /** Returned when the item is clicked. */
  id?: string
  label?: string
  role?: (typeof MENU_ROLES)[number]
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  submenu?: MenuSpec[]
}

export type DownloadAction = 'open' | 'show' | 'cancel' | 'pause' | 'resume' | 'remove' | 'clear'

export type Unsubscribe = () => void

/** Exposed as `window.browserr` to the browser UI and the overlay. */
export interface BrowserrAPI {
  platform: string
  tabs: {
    create(url?: string): void
    close(id: number): void
    activate(id: number): void
    /** `into` is the site group it was dropped in, or null for none. Without it, the window works that out. */
    move(id: number, toIndex: number, into?: string | null): void
    /** Shows a collapsed group's tabs in a panel beside `anchor` (its chip, in window coordinates). */
    peekGroup(group: string, anchor: Rect): void
    /** The pointer left the chip: the panel closes unless it goes onto the panel. `now` closes it at once. */
    unpeekGroup(now?: boolean): void
    /** Moves a site group (all its tabs) onto the tab at `toIndex`. */
    moveGroup(group: string, toIndex: number): void
    /** The right-click menu for a site group's chip. */
    groupMenu(group: string): void
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
    /** Opens whatever is on the clipboard, like typing it into the address bar. */
    pasteAndGo(): void
  }
  onWindowState(cb: (state: WindowState) => void): Unsubscribe
  onCommand(cb: (cmd: ChromeCommand) => void): Unsubscribe
  setInsets(insets: Insets): void
  siteInfoMenu(): void
  appMenu(x: number, y: number): void
  /** The menu for picking a tab layout, opened below (x, y). */
  tabLayoutMenu(x: number, y: number): void
  /** Shows a native right-click menu at the pointer. Resolves with the clicked item's id, or null. */
  showMenu(items: MenuSpec[]): Promise<string | null>
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
    /** Adds or removes a bookmark (a favorite) for any URL, not just the active tab. */
    toggle(url: string, title: string): void
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
    /** Title and thumbnail for a link typed into a chat, like the send picker attaches. Null if the page has none. */
    preview(url: string): Promise<ShareDraft | null>
    /** Opens the send picker for a link (from a chat, a list…) rather than the active tab. */
    openPickerForLink(url: string, title: string): void
  }
  auth: {
    signInWithGoogle(): Promise<GoogleCredential>
  }
  updates: {
    /** The update waiting to be installed, or null. */
    get(): Promise<UpdateReady | null>
    install(): void
    onChanged(cb: (update: UpdateReady | null) => void): Unsubscribe
  }
  notify(n: AppNotification): void
  setBadge(count: number): void
  /** Opens a page in a new tab. `fromLink` is the key of the shared link it came from, so the tab shows who sent it. */
  openUrl(url: string, background?: boolean, fromLink?: string): void
  overlay: {
    onState(cb: (state: OverlayState) => void): Unsubscribe
    pick(index: number): void
    close(): void
    openPanel(panel: SidebarPanel): void
    /** The pointer went onto (or off) the group panel. */
    peekHover(inside: boolean): void
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
  extensions(): Promise<ExtensionInfo[]>
  setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo[]>
  removeExtension(id: string): Promise<ExtensionInfo[]>
  /** Opens the extension's options page in a new tab. */
  openExtensionOptions(id: string): Promise<void>
  /** Opens the Chrome Web Store in a new tab. */
  openWebStore(): Promise<void>
}

export type { ShareDraft }
