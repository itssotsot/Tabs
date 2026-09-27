import type { WebContents } from 'electron'
import { getDomain } from 'tldts'
import { colorFor } from '@shared/colors'
import { store } from './store'

/** What grouping needs to know about a tab. */
export interface Groupable {
  pinned: boolean
  site: string | null
  /** The site whose group the tab was dragged out of. */
  pulledOutOf: string | null
  /** Another site's group the tab was dragged into. It stays there, whatever site it goes to, until dragged out. */
  joinedGroup: string | null
}

/** The group a tab belongs with: the one it was dragged into, else its site's. */
export function groupKey(tab: Groupable): string | null {
  return tab.joinedGroup ?? tab.site
}

/**
 * The site a page belongs to, for grouping: its registrable domain (youtube.com for music.youtube.com,
 * bbc.co.uk for www.bbc.co.uk). Null for internal pages, files, localhost and IP addresses.
 */
export function siteOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  // Private suffixes count, so two people's github.io pages are different sites.
  return getDomain(url, { allowPrivateDomains: true })
}

/** The group each tab is in: its site (or the group it was dragged into), when at least two eligible tabs share it. */
export function siteGroups<T extends Groupable>(tabs: readonly T[], excluded: ReadonlySet<string>): Map<T, string> {
  const bySite = new Map<string, T[]>()
  for (const tab of tabs) {
    const site = groupKey(tab)
    if (tab.pinned || !site || excluded.has(site) || tab.pulledOutOf === site) continue
    const members = bySite.get(site)
    if (members) members.push(tab)
    else bySite.set(site, [tab])
  }
  const groups = new Map<T, string>()
  for (const [site, members] of bySite) if (members.length > 1) for (const tab of members) groups.set(tab, site)
  return groups
}

/**
 * Tab order with pinned tabs first, then each group's tabs together (groups in the order their first tabs
 * come), then the tabs in no group. `moved` (a tab that just opened or changed site) goes to the end of
 * its group unless it's already next to one of its tabs. Null if nothing moves.
 */
export function arrangeGroups<T extends { pinned: boolean }>(tabs: readonly T[], groups: ReadonlyMap<T, string>, moved?: T): T[] | null {
  const order = [...tabs]
  const group = moved && groups.get(moved)
  if (moved && group) {
    const inGroup = (t: T | undefined): boolean => t !== undefined && groups.get(t) === group
    const i = order.indexOf(moved)
    if (!inGroup(order[i - 1]) && !inGroup(order[i + 1])) {
      order.splice(i, 1)
      order.splice(order.findLastIndex(inGroup) + 1, 0, moved)
    }
  }
  const placed = new Set<string>()
  const grouped: T[] = []
  for (const tab of order) {
    const g = groups.get(tab)
    if (g && !placed.has(g)) {
      placed.add(g)
      grouped.push(...order.filter((t) => groups.get(t) === g))
    }
  }
  // Pinned tabs are never in a group.
  const loose = order.filter((t) => !groups.has(t))
  const result = [...loose.filter((t) => t.pinned), ...grouped, ...loose.filter((t) => !t.pinned)]
  return result.some((t, i) => t !== tabs[i]) ? result : null
}

/** youtube.com -> Youtube, until a page tells us better. */
function fallbackName(site: string): string {
  const label = site.split('.')[0]
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function siteName(site: string): string {
  return store.siteName(site) ?? fallbackName(site)
}

/** The color picked for the site's group, else its automatic one. */
export function siteColor(site: string): string {
  return store.siteColor(site) ?? colorFor(site)
}

const READ_SITE_NAME = `(() => {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null
  return meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]')
})()`

const ISOLATED_WORLD_ID = 1002
const MAX_NAME_LENGTH = 40
/** Sites whose name we've read this session. Pages without one don't count: another page may have it. */
const learned = new Set<string>()

/**
 * Learns what a site calls itself (YouTube, not Youtube) from its pages. Only pages on the site itself
 * count: docs.google.com calls itself "Google Docs", which isn't a name for all of google.com.
 */
export async function learnSiteName(wc: WebContents): Promise<boolean> {
  const url = wc.getURL()
  const site = siteOf(url)
  if (!site || learned.has(site)) return false
  try {
    if (new URL(url).hostname.replace(/^www\./, '') !== site) return false
    const name = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: READ_SITE_NAME }])) as unknown
    if (typeof name !== 'string' || !name || name.length > MAX_NAME_LENGTH) return false
    learned.add(site)
    if (name === store.siteName(site)) return false
    store.setSiteName(site, name)
    return true
  } catch {
    return false
  }
}
