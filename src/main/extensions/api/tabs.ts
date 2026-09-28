import { NEW_TAB_URL, INTERNAL_SCHEME } from '@shared/url'
import type { Tab } from '../../tab'
import { BrowserWindowController } from '../../window'
import { canSeeTabDetails, hasActiveTabGrant, hasHostAccess } from '../access'
import { globToRegExp, matchesAny } from '../match-pattern'
import { defineApi, defineEvent, ExtensionError, type CallContext } from '../router'
import { tabGroupId } from './data/index'
import {
  allExtraWindows,
  allTabs,
  chromeTabId,
  currentWindow,
  extraTabFor,
  findTab,
  lastFocusedWindow,
  resolveWindow,
  setOpener,
  toChromeTab,
  WINDOW_ID_CURRENT,
  windowIdOf,
  type FoundTab
} from '../tabs-model'

/** chrome.tabs, on top of the browser's own windows and tabs (see tabs-model). */

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function requireTab(tabId: unknown): FoundTab {
  const found = isNumber(tabId) ? findTab(tabId) : null
  if (!found) throw new ExtensionError(`No tab with id: ${String(tabId)}.`)
  return found
}

/** The tab a method means when tabId is left out: the active tab of the caller's window. */
function tabOrActive(call: CallContext, tabId: unknown): FoundTab {
  if (tabId !== undefined && tabId !== null) return requireTab(tabId)
  const c = currentWindow(call)
  const active = c?.activeTab
  if (!c || !active) throw new ExtensionError('No active tab.')
  return { tab: active, controller: c, index: c.indexOf(active) }
}

/** Where a URL from an extension actually goes. Relative URLs are the extension's own pages. */
export function resolveExtensionUrl(call: CallContext, url: string): string {
  const trimmed = url.trim()
  if (/^javascript:/i.test(trimmed)) throw new ExtensionError('Cannot navigate to a javascript: URL.')
  if (/^chrome:\/\/newtab\/?$/i.test(trimmed)) return NEW_TAB_URL
  if (/^chrome:\/\/extensions\/?/i.test(trimmed)) return `${INTERNAL_SCHEME}://extensions/`
  if (/^chrome:\/\/(history|bookmarks|settings|downloads)\/?/i.test(trimmed)) {
    const page = /^chrome:\/\/(\w+)/i.exec(trimmed)![1].toLowerCase()
    return `${INTERNAL_SCHEME}://${page === 'downloads' ? 'history' : page}/`
  }
  if (/^(chrome|edge|about):/i.test(trimmed) && !/^about:blank$/i.test(trimmed)) throw new ExtensionError(`Cannot open ${trimmed}.`)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return new URL(trimmed, call.extension.url).href
}

function matchesQuery(call: CallContext, found: FoundTab, q: Record<string, unknown>): boolean {
  const { tab, controller } = found
  const active = controller.activeTab === tab
  const state = tab.state
  if (typeof q.active === 'boolean' && q.active !== active) return false
  if (typeof q.highlighted === 'boolean' && q.highlighted !== active) return false
  if (typeof q.pinned === 'boolean' && q.pinned !== tab.pinned) return false
  if (typeof q.audible === 'boolean' && q.audible !== state.audible) return false
  if (typeof q.muted === 'boolean' && q.muted !== state.muted) return false
  if (typeof q.discarded === 'boolean' && q.discarded !== !tab.loaded) return false
  if (typeof q.frozen === 'boolean' && q.frozen !== tab.isFrozen) return false
  if (typeof q.autoDiscardable === 'boolean' && !q.autoDiscardable) return false
  if (typeof q.status === 'string' && q.status !== (tab.isLoading ? 'loading' : 'complete')) return false
  if (isNumber(q.index) && q.index !== found.index) return false
  if (isNumber(q.groupId) && q.groupId !== tabGroupId(tab, controller)) return false
  if (typeof q.windowType === 'string' && q.windowType !== 'normal') return false
  const windowId = windowIdOf(controller)
  if (isNumber(q.windowId)) {
    const wanted = q.windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : q.windowId
    if (wanted !== windowId) return false
  }
  if (q.currentWindow === true && currentWindow(call) !== controller) return false
  if (q.currentWindow === false && currentWindow(call) === controller) return false
  if (q.lastFocusedWindow === true && lastFocusedWindow() !== controller) return false
  if (q.lastFocusedWindow === false && lastFocusedWindow() === controller) return false
  const id = chromeTabId(tab)
  if (q.url !== undefined || q.title !== undefined) {
    // Tabs whose URL the extension can't see never match a URL or title filter.
    if (!canSeeTabDetails(call.extensionId, tab.url, id)) return false
    if (q.url !== undefined) {
      const patterns = (Array.isArray(q.url) ? q.url : [q.url]).filter((p): p is string => typeof p === 'string')
      if (!matchesAny(patterns, tab.url)) return false
    }
    if (typeof q.title === 'string' && !globToRegExp(q.title).test(state.title)) return false
  }
  return true
}

