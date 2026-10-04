import type { SplitSide, SplitState } from './split'

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
  /** The page's video, on sites whose player the tab can control (YouTube). Null when nothing has played. */
  media: TabMedia | null
  /** The call the page is in (Google Meet), for the tab's mic and camera buttons. Null when there's none. */
  call: TabCall | null
  /** Which of your devices the page is using right now; null when none. */
  capture: TabCapture | null
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
  /** The main color along the top of the page (#rrggbb), which the toolbar takes on. Null until read. */
  color: string | null
  /** The colors along the top of the page from left to right, evenly spaced, which the toolbar extends upward. */
  edge: string[] | null
  /** Its side of a split view and the tab on the other side, when it's in one (see WindowState.splits). */
  split?: { side: SplitSide; with: number }
  /** Its page is on screen: it's the active tab, or the other half of the active tab's split. */
  onScreen?: boolean
}

/** Where a tab's video is. The strip works out the current position from `time`, `rate` and `at`. */
export interface TabMedia {
  paused: boolean
  /** Seconds into the video when this was read. */
  time: number
  /** Seconds, or null for live streams. */
  duration: number | null
  /** How fast `time` moves (0 while paused or buffering). */
  rate: number
  /** When `time` was read (ms since epoch). */
  at: number
}

export type MediaCommand = { type: 'toggle' } | { type: 'seek'; time: number }

/** Whether a call is sending your microphone and camera: true when on, null when the call has no such button. */
export interface CallState {
  mic: boolean | null
  camera: boolean | null
}

/** Someone else in a call, as the call shows them. */
export interface CallPerson {
  name: string
  /** A still from their camera while it's on (a data: URL), else their photo; null when the call shows neither. */
  picture: string | null
}

/** What a page reports about its call: its mic and camera, and who else is in it (on sites Tabs can read that from). */
export interface PageCall extends CallState {
  people: CallPerson[]
}

/**
 * A tab's call, for its mic and camera buttons. `by` says who mutes: `site`, the call's own buttons (the call shows
 * you muted); or `tabs`, Tabs itself, for sites it can't press the buttons of (the call hears silence, or sees black,
 * but doesn't know). `people` is empty when Tabs can't tell who's in it.
 */
export interface TabCall extends PageCall {
  by: 'site' | 'tabs'
}

export type CallDevice = 'mic' | 'camera'

/** Which of your devices a page is using: the camera or microphone it opened, or a screen it's sharing. */
export interface TabCapture {
  camera: boolean
  microphone: boolean
  screen: boolean
}

export type CaptureDevice = keyof TabCapture

/** What a site can be allowed to do, as Tabs asks and remembers it (SITE_PERMISSIONS has their names). */
export type SitePermission =
  | 'camera'
  | 'microphone'
  | 'display-capture'
  | 'geolocation'
  | 'notifications'
  | 'clipboard-read'
  | 'midi'
  | 'midiSysex'
  | 'idle-detection'
  | 'openExternal'

export type PermissionDecision = 'allow' | 'deny'

/** How a permission looks to a page, as the Permissions API says it: `prompt` while you'd be asked. */
export type PageSitePermissionState = 'granted' | 'denied' | 'prompt'

/** A site's saved choices. */
export interface SiteAccess {
  origin: string
  permissions: Partial<Record<SitePermission, PermissionDecision>>
}

/** Your camera, microphone and speakers, by name (sites see different ids for them). Null: the system's default. */
export interface DeviceChoice {
  camera: string | null
  microphone: string | null
  speaker: string | null
}

/** A question under the address bar about what a site wants. */
export type PermissionPrompt =
  | {
      kind: 'ask'
      id: number
      host: string
      permissions: SitePermission[]
      devices: DeviceChoice
      /** The devices it can show you (a camera picture, a microphone level) while asking. */
      preview: ('camera' | 'microphone')[]
    }
  /** macOS isn't letting Tabs use the camera or microphone a site asked for. */
  | { kind: 'system'; id: number; host: string; blocked: ('camera' | 'microphone')[] }

/**
 * The answer to a PermissionPrompt. `once` allows until the page is left, `always` remembers it. `dismiss` (closing it,
 * or the system prompt's "not now") allows nothing and remembers nothing.
 */
