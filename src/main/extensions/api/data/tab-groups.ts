import { browserEvents } from '../../../browser-events'
import { siteColor, siteName } from '../../../sites'
import { store } from '../../../store'
import type { Tab } from '../../../tab'
import { BrowserWindowController } from '../../../window'
import { lifecycle } from '../../lifecycle'
import { globToRegExp } from '../../match-pattern'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { currentWindow, findTab, findWindow, setGroupIdProvider, WINDOW_ID_CURRENT, type FoundTab } from '../../tabs-model'
import { chromeColor, COLORS, HEX_FOR_COLOR, type Color } from './group-colors'
import { isNumber, isObject, isString } from './util'

/**
 * chrome.tabGroups over the app's automatic groups: tabs from the same site (two or more) form a
 * group. Each window + site gets an integer id that stays the same for the session; the title is
 * the site's name and the color the nearest of Chrome's nine to the site's color. Groups are never
 * collapsed as far as extensions can tell (collapsing is the browser UI's business). Changing the
 * title or color changes the site's name or color in the app, for every window.
 */

export const TAB_GROUP_ID_NONE = -1

// ---- ids ----

const idsByKey = new Map<string, number>()
const keysById = new Map<number, { windowId: number; site: string }>()
let nextGroupId = 1

function groupId(windowId: number, site: string): number {
  const key = `${windowId}|${site}`
  let id = idsByKey.get(key)
  if (id === undefined) {
    id = nextGroupId++
    idsByKey.set(key, id)
    keysById.set(id, { windowId, site })
  }
  return id
}

// ---- the groups of a window ----

/** Each window's tab -> site group, cached until the current job ends (tabs.query asks for every tab). */
const cache = new Map<BrowserWindowController, Map<Tab, string>>()
let clearQueued = false

function groupsOf(c: BrowserWindowController): Map<Tab, string> {
  let groups = cache.get(c)
  if (!groups) {
    groups = new Map()
    for (const tab of c.allTabs) {
      const site = c.groupOf(tab)
      if (site) groups.set(tab, site)
    }
    cache.set(c, groups)
    if (!clearQueued) {
      clearQueued = true
      queueMicrotask(() => {
        clearQueued = false
        cache.clear()
      })
    }
  }
  return groups
}

function forgetCache(): void {
  cache.clear()
}

interface GroupInfo {
  id: number
  site: string
  controller: BrowserWindowController
  /** Index of its first tab. */
  index: number
}

/** A window's groups, in tab order. */
function windowGroups(c: BrowserWindowController): GroupInfo[] {
  const out = new Map<string, GroupInfo>()
  const groups = groupsOf(c)
  c.allTabs.forEach((tab, index) => {
    const site = groups.get(tab)
    if (site && !out.has(site)) out.set(site, { id: groupId(c.win.id, site), site, controller: c, index })
  })
  return [...out.values()]
}

function toTabGroup(g: { id: number; site: string; controller: BrowserWindowController }): chrome.tabGroups.TabGroup {
  return {
    id: g.id,
    collapsed: false,
    color: chromeColor(siteColor(g.site)) as chrome.tabGroups.Color,
    title: siteName(g.site),
    windowId: g.controller.win.id,
    shared: false
  } as chrome.tabGroups.TabGroup
}

function liveWindows(): BrowserWindowController[] {
  return [...BrowserWindowController.all].filter((c) => !c.win.isDestroyed())
}

/** The group with this id, if it exists right now. */
function findGroup(id: unknown): GroupInfo | null {
  if (!isNumber(id)) return null
  const key = keysById.get(id)
  const c = key ? findWindow(key.windowId) : null
  if (!key || !c) return null
  return windowGroups(c).find((g) => g.site === key.site) ?? null
}

function requireGroup(id: unknown): GroupInfo {
  const g = findGroup(id)
  if (!g) throw new ExtensionError(`No group with id: ${String(id)}.`)
  return g
}

/** The chrome tab group id of a tab (TAB_GROUP_ID_NONE when it's in none), e.g. for tabs.query's groupId filter. */
export function tabGroupId(tab: Tab, c: BrowserWindowController): number {
  const site = groupsOf(c).get(tab)
  return site ? groupId(c.win.id, site) : TAB_GROUP_ID_NONE
}

setGroupIdProvider(tabGroupId)

// ---- events ----

interface Seen {
  title: string
  color: Color
  order: number
}

const seen = new Map<number, Map<number, Seen>>()