function query(call: CallContext, queryInfo: unknown): chrome.tabs.Tab[] {
  const q = isObject(queryInfo) ? queryInfo : {}
  const out = allTabs()
    .filter((found) => matchesQuery(call, found, q))
    .map(({ tab, controller }) => toChromeTab(tab, controller, call.extensionId))
  // Extension popup windows (windows.create type "popup") hold one tab each.
  const wantsPopups = q.windowType === 'popup' || q.windowType === undefined
  if (wantsPopups && !q.currentWindow && !q.lastFocusedWindow && q.pinned !== true && !isNumber(q.groupId)) {
    for (const w of allExtraWindows()) {
      const extra = extraTabFor(w.wc.id, call.extensionId)
      if (!extra) continue
      if (isNumber(q.windowId) && q.windowId !== w.win.id) continue
      if (q.url !== undefined && !(extra.tab.url && matchesAny((Array.isArray(q.url) ? q.url : [q.url]) as string[], extra.tab.url))) continue
      if (typeof q.active === 'boolean' && !q.active) continue
      out.push(extra.tab)
    }
  }
  return out
}

function get(call: CallContext, tabId: unknown): chrome.tabs.Tab {
  if (isNumber(tabId)) {
    const extra = extraTabFor(tabId, call.extensionId)
    if (extra) return extra.tab
  }
  const { tab, controller } = requireTab(tabId)
  return toChromeTab(tab, controller, call.extensionId)
}

function create(call: CallContext, props: unknown): chrome.tabs.Tab {
  const p = isObject(props) ? props : {}
  const c = (isNumber(p.windowId) ? resolveWindow(p.windowId, call) : null) ?? currentWindow(call) ?? new BrowserWindowController({ urls: [] })
  const url = typeof p.url === 'string' && p.url ? resolveExtensionUrl(call, p.url) : NEW_TAB_URL
  const active = p.active !== false && p.selected !== false
  const index = isNumber(p.index) ? Math.max(0, Math.min(p.index, c.allTabs.length)) : undefined
  const tab = c.createTab(url, { active, index })
  if (p.pinned === true) c.setPinned(tab, true)
  if (isNumber(p.openerTabId)) setOpener(tab, p.openerTabId)
  return toChromeTab(tab, c, call.extensionId)
}

function update(call: CallContext, a: unknown, b: unknown): chrome.tabs.Tab {
  const [tabId, props] = isObject(a) ? [undefined, a] : [a, b]
  const found = tabOrActive(call, tabId)
  const { tab, controller } = found
  const p = isObject(props) ? props : {}
  if (typeof p.url === 'string' && p.url) tab.load(resolveExtensionUrl(call, p.url))
  if (p.active === true || p.highlighted === true || p.selected === true) controller.activate(tab)
  if (typeof p.pinned === 'boolean' && p.pinned !== tab.pinned) controller.setPinned(tab, p.pinned)
  if (typeof p.muted === 'boolean') {
    const wc = tab.liveWc
    if (wc && wc.isAudioMuted() !== p.muted) tab.toggleMute()
  }
  if (isNumber(p.openerTabId)) setOpener(tab, p.openerTabId)
  return toChromeTab(tab, controller, call.extensionId)
}

function remove(_call: CallContext, tabIds: unknown): void {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter(isNumber)
  const found = ids.map((id) => {
    const extra = allExtraWindows().find((w) => w.wc.id === id)
    if (extra) return { extra }
    return { tab: requireTab(id) }
  })
  for (const f of found) {
    if ('extra' in f && f.extra) f.extra.win.close()
    else if ('tab' in f && f.tab) f.tab.controller.closeTab(f.tab.tab)
  }
}

function reload(call: CallContext, a: unknown, b: unknown): void {
  const [tabId, props] = isObject(a) ? [undefined, a] : [a, b]
  const { tab } = tabOrActive(call, tabId)
  tab.reload(isObject(props) && props.bypassCache === true)
}

function duplicate(call: CallContext, tabId: unknown): chrome.tabs.Tab | undefined {
  const { tab, controller, index } = requireTab(tabId)
  controller.duplicateTab(tab)
  const copy = controller.allTabs[index + 1]
  return copy ? toChromeTab(copy, controller, call.extensionId) : undefined
}

/** Moves a tab to another window by reopening it there with its history. */
function moveToWindow(found: FoundTab, target: BrowserWindowController, index: number | undefined): Tab {
  const saved = found.tab.toSaved()
  const snapshot = { url: saved.url, title: saved.title ?? '', favicon: saved.favicon ?? null, entries: saved.entries, index: saved.index }
  const copy = target.createTab(saved.url, { snapshot, index, active: found.controller.activeTab === found.tab })
  if (found.tab.pinned) target.setPinned(copy, true)
  found.controller.closeTab(found.tab)
  return copy
}

