// Memory Saver, modelled on Chrome's: background tabs are paused after a few minutes
// and unloaded after longer, then come back (with history and scroll position) when opened.
import { app, BrowserWindow } from 'electron'
import { store } from './store'
import type { Tab } from './tab'
import { BrowserWindowController } from './window'

// BROWSERR_FAST_MEMORY_SAVER=1 (dev only) shrinks the timers so the behaviour can be tested.
const fast = !app.isPackaged && process.env.BROWSERR_FAST_MEMORY_SAVER === '1'
const CHECK_INTERVAL_MS = fast ? 3_000 : 60_000
const FREEZE_AFTER_MS = fast ? 10_000 : 5 * 60_000
const SLEEP_AFTER_MS = fast ? 20_000 : 30 * 60_000
/** When the machine is short on memory, unload much sooner. */
const SLEEP_AFTER_UNDER_PRESSURE_MS = 5 * 60_000
const LOW_MEMORY_RATIO = 0.08

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Tabs that must keep running in the background. */
function mustStayAwake(tab: Tab): boolean {
  // A call goes quiet when nobody talks, and pausing its tab would drop it.
  if (tab.pinned || tab.audible || tab.inCall) return true
  const wc = tab.liveWc
  if (!wc || wc.isDevToolsOpened()) return true
  // A popup it opened (e.g. "Sign in with Google") would lose its window.opener.
  if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.opener?.top === wc.mainFrame)) {
    return true
  }
  // Sites allowed to notify you (chat, mail) need to keep running to do so.
  const origin = originOf(tab.url)
  return !!origin && store.getPermission(origin, 'notifications') === 'allow'
}

function lowOnMemory(): boolean {
  const { free, total } = process.getSystemMemoryInfo()
  return total > 0 && free / total < LOW_MEMORY_RATIO
}

function check(): void {
  if (!store.settings.memorySaver) return
  const now = Date.now()
  const sleepAfter = lowOnMemory() ? SLEEP_AFTER_UNDER_PRESSURE_MS : SLEEP_AFTER_MS

  for (const c of BrowserWindowController.all) {
    for (const tab of c.allTabs) {
      if (tab === c.activeTab || !tab.loaded || mustStayAwake(tab)) continue
      const idle = now - tab.lastActiveAt
      if (idle >= sleepAfter) tab.sleep()
      else if (idle >= FREEZE_AFTER_MS && !tab.isFrozen) void tab.freeze()
    }
  }
}

export function startMemorySaver(): void {
  setInterval(() => {
    try {
      check()
    } catch (err) {
      console.error('[memory-saver] check failed', err)
    }
  }, CHECK_INTERVAL_MS).unref()
}