function snapshot(c: BrowserWindowController): Map<number, Seen> {
  const out = new Map<number, Seen>()
  windowGroups(c).forEach((g, order) => {
    const tg = toTabGroup(g)
    out.set(g.id, { title: tg.title ?? '', color: tg.color as Color, order })
  })
  return out
}

/** Groups whose place among the others changed: those off the longest run that kept its order. */
function movedGroups(order: { id: number; from: number }[]): number[] {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(order.length).fill(-1)
  for (let i = 0; i < order.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < order[i].from) lo = mid + 1
      else hi = mid
    }
    tails[lo] = order[i].from
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  }
  const keep = new Set<number>()
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) keep.add(i)
  return order.filter((_, i) => !keep.has(i)).map((o) => o.id)
}

function diffWindow(c: BrowserWindowController): void {
  if (c.win.isDestroyed()) return
  forgetCache()
  const windowId = c.win.id
  const before = seen.get(windowId) ?? new Map<number, Seen>()
  const after = snapshot(c)
  seen.set(windowId, after)
  const groupFor = (id: number): chrome.tabGroups.TabGroup | null => {
    const g = findGroup(id)
    return g ? toTabGroup(g) : null
  }
  for (const [id, old] of before) {
    if (after.has(id)) continue
    emit('tabGroups.onRemoved', [{ id, collapsed: false, color: old.color, title: old.title, windowId, shared: false }])
  }
  const surviving: { id: number; from: number }[] = []
  for (const [id, now] of after) {
    const old = before.get(id)
    const group = groupFor(id)
    if (!group) continue
    if (!old) {
      emit('tabGroups.onCreated', [group])
      continue
    }
    surviving.push({ id, from: old.order })
    if (old.title !== now.title || old.color !== now.color) emit('tabGroups.onUpdated', [group])
  }
  for (const id of movedGroups(surviving)) {
    const group = groupFor(id)
    if (group) emit('tabGroups.onMoved', [group])
  }
}

browserEvents.on('window-state', diffWindow)
browserEvents.on('window-closed', (c) => {
  const windowId = c.win.id
  const before = seen.get(windowId)
  seen.delete(windowId)
  forgetCache()
  for (const [id, old] of before ?? []) {
    emit('tabGroups.onRemoved', [{ id, collapsed: false, color: old.color, title: old.title, windowId, shared: false }])
  }
})
lifecycle.on('ready', () => {
  // Groups that exist already aren't news.
  for (const c of liveWindows()) seen.set(c.win.id, snapshot(c))
})

/** Makes every window show (and report) new site names and colors. */
function refreshWindows(): void {
  forgetCache()
  for (const c of liveWindows()) c.pushState()
}

// ---- tabGroups API ----

function query(call: CallContext, queryInfo: unknown): chrome.tabGroups.TabGroup[] {
  const q = isObject(queryInfo) ? queryInfo : {}
  const windowId = q.windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : q.windowId
  const title = isString(q.title) ? globToRegExp(q.title) : null
  return liveWindows()
    .flatMap(windowGroups)
    .map(toTabGroup)
    .filter(
      (g) =>
        (q.collapsed === undefined || q.collapsed === g.collapsed) &&
        (q.shared === undefined || q.shared === g.shared) &&
        (!isString(q.color) || q.color === g.color) &&
        (!title || title.test(g.title ?? '')) &&
        (windowId === undefined || windowId === g.windowId)
    )
}

function update(_call: CallContext, id: unknown, props: unknown): chrome.tabGroups.TabGroup {
  const g = requireGroup(id)
  const p = isObject(props) ? props : {}
  if (p.color !== undefined) {
    if (!COLORS.includes(p.color as Color)) throw new ExtensionError(`Invalid color: ${String(p.color)}.`)
    // Keeps the site's own color when it's already this one.
    if (chromeColor(siteColor(g.site)) !== p.color) store.setSiteColor(g.site, HEX_FOR_COLOR[p.color as Color])
  }
  if (p.title !== undefined) {
    if (!isString(p.title)) throw new ExtensionError('Invalid title.')
    const title = p.title.trim()
    if (!title) throw new ExtensionError("Group titles can't be empty in this browser: a group is named after its site.")
    if (title !== siteName(g.site)) store.setSiteName(g.site, title.slice(0, 40))
  }
  // p.collapsed: collapsing is up to the browser UI; groups stay reported as expanded.
  refreshWindows()
  return toTabGroup(requireGroup(id))
}

