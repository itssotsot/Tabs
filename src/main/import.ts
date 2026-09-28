import { app, nativeImage, shell } from 'electron'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ImportChoice, ImportCounts, ImportPreview, ImportSource } from '@shared/types'
import { pageKey } from '@shared/links'
import { bookmarksChanged } from './broadcast'
import { arcTabs, chromiumTabs, firefoxTabs, safariTabs, type OpenTab } from './import-tabs'
import { parseBinaryPlist } from './plist'
import { store } from './store'

/**
 * Bookmarks, history and open tabs from the other browsers on this computer. Favorites here are a short list at
 * the top of the tabs, so only the bookmarks bar comes over (folders on it flattened); history comes over in full
 * up to the store's limit; open tabs come over asleep, like restored ones (see import-tabs.ts).
 */

type Kind = ImportSource['kind']

interface Found extends ImportSource {
  /** The profile's folder. For Safari, ~/Library/Safari. */
  dir: string
}

interface Page {
  url: string
  title: string
}

interface Visited extends Page {
  visitCount: number
  lastVisit: number
}

const FAVORITES_LIMIT = 16
const HISTORY_LIMIT = 10_000
const TABS_LIMIT = 100
const isWeb = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 4096

const home = app.getPath('home')
const isMac = process.platform === 'darwin'
const macSupport = join(home, 'Library', 'Application Support')
const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
const roamingAppData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')