export type PermissionAnswer =
  | { id: number; decision: 'once' | 'always' | 'block' | 'dismiss'; devices?: DeviceChoice }
  | { id: number; decision: 'open-system-settings' }

/** The colors along the top of a tab's page, as in its `TabState`. */
export interface PageEdge {
  tabId: number
  color: string
  edge: string[]
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
  /** Pairs of tabs shown side by side. A pair shows whenever one of its tabs is the active tab. */
  splits: SplitState[]
}

/** A picture of a page on screen, for the split view's drop area to show in its place while a tab is dragged. */
export interface SplitPane {
  tabId: number
  /** Where the page is, relative to the page area's top left. */
  rect: Rect
  /** A JPEG of the page, or null when it couldn't be taken. */
  image: Uint8Array | null
}

/** What's on screen as a tab starts being dragged (see BrowserrAPI.split). */
export interface SplitDragStart {
  panes: SplitPane[]
  /** The tab a split made from this drag would share the window with, when there's no split showing. */
  partner: number | null
  /** The split on screen, if the pages on screen are one. */
  split: SplitState | null
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

/**
 * The address bar as the send picker needs it. Rather than where the bar is, which changes as the window is
 * resized, it's the toolbar around it (which doesn't): the picker lays out a copy of the toolbar and finds the
 * bar in it, so it follows a resize in the same frame. And the bar's colors, which follow the page.
 */
export interface OmniboxAnchor {
  /** The browser UI's classes (the tab layout), which the toolbar's styles depend on. */
  chromeClass: string
  /** Where the toolbar starts: past the tab sidebar, and below the tab strip. */
  left: number
  top: number
  /** How wide the toolbar's buttons before and after the bar are, gaps between them included. */
  before: number
  after: number
  /** How wide the toolbar is. In a split view each page has its own, which ends at the divider. */
  width: number
  /** CSS colors, as the address bar's own background and text. */
  background: string
  foreground: string
}

export type OverlayState =
  | { mode: 'hidden' }
  | { mode: 'suggestions'; items: Suggestion[]; selected: number }
  /**
   * `more` are the rest of the links when sending a whole tab group. `anchor` is the address bar, which the
   * picker grows out of; null when it isn't on screen.
   */
  | { mode: 'send'; draft: ShareDraft; more?: ShareDraft[]; anchor: OmniboxAnchor | null; windowWidth: number }
  /** What a site wants, asked under the address bar. */
  | { mode: 'permission'; prompt: PermissionPrompt }
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
  /** The send picker opened out of the address bar (or closed back into it). */
  | { type: 'send-picker'; open: boolean }
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
  /** Show the welcome intro again, at the import step (File › Import from Another Browser). */
  | { type: 'show-import' }
  /** The intro was finished in some window, so every window closes it. */
  | { type: 'intro-finished' }

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

/** How the browser UI looks. Paper follows the system's light or dark appearance. */
export type ThemeId = 'default' | 'paper'

export interface Settings {
  searchEngine: SearchEngine
  theme: ThemeId
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
  /** Show on each tab how long ago it was opened. */
  showTabAge: boolean
  /** Mark each tab in a group with a line in the group's color. */
  showGroupLines: boolean
  /** Permissions sites aren't asked for, only blocked, unless a site was allowed before. */
  blockedPermissions: SitePermission[]
  /** The camera, microphone and speakers sites use. */
  devices: DeviceChoice
}

/** A browser (profile) on this computer that bookmarks and history can be imported from. */
export interface ImportSource {
  id: string
  browser: string
  kind: 'chromium' | 'firefox' | 'safari'
  /** The browser's app icon (data: URL), if it could be found. */
  icon: string | null
  /** Set when the browser has more than one profile. */
  profile: string | null
  /** macOS won't let Tabs read it until Tabs has Full Disk Access (Safari). */
  needsAccess: boolean
}

/** Favorites come from the other browser's bookmarks bar; tabs are the ones it has open. */
export interface ImportCounts {
  favorites: number
  history: number
  tabs: number
}

export interface ImportPreview extends ImportCounts {
  /** Bookmarks on the bar that aren't favorites yet. Only the first `favorites` of them come over. */
  favoritesFound: number
  /** Open tabs (each page once). Only the first `tabs` of them come over. */
  tabsFound: number
}

export interface ImportChoice {
  favorites: boolean
  history: boolean
  tabs: boolean
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
