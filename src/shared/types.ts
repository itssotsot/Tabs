/** The link from a chat that a tab was opened from. */
export interface TabLink {
  /** The link's key: `${roomId}/${messageId}`, with `#n` for links in the message's text. */
  key: string
  /** Where the link led, after redirects. */
  landedUrl: string
}

export interface TabState {
  id: number
  /** What the address bar should show. Empty for the new tab page. */
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
  pinned: boolean
  zoomPercent: number
  secure: boolean
  internal: boolean
  /** Unloaded to save memory (or not opened yet since restore); loads when selected. */
  sleeping: boolean
  /** The site group the tab is in (a registrable domain such as youtube.com), when grouping tabs by site. */
  group: string | null
  /** Set when the tab was opened from a link someone sent, so it can show who sent it. */
  fromLink: TabLink | null
  /** When the tab was opened (ms since epoch). Kept across restarts. */
  createdAt: number
}

export interface WindowState {
  tabs: TabState[]
  activeTabId: number | null
  htmlFullscreen: boolean
  fullscreen: boolean
  isBookmarked: boolean
  /** Set when running a named profile (e.g. a second test account). */
  profile: string | null
  /** What each site group in `tabs` is called ("YouTube"), by group. */
  groupNames: Record<string, string>
  /** Each site group's color: the one picked for its site, else one from the site's name. */
  groupColors: Record<string, string>
}

export interface FindState {
  open: boolean
  matches: number
  activeMatch: number
}

export interface Insets {
  top: number
  right: number
  /** Width of the vertical tab list, when that layout is on. */
  left: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** `extension`: from an extension's address bar keyword (chrome.omnibox). */
export type SuggestionType = 'url' | 'search' | 'history' | 'bookmark' | 'suggest' | 'extension'

export interface Suggestion {
  type: SuggestionType
  url: string
  title: string
  /** Extra text after the title, e.g. the extension's name. */
  detail?: string
}

export interface ShareDraft {
  /** URL without any timestamp. */
  url: string
  title: string
  thumbnail: string | null
  /** Current playback position for videos, in seconds. */
  timestampSec: number | null
}

export type OverlayState =
  | { mode: 'hidden' }
  | { mode: 'suggestions'; items: Suggestion[]; selected: number }
  /** `more` are the rest of the links when sending a whole tab group. */
  | { mode: 'send'; draft: ShareDraft; more?: ShareDraft[] }
  /** A collapsed site group's tabs, shown while you hover its chip. */
  | { mode: 'group'; group: string; name: string; color: string; tabs: TabState[]; activeTabId: number | null }

/** `extension` is an extension's side panel (chrome.sidePanel). */
export type SidebarPanel = 'inbox' | 'friends' | 'downloads' | 'extension'

/** An extension's button in the toolbar, as it looks for the window's active tab. */
export interface ToolbarExtension {
  id: string
  name: string
  /** data: URL. */
  icon: string | null
  title: string
  badgeText: string
  badgeColor: string
  badgeTextColor: string
  enabled: boolean
  /** Shown in the toolbar; otherwise only in the extensions menu. */
  pinned: boolean
}

/** The extension whose side panel is open in the sidebar. */
export interface ExtensionPanelInfo {
  id: string
  name: string
  icon: string | null
}

export type ChromeCommand =
  | { type: 'focus-omnibox' }
  | { type: 'toggle-sidebar'; panel?: SidebarPanel }
  | { type: 'open-sidebar'; panel: SidebarPanel }
  | { type: 'open-find' }
  | { type: 'find-next'; forward: boolean }
  | { type: 'open-room'; roomId: string }
  /** A notification's link was opened, so its room counts as read. */
  | { type: 'room-read'; roomId: string }
  | { type: 'toggle-tab-overview' }
  /** Open an extension's popup from its toolbar button (keyboard shortcut, action.openPopup). */
  | { type: 'open-extension-popup'; extensionId: string }
  | { type: 'open-extension-panel'; panel: ExtensionPanelInfo }
  | { type: 'close-extension-panel' }

export interface DownloadState {
  id: string
  filename: string
  path: string
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  paused: boolean
  startTime: number
}

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisit: number
}

export interface Bookmark {
  id: string
  url: string
  title: string
  createdAt: number
}

export type SearchEngine = 'google' | 'duckduckgo' | 'bing' | 'brave'

/** How tabs, links from chats, and favorites are laid out. */
export type TabLayout = 'vertical' | 'groups'

export interface Settings {
  searchEngine: SearchEngine
  adblock: boolean
  notifications: boolean
  restoreSession: boolean
  /** Unload tabs you haven't used in a while. */
  memorySaver: boolean
  tabLayout: TabLayout
  /** Keep tabs from the same site together in a group. */
  groupTabsBySite: boolean
  /** Sites (registrable domains) whose tabs are never grouped. */
  ungroupedSites: string[]
}

export interface GoogleCredential {
  idToken: string
  accessToken: string | null
}

export interface AppNotification {
  /** Used to avoid showing the same notification once per window. */
  key: string
  title: string
  body: string
  /** Opened in a new tab when the notification is clicked. */
  url?: string
  /** The shared link `url` is, so its tab shows who sent it. */
  linkKey?: string
  roomId?: string
  panel?: SidebarPanel
}

/** An update that's downloaded and waiting to be installed. */
export interface UpdateReady {
  version: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  platform: string
  isDefaultBrowser: boolean
}

/** A Chrome extension installed from the Chrome Web Store. */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  /** data: URL of its icon. */
  icon: string | null
  /** Its options page, if it has one. */
  optionsUrl: string | null
  /** Why it isn't running although it's turned on. */
  error: string | null
  /** Its button is in the toolbar (not only in the extensions menu). */
  pinned: boolean
  /** Keyboard shortcuts it declares, formatted for this platform. */
  shortcuts: { description: string; shortcut: string }[]
}