/** Where each Chromium browser keeps its profiles. Opera keeps a single profile right in its folder. */
const CHROMIUM: { name: string; mac?: string; win?: string; single?: boolean }[] = [
  { name: 'Google Chrome', mac: 'Google/Chrome', win: 'Google/Chrome/User Data' },
  { name: 'Arc', mac: 'Arc/User Data' },
  { name: 'Dia', mac: 'Dia/User Data' },
  { name: 'Microsoft Edge', mac: 'Microsoft Edge', win: 'Microsoft/Edge/User Data' },
  { name: 'Brave', mac: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware/Brave-Browser/User Data' },
  { name: 'Vivaldi', mac: 'Vivaldi', win: 'Vivaldi/User Data' },
  { name: 'Opera', mac: 'com.operasoftware.Opera', win: 'Opera Software/Opera Stable', single: true },
  { name: 'Chromium', mac: 'Chromium', win: 'Chromium/User Data' }
]

const FIREFOX: { name: string; mac: string; win: string }[] = [
  { name: 'Firefox', mac: 'Firefox', win: 'Mozilla/Firefox' },
  { name: 'Zen', mac: 'zen', win: 'zen' }
]

/** Where each browser's app usually is, for its icon. Windows paths are under Program Files or LocalAppData. */
const APPS: Record<string, { mac: string[]; win: string[] }> = {
  'Google Chrome': { mac: ['Google Chrome.app'], win: ['Google/Chrome/Application/chrome.exe'] },
  Arc: { mac: ['Arc.app'], win: [] },
  Dia: { mac: ['Dia.app'], win: [] },
  'Microsoft Edge': { mac: ['Microsoft Edge.app'], win: ['Microsoft/Edge/Application/msedge.exe'] },
  Brave: { mac: ['Brave Browser.app'], win: ['BraveSoftware/Brave-Browser/Application/brave.exe'] },
  Vivaldi: { mac: ['Vivaldi.app'], win: ['Vivaldi/Application/vivaldi.exe'] },
  Opera: { mac: ['Opera.app'], win: ['Programs/Opera/opera.exe'] },
  Chromium: { mac: ['Chromium.app'], win: ['Chromium/Application/chrome.exe'] },
  Firefox: { mac: ['Firefox.app'], win: ['Mozilla Firefox/firefox.exe'] },
  Zen: { mac: ['Zen.app', 'Zen Browser.app'], win: ['Zen Browser/zen.exe'] },
  Safari: { mac: ['Safari.app'], win: [] }
}

async function appIcon(browser: string): Promise<string | null> {
  const names = isMac ? APPS[browser]?.mac : APPS[browser]?.win
  const roots = isMac
    ? ['/Applications', join(home, 'Applications')]
    : [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], localAppData].filter((r): r is string => !!r)
  const path = names?.flatMap((n) => roots.map((r) => join(r, n))).find((p) => existsSync(p))
  if (!path) return null
  try {
    // On macOS, app.getFileIcon crashed Electron 44 (SIGTRAP); Quick Look's thumbnail of the bundle is its icon.
    const icon = isMac ? await nativeImage.createThumbnailFromPath(path, { width: 64, height: 64 }) : await app.getFileIcon(path, { size: 'large' })
    return icon.isEmpty() ? null : icon.toDataURL()
  } catch {
    return null
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

type Scanned = Omit<Found, 'id' | 'icon'>

function chromiumSources(): Scanned[] {
  const found: Scanned[] = []
  for (const b of CHROMIUM) {
    const rel = isMac ? b.mac : process.platform === 'win32' ? b.win : undefined
    if (!rel) continue
    // Opera on Windows lives in Roaming; the rest in Local.
    const root = isMac ? join(macSupport, rel) : join(b.single ? roamingAppData : localAppData, rel)
    if (!existsSync(root)) continue
    const hasData = (dir: string): boolean => existsSync(join(dir, 'History')) || existsSync(join(dir, 'Bookmarks'))
    if (b.single) {
      if (hasData(root)) found.push({ kind: 'chromium', browser: b.name, profile: null, needsAccess: false, dir: root })
      continue
    }
    const state = readJson(join(root, 'Local State')) as { profile?: { info_cache?: Record<string, { name?: string }> } } | null
    const profiles = Object.entries(state?.profile?.info_cache ?? { Default: {} })
    const withData = profiles.filter(([dir]) => hasData(join(root, dir)))
    for (const [dir, info] of withData) {
      found.push({
        kind: 'chromium',
        browser: b.name,
        profile: withData.length > 1 ? info.name || dir : null,
        needsAccess: false,
        dir: join(root, dir)
      })
    }
  }
  return found
}

/** Profiles listed in profiles.ini that have a history database. */
function firefoxSources(): Scanned[] {
  const found: Scanned[] = []
  for (const b of FIREFOX) {
    const root = isMac ? join(macSupport, b.mac) : process.platform === 'win32' ? join(roamingAppData, b.win) : null
    if (!root) continue
    let ini: string
    try {
      ini = readFileSync(join(root, 'profiles.ini'), 'utf8')
    } catch {
      continue
    }
    const profiles: { name: string; dir: string }[] = []
    for (const section of ini.split(/^\[/m)) {
      if (!/^Profile/i.test(section)) continue
      const field = (key: string): string | undefined => section.match(new RegExp(`^${key}=(.*)$`, 'mi'))?.[1]?.trim()
      const path = field('Path')
      if (!path) continue
      const dir = field('IsRelative') === '0' || isAbsolute(path) ? path : join(root, path)
      if (existsSync(join(dir, 'places.sqlite'))) profiles.push({ name: field('Name') ?? path, dir })
    }
    for (const p of profiles) {
      found.push({ kind: 'firefox', browser: b.name, profile: profiles.length > 1 ? p.name : null, needsAccess: false, dir: p.dir })
    }
  }
  return found
}

/** Safari's folder is protected: reading it needs Full Disk Access. */
function safariSources(): Scanned[] {
  if (!isMac || !existsSync('/Applications/Safari.app')) return []
  const dir = join(home, 'Library', 'Safari')
  let needsAccess = false
  try {
    readdirSync(dir)
  } catch {
    needsAccess = true
  }
  return [{ kind: 'safari', browser: 'Safari', profile: null, needsAccess, dir }]
}

let sources = new Map<string, Found>()

export async function findImportSources(): Promise<ImportSource[]> {
  const list = [...chromiumSources(), ...firefoxSources(), ...safariSources()]
  const icons = new Map(await Promise.all([...new Set(list.map((s) => s.browser))].map(async (b) => [b, await appIcon(b)] as const)))
  sources = new Map(list.map((s, i) => [`${s.kind}:${i}`, { ...s, id: `${s.kind}:${i}`, icon: icons.get(s.browser) ?? null }]))
  return [...sources.values()].map(({ dir: _dir, ...source }) => source)
}

/** Opens System Settings at Full Disk Access, which Safari's data needs. */
export function openFullDiskAccessSettings(): void {
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
}

// ---- SQLite ----

/**
 * Runs a query on a copy of a browser's database: the browser may have it open and locked. The write-ahead log
 * comes along, or recent visits would be missing.
 */
async function queryCopy<T>(file: string, sql: string): Promise<T[]> {
  if (!existsSync(file)) return []
  const { DatabaseSync } = await import('node:sqlite')
  const tmp = mkdtempSync(join(tmpdir(), 'tabs-import-'))
  try {
    const copy = join(tmp, 'db')
    copyFileSync(file, copy)
    for (const suffix of ['-wal', '-journal']) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix)
    const db = new DatabaseSync(copy)
    try {
      return db.prepare(sql).all() as T[]
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- Chromium ----

interface ChromiumNode {
  type?: string
  name?: string
  url?: string
  children?: ChromiumNode[]
}

function flatten<T>(node: T | undefined, children: (n: T) => T[] | undefined, visit: (n: T) => Page | null, out: Page[] = []): Page[] {
  if (!node) return out
  const page = visit(node)
  if (page) out.push(page)
  for (const child of children(node) ?? []) flatten(child, children, visit, out)
  return out
}

function chromiumFavorites(dir: string): Page[] {
  const file = readJson(join(dir, 'Bookmarks')) as { roots?: { bookmark_bar?: ChromiumNode } } | null
  return flatten(
    file?.roots?.bookmark_bar,
    (n) => n.children,
    (n) => (n.type === 'url' && isWeb(n.url) ? { url: n.url, title: n.name ?? '' } : null)
  )
}

async function chromiumHistory(dir: string): Promise<Visited[]> {
  // Chromium counts microseconds from 1601, more than a JS number holds exactly (node:sqlite throws), so SQLite
  // turns it into milliseconds since 1970.
  const rows = await queryCopy<{ url: string; title: string; visit_count: number; t: number }>(
    join(dir, 'History'),
    `SELECT url, title, visit_count, last_visit_time / 1000 - 11644473600000 AS t FROM urls
     WHERE hidden = 0 AND visit_count > 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_LIMIT}`
  )
  return rows.map((r) => ({ url: r.url, title: r.title, visitCount: r.visit_count, lastVisit: r.t }))
}

// ---- Firefox ----

async function firefoxFavorites(dir: string): Promise<Page[]> {
  // Everything under the bookmarks toolbar, however deep; ordered by folder, then position.
  return queryCopy<Page>(
    join(dir, 'places.sqlite'),
    `WITH RECURSIVE bar(id, path) AS (
       SELECT id, '' FROM moz_bookmarks WHERE guid = 'toolbar_____'
       UNION ALL SELECT b.id, bar.path || printf('%06d.', b.position) FROM moz_bookmarks b JOIN bar ON b.parent = bar.id
     )
     SELECT p.url AS url, COALESCE(b.title, p.title, '') AS title
     FROM bar JOIN moz_bookmarks b ON b.id = bar.id JOIN moz_places p ON p.id = b.fk
     WHERE b.type = 1 ORDER BY bar.path`
  ).then((rows) => rows.filter((r) => isWeb(r.url)))
}

async function firefoxHistory(dir: string): Promise<Visited[]> {
  // Microseconds since 1970.
  const rows = await queryCopy<{ url: string; title: string | null; visit_count: number; t: number }>(
    join(dir, 'places.sqlite'),
    `SELECT url, title, visit_count, last_visit_date / 1000 AS t FROM moz_places
     WHERE hidden = 0 AND visit_count > 0 AND last_visit_date IS NOT NULL
     ORDER BY last_visit_date DESC LIMIT ${HISTORY_LIMIT}`
  )
  return rows.map((r) => ({ url: r.url, title: r.title ?? '', visitCount: r.visit_count, lastVisit: r.t }))
}

// ---- Safari ----

interface SafariNode {
  Title?: string
  WebBookmarkType?: string
  URLString?: string
  URIDictionary?: { title?: string }
  Children?: SafariNode[]
}

function safariFavorites(dir: string): Page[] {
  const root = parseBinaryPlist(readFileSync(join(dir, 'Bookmarks.plist'))) as SafariNode
  return flatten(
    root.Children?.find((c) => c.Title === 'BookmarksBar'),
    (n) => n.Children,
    (n) => (n.WebBookmarkType === 'WebBookmarkTypeLeaf' && isWeb(n.URLString) ? { url: n.URLString, title: n.URIDictionary?.title ?? '' } : null)
  )
}

/** Safari counts seconds from 2001. */
const fromSafariTime = (t: number): number => Math.round((t + 978_307_200) * 1000)

async function safariHistory(dir: string): Promise<Visited[]> {
  // The title of each page's latest visit (SQLite takes the other columns from the row MAX picks).
  const rows = await queryCopy<{ url: string; title: string | null; visit_count: number; t: number }>(
    join(dir, 'History.db'),
    `SELECT i.url AS url, v.title AS title, i.visit_count AS visit_count, MAX(v.visit_time) AS t
     FROM history_items i JOIN history_visits v ON v.history_item = i.id
     GROUP BY i.id ORDER BY t DESC LIMIT ${HISTORY_LIMIT}`
  )
  return rows.map((r) => ({ url: r.url, title: r.title ?? '', visitCount: r.visit_count, lastVisit: fromSafariTime(r.t) }))
}

// ---- Reading and importing ----

/** The bookmarks bar's pages that aren't favorites here yet (each once), and how many that was before the limit. */
async function readFavorites(s: Found): Promise<{ pages: Page[]; found: number }> {
  const pages = s.kind === 'chromium' ? chromiumFavorites(s.dir) : s.kind === 'firefox' ? await firefoxFavorites(s.dir) : safariFavorites(s.dir)
  const seen = new Set(store.bookmarks.map((b) => pageKey(b.url)))
  const fresh = pages.filter((p) => {
    const key = pageKey(p.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { pages: fresh.slice(0, FAVORITES_LIMIT), found: fresh.length }
}

async function readHistory(s: Found): Promise<Visited[]> {
  const read: Record<Kind, (dir: string) => Promise<Visited[]>> = { chromium: chromiumHistory, firefox: firefoxHistory, safari: safariHistory }
  return (await read[s.kind](s.dir)).filter((v) => isWeb(v.url) && Number.isFinite(v.lastVisit))
}

/** The other browser's open tabs, each page once, and how many that was before the limit. */
function readTabs(s: Found): { tabs: OpenTab[]; found: number } {
  const tabs = s.kind === 'firefox' ? firefoxTabs(s.dir) : s.kind === 'safari' ? safariTabs(s.dir) : s.browser === 'Arc' ? arcTabs(s.dir) : chromiumTabs(s.dir)
  const seen = new Set<string>()
  const unique = tabs.filter((t) => {
    const key = pageKey(t.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { tabs: unique.slice(0, TABS_LIMIT), found: unique.length }
}

const isDenied = (err: unknown): boolean => ['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException)?.code ?? '')

/** Reading can fail on its own (a missing file, a changed format); the other half still counts. Being denied access doesn't. */
async function attempt<T>(what: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isDenied(err)) throw err
    console.error(`[import] ${what}`, err)
    return fallback
  }
}

function sourceFor(id: unknown): Found {
  const s = typeof id === 'string' ? sources.get(id) : undefined
  if (!s) throw new Error('Unknown browser')
  return s
}

/** How much would come over from a browser, or null if the system won't let Tabs read it (Safari without Full Disk Access). */
export async function previewImport(id: unknown): Promise<ImportPreview | null> {
  const s = sourceFor(id)
  try {
    if (s.kind === 'safari') readdirSync(s.dir)
    const [favorites, history, tabs] = await Promise.all([
      attempt('favorites', () => readFavorites(s), { pages: [], found: 0 }),
      attempt('history', () => readHistory(s), []),
      attempt('tabs', () => readTabs(s), { tabs: [], found: 0 })
    ])
    return {
      favorites: favorites.pages.length,
      favoritesFound: favorites.found,
      history: history.length,
      tabs: tabs.tabs.length,
      tabsFound: tabs.found
    }
  } catch (err) {
    if (isDenied(err)) return null
    throw err
  }
}

/** Brings the chosen things over; `openTabs` opens tabs in the window importing and says how many it opened. Returns how many were added. */
export async function runImport(id: unknown, choice: ImportChoice, openTabs: (tabs: OpenTab[]) => number): Promise<ImportCounts> {
  const s = sourceFor(id)
  const counts: ImportCounts = { favorites: 0, history: 0, tabs: 0 }
  if (choice.favorites) {
    const { pages } = await attempt('favorites', () => readFavorites(s), { pages: [], found: 0 })
    counts.favorites = store.importBookmarks(pages)
    if (counts.favorites) bookmarksChanged()
  }
  if (choice.history) {
    counts.history = store.importHistory(await attempt('history', () => readHistory(s), []))
  }
  if (choice.tabs) {
    counts.tabs = openTabs((await attempt('tabs', () => readTabs(s), { tabs: [], found: 0 })).tabs)
  }
  return counts
}
