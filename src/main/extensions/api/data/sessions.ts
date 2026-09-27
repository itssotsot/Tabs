import { browserEvents } from '../../../browser-events'
import type { SavedTab } from '../../../store'
import { BrowserWindowController, recentlyClosedTabs, reopenClosedTabAt } from '../../../window'
import { canSeeTabDetails } from '../../access'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { currentWindow, toChromeTab } from '../../tabs-model'
import { isNumber, isObject, isString } from './util'

/**
 * chrome.sessions: recently closed tabs (shared by all windows, like Chrome's), restoring them,
 * and no other devices. Closed windows aren't kept, so every session is a tab.
 */

export const MAX_SESSION_RESULTS = 25

const sessionIds = new WeakMap<SavedTab, string>()
const closedAt = new WeakMap<SavedTab, number>()
let nextSessionId = 1
/** The session ids of the list as extensions last heard of it. */
let lastSignature = ''

/** Gives newly closed tabs an id and a closing time. */
function stamp(): readonly SavedTab[] {
  const list = recentlyClosedTabs()
  for (const saved of list) {
    if (sessionIds.has(saved)) continue
    sessionIds.set(saved, String(nextSessionId++))
    closedAt.set(saved, Date.now())
  }
  return list
}

function toSession(saved: SavedTab, extensionId: string): chrome.sessions.Session {
  const tab = {
    sessionId: sessionIds.get(saved),
    index: -1,
    windowId: -1,
    highlighted: false,
    active: false,
    pinned: saved.pinned,
    audible: false,
    discarded: true,
    autoDiscardable: true,
    mutedInfo: { muted: false },
    incognito: false,
    selected: false,
    groupId: -1
  } as chrome.tabs.Tab
  if (canSeeTabDetails(extensionId, saved.url)) {
    tab.url = saved.url
    tab.title = saved.title ?? ''
    if (saved.favicon) tab.favIconUrl = saved.favicon
  }
  return { lastModified: Math.floor((closedAt.get(saved) ?? Date.now()) / 1000), tab }
}

/** Tells extensions when the list changed (a tab closed, or one was reopened here or in the app). */
function checkChanged(): void {
  const signature = stamp()
    .map((s) => sessionIds.get(s))
    .join(',')
  if (signature === lastSignature) return
  lastSignature = signature
  emit('sessions.onChanged', [])
}

let checkTimer: NodeJS.Timeout | null = null

function scheduleCheck(): void {
  if (checkTimer) return
  checkTimer = setTimeout(() => {
    checkTimer = null
    checkChanged()
  }, 50)
}

browserEvents.on('tab-closed', scheduleCheck)
browserEvents.on('window-state', scheduleCheck)

function getRecentlyClosed(call: CallContext, filter: unknown): chrome.sessions.Session[] {
  const max = isObject(filter) && isNumber(filter.maxResults) ? filter.maxResults : MAX_SESSION_RESULTS
  if (max < 0 || max > MAX_SESSION_RESULTS) throw new ExtensionError(`maxResults must be between 0 and ${MAX_SESSION_RESULTS}.`)
  return stamp()
    .slice(0, max)
    .map((saved) => toSession(saved, call.extensionId))
}

function restore(call: CallContext, sessionId: unknown): chrome.sessions.Session {
  const list = stamp()
  const position = sessionId === undefined || sessionId === null ? 0 : list.findIndex((s) => sessionIds.get(s) === sessionId)
  if (!list.length && (sessionId === undefined || sessionId === null)) throw new ExtensionError('There are no recently closed sessions.')
  if (position === -1 || !list[position]) throw new ExtensionError(`Invalid session id: "${isString(sessionId) ? sessionId : String(sessionId)}".`)
  const saved = list[position]
  const c = currentWindow(call) ?? new BrowserWindowController({ urls: [] })
  const tab = reopenClosedTabAt(position, c)
  if (!tab) throw new ExtensionError('Could not restore the session.')
  c.activate(tab)
  c.focus()
  scheduleCheck()
  return { lastModified: Math.floor((closedAt.get(saved) ?? Date.now()) / 1000), tab: toChromeTab(tab, c, call.extensionId) }
}

defineApi('sessions', {
  permissions: ['sessions'],
  methods: {
    getRecentlyClosed,
    getDevices: () => [],
    restore
  }
})

defineEvent('sessions.onChanged', { permissions: ['sessions'] })