function move(call: CallContext, id: unknown, props: unknown): chrome.tabGroups.TabGroup {
  const g = requireGroup(id)
  const p = isObject(props) ? props : {}
  if (!isNumber(p.index)) throw new ExtensionError('Missing index.')
  if (p.windowId !== undefined) {
    const target = p.windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : p.windowId
    if (target !== g.controller.win.id) throw new ExtensionError("Moving groups to another window isn't supported in this browser.")
  }
  const c = g.controller
  const tabs = c.allTabs
  const members = [...groupsOf(c)].filter(([, site]) => site === g.site).length
  const pinned = tabs.filter((t) => t.pinned).length
  if (p.index !== -1 && p.index < pinned) throw new ExtensionError('Cannot move the group to an index that is in the middle of pinned tabs.')
  // Chrome's index is where the group's first tab ends up; the window moves a group onto the tab it's dropped on.
  const to = p.index === -1 ? tabs.length - 1 : Math.min(p.index + (p.index > g.index ? members - 1 : 0), tabs.length - 1)
  c.moveGroup(g.site, to)
  forgetCache()
  return toTabGroup(requireGroup(id))
}

defineApi('tabGroups', {
  permissions: ['tabGroups'],
  methods: {
    get: (_call, id) => toTabGroup(requireGroup(id)),
    query,
    update,
    move
  }
})

for (const name of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) defineEvent(`tabGroups.${name}`, { permissions: ['tabGroups'] })

// ---- tabs.group / tabs.ungroup ----

function tabsFrom(tabIds: unknown): FoundTab[] {
  const list = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter((id) => id !== undefined)
  if (!list.length) throw new ExtensionError('You must specify at least one tab.')
  return list.map((id) => {
    const found = isNumber(id) ? findTab(id) : null
    if (!found) throw new ExtensionError(`No tab with id: ${String(id)}.`)
    return found
  })
}

/** Puts a tab at the end of a site's group in its window. */
function addToGroup(c: BrowserWindowController, tab: Tab, site: string): void {
  if (tab.pinned) c.setPinned(tab, false)
  const groups = groupsOf(c)
  const last = c.allTabs.findLastIndex((t) => groups.get(t) === site)
  c.dragTab(tab.id, last === -1 ? c.allTabs.length - 1 : last + 1, site)
  forgetCache()
}

/**
 * Best effort: the app only groups tabs by site. With a groupId the tabs join that group (whatever
 * their site); without one they join the first tab's site's group, which needs at least two tabs.
 */
function group(call: CallContext, options: unknown): number {
  const o = isObject(options) ? options : {}
  const found = tabsFrom(o.tabIds)
  const c = found[0].controller
  if (found.some((f) => f.controller !== c)) throw new ExtensionError("Tabs from different windows can't be grouped in this browser.")
  if (!store.settings.groupTabsBySite) throw new ExtensionError('Tab groups are turned off in settings.')
  let site: string
  if (o.groupId !== undefined) {
    const g = requireGroup(o.groupId)
    if (g.controller !== c) throw new ExtensionError("Moving tabs to a group in another window isn't supported in this browser.")
    if (isObject(o.createProperties)) throw new ExtensionError('Cannot specify createProperties along with a groupId.')
    site = g.site
  } else {
    const props = isObject(o.createProperties) ? o.createProperties : {}
    if (props.windowId !== undefined) {
      const target = props.windowId === WINDOW_ID_CURRENT ? currentWindow(call) : isNumber(props.windowId) ? findWindow(props.windowId) : null
      if (target !== c) throw new ExtensionError("Moving tabs to another window isn't supported when grouping in this browser.")
    }
    const first = found[0].tab.site
    if (!first) throw new ExtensionError("This tab can't be in a group: this browser groups web pages by site.")
    site = first
  }
  for (const f of found) addToGroup(c, f.tab, site)
  const g = windowGroups(c).find((x) => x.site === site)
  if (!g || !found.every((f) => groupsOf(c).get(f.tab) === site)) {
    throw new ExtensionError("Couldn't group these tabs: this browser groups tabs by site, and a group needs at least two tabs.")
  }
  return g.id
}

function ungroup(_call: CallContext, tabIds: unknown): void {
  for (const { tab, controller } of tabsFrom(tabIds)) {
    controller.removeFromGroup(tab)
    forgetCache()
  }
}

defineApi('tabs', { methods: { group, ungroup } })
