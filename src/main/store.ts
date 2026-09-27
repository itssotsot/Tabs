import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAB_LAYOUTS } from '@shared/constants'
import type { Bookmark, HistoryEntry, Settings, TabLink } from '@shared/types'

/** History and bookmark changes, for code that follows along (the Chrome extension APIs). */
interface StoreEventMap {
  /** A page was visited (after the entry was updated). */
  'history-visit': [entry: HistoryEntry]
  /** Entries left history: these URLs, or everything. */
  'history-removed': [removed: { urls: string[]; all: boolean }]
  /** The bookmark list changed in any way (added, removed, renamed, moved). */
  'bookmarks-changed': []
}

export const storeEvents = new EventEmitter<StoreEventMap>()
storeEvents.setMaxListeners(50)

/** A JSON file loaded once at startup and written back shortly after each change. */
export class JsonFile<T> {
  private readonly path: string
  private timer: NodeJS.Timeout | null = null
  data: T

  constructor(name: string, fallback: T) {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${name}.json`)
    try {
      this.data = { ...fallback, ...JSON.parse(readFileSync(this.path, 'utf8')) }
    } catch {
      this.data = fallback
    }
  }

  save(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 500)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.path)
  }
}

const HISTORY_LIMIT = 10_000

export interface SavedTab {
  url: string
  pinned: boolean
  title?: string
  favicon?: string | null
  /** Back/forward list (without page state), so history survives a restart. */
  entries?: { url: string; title: string }[]
  index?: number
  fromLink?: TabLink
  createdAt?: number
  /** Another site's group the tab was dragged into. */
  joinedGroup?: string
}

/** Page host -> origins its pages load from -> how often. Used to preconnect. */
export type PredictorData = Record<string, { seen: number; origins: Record<string, number> }>

export interface SavedWindow {
  bounds: { x: number; y: number; width: number; height: number } | null
  maximized: boolean
  tabs: SavedTab[]
  activeIndex: number
}

type PermissionDecision = 'allow' | 'deny'

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  adblock: true,
  notifications: true,
  restoreSession: true,
  memorySaver: true,
  tabLayout: 'vertical',
  groupTabsBySite: true,
  ungroupedSites: []
}

/** Site names learned from pages; the oldest go first past this. */
const SITE_NAMES_LIMIT = 500

class Stores {
  private history!: JsonFile<{ entries: Record<string, HistoryEntry> }>
  private bookmarksFile!: JsonFile<{ items: Bookmark[] }>
  private settingsFile!: JsonFile<Settings>
  private sessionFile!: JsonFile<{ windows: SavedWindow[] }>
  private permissionsFile!: JsonFile<{ sites: Record<string, Record<string, PermissionDecision>> }>
  private predictorFile!: JsonFile<{ hosts: PredictorData }>
  private sitesFile!: JsonFile<{ names: Record<string, string>; colors: Record<string, string> }>
  private extensionsFile!: JsonFile<{ disabled: string[] }>

  /** Must run after `app.whenReady()` so userData is final. */
  init(): void {
    this.history = new JsonFile('history', { entries: {} })
    this.bookmarksFile = new JsonFile('bookmarks', { items: [] })
    this.settingsFile = new JsonFile('settings', DEFAULT_SETTINGS)
    // Settings saved with a layout that's since been removed.
    if (!TAB_LAYOUTS.some((l) => l.id === this.settingsFile.data.tabLayout)) this.settingsFile.data.tabLayout = DEFAULT_SETTINGS.tabLayout
    this.sessionFile = new JsonFile('session', { windows: [] })
    this.permissionsFile = new JsonFile('permissions', { sites: {} })
    this.predictorFile = new JsonFile('predictor', { hosts: {} })
    this.sitesFile = new JsonFile('sites', { names: {}, colors: {} })
    this.extensionsFile = new JsonFile('extensions', { disabled: [] })
  }

  flushAll(): void {
    for (const f of [this.history, this.bookmarksFile, this.settingsFile, this.sessionFile, this.permissionsFile, this.predictorFile, this.sitesFile, this.extensionsFile]) {
      f.flush()
    }
  }

  // History

  recordVisit(url: string, title: string): void {
    if (!/^https?:/.test(url)) return
    const entries = this.history.data.entries
    const existing = entries[url]
    entries[url] = {
      url,
      title: title || existing?.title || url,
      visitCount: (existing?.visitCount ?? 0) + 1,
      lastVisit: Date.now()
    }
    this.pruneHistory()
    this.history.save()
    storeEvents.emit('history-visit', entries[url])
  }

  updateTitle(url: string, title: string): void {
    const entry = this.history.data.entries[url]
    if (entry && title && entry.title !== title) {
      entry.title = title
      this.history.save()
    }
  }

  private pruneHistory(): void {
    const entries = this.history.data.entries
    const keys = Object.keys(entries)
    if (keys.length <= HISTORY_LIMIT) return
    const expired = keys.sort((a, b) => entries[a].lastVisit - entries[b].lastVisit).slice(0, keys.length - HISTORY_LIMIT)
    expired.forEach((k) => delete entries[k])
    storeEvents.emit('history-removed', { urls: expired, all: false })
  }

  searchHistory(query: string, limit: number): HistoryEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    return Object.values(this.history.data.entries)
      .filter((e) => {
        const hay = `${e.url} ${e.title}`.toLowerCase()
        return tokens.every((t) => hay.includes(t))
      })
      .sort((a, b) => b.lastVisit - a.lastVisit)
      .slice(0, limit)
  }

  /** Ranked matches for the address bar. */
  matchHistory(query: string, limit: number): HistoryEntry[] {
    const q = query.toLowerCase().trim()
    if (!q) return []
    const now = Date.now()
    const scored: { entry: HistoryEntry; score: number }[] = []
    for (const entry of Object.values(this.history.data.entries)) {
      const url = entry.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
      const title = entry.title.toLowerCase()
      let score = 0
      if (url.startsWith(q)) score += 100
      else if (url.includes(q)) score += 30
      if (title.includes(q)) score += 20
      if (!score) continue
      const ageDays = (now - entry.lastVisit) / 86_400_000
      score += Math.min(entry.visitCount, 50) * 2 - Math.min(ageDays, 60) / 2
      // Prefer short, top-level URLs such as "youtube.com" over deep links.
      score -= url.length / 20
      scored.push({ entry, score })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry)
  }

  topSites(limit = 8): HistoryEntry[] {
    const byHost = new Map<string, HistoryEntry>()
    for (const e of Object.values(this.history.data.entries)) {
      let host: string
      try {
        host = new URL(e.url).host
      } catch {
        continue
      }
      const prev = byHost.get(host)
      if (!prev || e.visitCount > prev.visitCount) {
        byHost.set(host, { ...e, visitCount: (prev?.visitCount ?? 0) + e.visitCount })
      } else {
        prev.visitCount += e.visitCount
      }
    }
    return [...byHost.values()].sort((a, b) => b.visitCount - a.visitCount).slice(0, limit)
  }

  /** Every history entry, in no particular order. */
  historyEntries(): HistoryEntry[] {
    return Object.values(this.history.data.entries)
  }

  historyEntry(url: string): HistoryEntry | undefined {
    return this.history.data.entries[url]
  }

  removeHistory(url: string): void {
    const existed = url in this.history.data.entries
    delete this.history.data.entries[url]
    this.history.save()
    if (existed) storeEvents.emit('history-removed', { urls: [url], all: false })
  }

  clearHistory(): void {
    this.history.data.entries = {}
    this.history.save()
    storeEvents.emit('history-removed', { urls: [], all: true })
    this.predictorFile.data.hosts = {}
    this.predictorFile.save()
    this.sitesFile.data.names = {}
    this.sitesFile.save()
  }

  // Bookmarks

  get bookmarks(): Bookmark[] {
    return this.bookmarksFile.data.items
  }

  findBookmark(url: string): Bookmark | undefined {
    return this.bookmarks.find((b) => b.url === url)
  }

  /** Adds at the end, or at `index`. */
  addBookmark(url: string, title: string, index?: number): Bookmark {
    const bookmark = { id: randomUUID(), url, title: title || url, createdAt: Date.now() }
    const items = [...this.bookmarks]
    items.splice(index === undefined ? items.length : Math.max(0, Math.min(index, items.length)), 0, bookmark)
    this.bookmarksFile.data.items = items
    this.bookmarksFile.save()
    storeEvents.emit('bookmarks-changed')
    return bookmark
  }

  removeBookmark(id: string): void {
    this.bookmarksFile.data.items = this.bookmarks.filter((b) => b.id !== id)
    this.bookmarksFile.save()
    storeEvents.emit('bookmarks-changed')
  }

  renameBookmark(id: string, title: string): void {
    this.updateBookmark(id, { title })
  }

  updateBookmark(id: string, patch: { title?: string; url?: string }): void {
    this.bookmarksFile.data.items = this.bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b))
    this.bookmarksFile.save()
    storeEvents.emit('bookmarks-changed')
  }

  /** Moves a bookmark to `index` in the list as it is after taking the bookmark out. */
  moveBookmark(id: string, index: number): void {
    const items = [...this.bookmarks]
    const from = items.findIndex((b) => b.id === id)
    if (from === -1) return
    const [bookmark] = items.splice(from, 1)
    items.splice(Math.max(0, Math.min(index, items.length)), 0, bookmark)
    this.bookmarksFile.data.items = items
    this.bookmarksFile.save()
    storeEvents.emit('bookmarks-changed')
  }

  // Settings

  get settings(): Settings {
    return this.settingsFile.data
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settingsFile.data = { ...this.settingsFile.data, ...patch }
    this.settingsFile.save()
    return this.settingsFile.data
  }

  // Extensions

  /** IDs of installed extensions that are turned off. */
  get disabledExtensions(): string[] {
    return this.extensionsFile.data.disabled
  }

  setDisabledExtensions(ids: string[]): void {
    this.extensionsFile.data.disabled = [...new Set(ids)]
    this.extensionsFile.save()
  }

  // Session

  get savedWindows(): SavedWindow[] {
    return this.sessionFile.data.windows
  }

  saveSession(windows: SavedWindow[]): void {
    this.sessionFile.data.windows = windows
    this.sessionFile.save()
  }

  // Loading predictor

  get predictor(): PredictorData {
    return this.predictorFile.data.hosts
  }

  savePredictor(): void {
    this.predictorFile.save()
  }

  // Site names (for tab groups)

  siteName(site: string): string | undefined {
    return this.sitesFile.data.names[site]
  }

  setSiteName(site: string, name: string): void {
    const names = this.sitesFile.data.names
    delete names[site]
    names[site] = name
    const keys = Object.keys(names)
    for (const key of keys.slice(0, Math.max(0, keys.length - SITE_NAMES_LIMIT))) delete names[key]
    this.sitesFile.save()
  }

  // Site colors (picked for tab groups; kept when history is cleared)

  siteColor(site: string): string | undefined {
    return this.sitesFile.data.colors[site]
  }

  /** Null goes back to the automatic color. */
  setSiteColor(site: string, color: string | null): void {
    if (color) this.sitesFile.data.colors[site] = color
    else delete this.sitesFile.data.colors[site]
    this.sitesFile.save()
  }

  // Site permissions

  getPermission(origin: string, permission: string): PermissionDecision | undefined {
    return this.permissionsFile.data.sites[origin]?.[permission]
  }

  setPermission(origin: string, permission: string, decision: PermissionDecision): void {
    const sites = this.permissionsFile.data.sites
    sites[origin] = { ...sites[origin], [permission]: decision }
    this.permissionsFile.save()
  }

  sitePermissions(origin: string): Record<string, PermissionDecision> {
    return this.permissionsFile.data.sites[origin] ?? {}
  }

  clearSitePermissions(origin?: string): void {
    if (origin) delete this.permissionsFile.data.sites[origin]
    else this.permissionsFile.data.sites = {}
    this.permissionsFile.save()
  }
}

export const store = new Stores()
