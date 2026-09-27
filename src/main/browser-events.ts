import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { Tab } from './tab'
import type { BrowserWindowController } from './window'

/**
 * What happens to windows and tabs, for code that follows along without the window and tab
 * classes depending on it (Chrome extensions' tabs and windows APIs).
 */
interface BrowserEventMap {
  /** A window's tabs or their state changed (coalesced, like the browser UI's updates). */
  'window-state': [controller: BrowserWindowController]
  'window-created': [controller: BrowserWindowController]
  'window-closed': [controller: BrowserWindowController]
  'window-focused': [controller: BrowserWindowController]
  'window-bounds': [controller: BrowserWindowController]
  /** A tab started or stopped loading. Sent right away, unlike window-state. */
  'tab-loading': [tab: Tab, loading: boolean]
  /** A tab's page was created (opened, or woken from sleep). */
  'tab-webcontents-created': [tab: Tab, wc: WebContents]
  /** A tab's page is going away (tab closed, or put to sleep). */
  'tab-webcontents-destroyed': [tab: Tab, wc: WebContents]
  'tab-closed': [tab: Tab, controller: BrowserWindowController, windowClosing: boolean]
  /** A page opened a new tab (a link with target=_blank, window.open without features). */
  'tab-opened': [tab: Tab, opener: Tab, url: string]
}

class BrowserEvents extends EventEmitter<BrowserEventMap> {}

export const browserEvents = new BrowserEvents()
browserEvents.setMaxListeners(50)