function move(call: CallContext, tabIds: unknown, props: unknown): chrome.tabs.Tab | chrome.tabs.Tab[] {
  const single = !Array.isArray(tabIds)
  const ids = (single ? [tabIds] : (tabIds as unknown[])).filter(isNumber)
  const p = isObject(props) ? props : {}
  if (!isNumber(p.index)) throw new ExtensionError('Missing index.')
  const results: chrome.tabs.Tab[] = []
  let offset = 0
  for (const id of ids) {
    const found = requireTab(id)
    const target = isNumber(p.windowId) ? resolveWindow(p.windowId, call) : found.controller
    if (!target) throw new ExtensionError(`No window with id: ${String(p.windowId)}.`)
    const count = target.allTabs.length
    const to = p.index === -1 ? count : p.index + offset
    if (target === found.controller) {
      target.moveTab(found.tab.id, Math.min(to, count - 1))
      results.push(toChromeTab(found.tab, target, call.extensionId))
    } else {
      results.push(toChromeTab(moveToWindow(found, target, Math.min(to, count)), target, call.extensionId))
    }
    if (p.index !== -1) offset++
  }
  return single ? results[0] : results
}

function highlight(call: CallContext, info: unknown): chrome.windows.Window | undefined {
  const i = isObject(info) ? info : {}
  const c = resolveWindow(isNumber(i.windowId) ? i.windowId : undefined, call)
  if (!c) throw new ExtensionError('No window.')
  const indices = (Array.isArray(i.tabs) ? i.tabs : [i.tabs]).filter(isNumber)
  const first = c.allTabs[indices[0]]
  if (!first) throw new ExtensionError('No tab at that index.')
  c.activate(first)
  return undefined
}

function discard(call: CallContext, tabId: unknown): chrome.tabs.Tab | undefined {
  const found = tabId === undefined ? null : requireTab(tabId)
  // Without an id Chrome picks the least important tab: the one used longest ago.
  const target =
    found ??
    allTabs()
      .filter((t) => t.tab.loaded && !t.controller.isShown(t.tab))
      .sort((a, b) => a.tab.lastActiveAt - b.tab.lastActiveAt)[0]
  if (!target || target.controller.isShown(target.tab)) return undefined
  target.tab.sleep()
  return toChromeTab(target.tab, target.controller, call.extensionId)
}

async function captureVisibleTab(call: CallContext, a: unknown, b: unknown): Promise<string> {
  const [windowId, options] = isObject(a) ? [undefined, a] : [a, b]
  const c = resolveWindow(isNumber(windowId) ? windowId : undefined, call)
  const tab = c?.activeTab
  if (!c || !tab || !tab.loaded) throw new ExtensionError('No active tab to capture.')
  const id = chromeTabId(tab)
  if (!hasHostAccess(call.extensionId, tab.url, id) && !hasActiveTabGrant(call.extensionId, id)) {
    throw new ExtensionError("Either the '<all_urls>' or 'activeTab' permission is required.")
  }
  const image = await tab.wc.capturePage()
  const o = isObject(options) ? options : {}
  if (o.format === 'png') return image.toDataURL()
  const quality = isNumber(o.quality) ? Math.max(0, Math.min(100, o.quality)) : 92
  return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
}

async function detectLanguage(call: CallContext, tabId: unknown): Promise<string> {
  const { tab } = tabOrActive(call, tabId)
  if (!tab.loaded) return 'und'
  try {
    const lang = await tab.wc.executeJavaScript('document.documentElement.lang || navigator.language || ""', false)
    return typeof lang === 'string' && lang ? lang.split(/[-_]/)[0].toLowerCase() : 'und'
  } catch {
    return 'und'
  }
}

function zoomOf(tab: Tab): number {
  return tab.loaded ? tab.wc.getZoomFactor() : 1
}

defineApi('tabs', {
  methods: {
    get,
    getCurrent: (call) => {
      if (call.tabId === undefined) return undefined
      const found = findTab(call.tabId)
      return found ? toChromeTab(found.tab, found.controller, call.extensionId) : undefined
    },
    query,
    create,
    update,
    remove,
    reload,
    duplicate,
    move,
    highlight,
    discard,
    captureVisibleTab,
    detectLanguage,
    goBack: (call, tabId) => tabOrActive(call, tabId).tab.goBack(),
    goForward: (call, tabId) => tabOrActive(call, tabId).tab.goForward(),
    getZoom: (call, tabId) => zoomOf(tabOrActive(call, tabId).tab),
    setZoom: (call, a, b) => {
      const [tabId, factor] = isNumber(b) ? [a, b] : [undefined, a]
      const { tab, controller } = tabOrActive(call, tabId)
      const value = isNumber(factor) && factor > 0 ? Math.max(0.25, Math.min(5, factor)) : 1
      tab.wc.setZoomFactor(value)
      controller.onTabUpdated(tab)
    },
    getZoomSettings: () => ({ mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 }),
    setZoomSettings: () => undefined
  }
})

for (const name of [
  'onCreated',
  'onUpdated',
  'onMoved',
  'onActivated',
  'onHighlighted',
  'onDetached',
  'onAttached',
  'onRemoved',
  'onReplaced',
  'onZoomChange',
  // Deprecated names some extensions still use.
  'onActiveChanged',
  'onHighlightChanged',
  'onSelectionChanged'
]) {
  defineEvent(`tabs.${name}`)
}
