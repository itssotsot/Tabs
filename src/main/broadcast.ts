import { IPC } from '@shared/api'
import { setAdblockEnabled } from './adblock'
import { webSession } from './env'
import { buildAppMenu } from './menu'
import { store } from './store'
import { BrowserWindowController } from './window'

/** Sends to the browser UI of every window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const c of BrowserWindowController.all) {
    if (!c.win.isDestroyed()) c.win.webContents.send(channel, payload)
  }
}

export function bookmarksChanged(): void {
  broadcast(IPC.bookmarksChanged, store.bookmarks)
  // The star in each address bar depends on bookmarks.
  for (const c of BrowserWindowController.all) c.pushState()
}

export function toggleBookmark(c: BrowserWindowController): void {
  const tab = c.activeTab
  if (!tab || tab.isInternal) return
  toggleBookmarkUrl(tab.url, tab.state.title)
}

export function toggleBookmarkUrl(url: string, title: string): void {
  const existing = store.findBookmark(url)
  if (existing) store.removeBookmark(existing.id)
  else store.addBookmark(url, title)
  bookmarksChanged()
}

/** Applies settings that live in the main process and tells every window. */
export function settingsChanged(): void {
  void setAdblockEnabled(webSession(), store.settings.adblock)
  buildAppMenu()
  for (const c of BrowserWindowController.all) c.regroup()
  broadcast(IPC.settingsChanged, store.settings)
}
