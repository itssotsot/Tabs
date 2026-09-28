import type { SitePermission, TabLayout, ThemeId } from './types'

/** Address-bar dropdown geometry, shared by the main process (sizing) and the overlay (rendering). */
export const SUGGESTION_ROW_HEIGHT = 36
export const SUGGESTION_PADDING = 6
export const MAX_SUGGESTIONS = 8

/** The panel of a collapsed group's tabs, shown beside its chip. Shared like the dropdown's. */
export const GROUP_PEEK_WIDTH = 300
export const GROUP_PEEK_HEAD_HEIGHT = 30
export const GROUP_PEEK_ROW_HEIGHT = 34
export const GROUP_PEEK_PADDING = 6
/** Transparent room around the panel for its shadow. */
export const GROUP_PEEK_MARGIN = 12

/** Every permission Tabs asks about: its name in settings, what a site "wants to" do, and what sites use it for. */
export const SITE_PERMISSIONS: Record<SitePermission, { name: string; wants: string; detail: string }> = {
  camera: { name: 'Camera', wants: 'use your camera', detail: 'Video calls and photos.' },
  microphone: { name: 'Microphone', wants: 'use your microphone', detail: 'Calls, voice messages and dictation.' },
  'display-capture': { name: 'Screen sharing', wants: 'see your screen', detail: 'You still pick what to share every time.' },
  geolocation: { name: 'Location', wants: 'know your location', detail: 'Maps, weather and nearby places.' },
  notifications: { name: 'Notifications', wants: 'show notifications', detail: 'Messages and alerts while the site is in the background.' },
  'clipboard-read': { name: 'Clipboard', wants: 'see text and images you copy', detail: 'Pasting into editors and web apps.' },
  midi: { name: 'MIDI devices', wants: 'use your MIDI devices', detail: 'Music apps and keyboards.' },
  midiSysex: { name: 'MIDI devices (full control)', wants: 'control your MIDI devices', detail: 'Updating and setting up MIDI hardware.' },
  'idle-detection': { name: 'Idle detection', wants: "know when you're using this device", detail: 'Chat apps showing you as away.' },
  openExternal: { name: 'Other apps', wants: 'open other apps', detail: 'Links that open Zoom, Spotify or other installed apps.' }
}

/** The question under the address bar about what a site wants (the overlay's), and the room around it for its shadow. */
export const PERMISSION_PROMPT_WIDTH = 340
export const PERMISSION_PROMPT_MARGIN = 12

export const REACTIONS = ['😂', '🔥', '💀', '❤️', '👍', '🤯'] as const

export const TAB_LAYOUTS: { id: TabLayout; name: string; description: string }[] = [
  { id: 'vertical', name: 'Vertical sidebar', description: 'Favorites, chat links and tabs in a column on the left' },
  { id: 'groups', name: 'Tab groups per chat', description: 'Each chat is a collapsible group of its links' }
]


/** What's behind the browser UI: the window's background, and the bar Windows draws its buttons on. */
export interface WindowColors {
  background: string
  bar: string
  symbols: string
}

/**
 * A theme. Its looks are in styles/themes/<id>/ (see styles/themes/chrome.css); this is what the rest of the app
 * needs to know about it.
 */
export interface ThemeInfo {
  id: ThemeId
  name: string
  description: string
  /** The toolbar takes on the color of the page, and its buttons and text are tinted to match. */
  followsPageColor: boolean
  /**
   * With the system in light and in dark mode (the same twice for a theme that doesn't change). Keep them in
   * step with the theme's --bg (the window) and --bg-raised (the toolbar, where Windows' buttons are).
   */
  window: { light: WindowColors; dark: WindowColors }
}

const DEFAULT_WINDOW: WindowColors = { background: '#161618', bar: '#161618', symbols: '#d4d4d8' }

export const THEMES: ThemeInfo[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Dark, with the toolbar taking on the color of the page',
    followsPageColor: true,
    window: { light: DEFAULT_WINDOW, dark: DEFAULT_WINDOW }
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Hand-drawn on paper, light or dark with your system',
    followsPageColor: false,
    window: {
      light: { background: '#f1ebdd', bar: '#f8f4ea', symbols: '#2c2924' },
      dark: { background: '#1d1c1a', bar: '#252421', symbols: '#ebe5d8' }
    }
  }
]

/** The theme with this id, or Default for one that doesn't exist (anymore). */
export function themeInfo(id: string | undefined): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
