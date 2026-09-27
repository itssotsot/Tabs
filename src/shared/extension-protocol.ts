/**
 * How extension pages and background workers talk to the main process for the Chrome APIs
 * Electron doesn't implement (see src/preload/extension.ts and src/main/extensions/router.ts).
 */
export const EXT_CHANNEL = {
  /** invoke(namespace, method, args) -> result. Rejects with the API's error message. */
  call: 'tabs-ext:call',
  /** send(eventName, listenerKey, filter | null, add) — a listener was added or removed. */
  listen: 'tabs-ext:listen',
  /** main -> context: (eventName, args, replyId | null, listenerKeys | null). */
  event: 'tabs-ext:event',
  /** send(replyId, value, error | null) — a listener's response to an event that wants one. */
  reply: 'tabs-ext:reply',
  /** send() — a new document or worker started; forget its old listeners. */
  hello: 'tabs-ext:hello',
  /** send() — the worker's top-level script has run, so its listeners are registered. */
  ready: 'tabs-ext:ready'
} as const

/** Events the main process sends to every live context; not part of any chrome.* API. */
export const INTERNAL_EVENT = {
  /** (tabs: Record<number, SenderTabInfo>) — keeps `sender.tab` in runtime messages accurate. */
  tabsCache: '__tabs.cache'
} as const

/** What runtime.onMessage's sender.tab gets corrected with (Electron fills these in wrong). */
export interface SenderTabInfo {
  windowId: number
  index: number
  active: boolean
  highlighted: boolean
  pinned: boolean
  discarded: boolean
}
