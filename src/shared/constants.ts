import type { TabLayout } from './types'

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

export const REACTIONS = ['😂', '🔥', '💀', '❤️', '👍', '🤯'] as const

export const TAB_LAYOUTS: { id: TabLayout; name: string; description: string }[] = [
  { id: 'vertical', name: 'Vertical sidebar', description: 'Favorites, chat links and tabs in a column on the left' },
  { id: 'groups', name: 'Tab groups per chat', description: 'Each chat is a collapsible group of its links' }
]
