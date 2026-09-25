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
}

export interface WindowState {
  tabs: TabState[]
  activeTabId: number | null
  htmlFullscreen: boolean
  fullscreen: boolean
  isBookmarked: boolean
}

export interface FindState {
  open: boolean
  matches: number
  activeMatch: number
}

export interface Insets {
  top: number
  right: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type SuggestionType = 'url' | 'search' | 'history' | 'bookmark' | 'suggest'

export interface Suggestion {
  type: SuggestionType
  url: string
  title: string
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
  | { mode: 'send'; draft: ShareDraft }

export type SidebarPanel = 'inbox' | 'sent' | 'friends' | 'downloads'

export type ChromeCommand =
  | { type: 'focus-omnibox' }
  | { type: 'toggle-sidebar'; panel?: SidebarPanel }
  | { type: 'open-sidebar'; panel: SidebarPanel }
  | { type: 'open-find' }
  | { type: 'find-next'; forward: boolean }
  | { type: 'share-opened'; shareId: string }

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

export interface Settings {
  searchEngine: SearchEngine
  adblock: boolean
  notifications: boolean
  showBookmarksBar: boolean
  restoreSession: boolean
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
  shareId?: string
  panel?: SidebarPanel
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  platform: string
  isDefaultBrowser: boolean
}
