import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TAB_LAYOUTS, THEMES } from '@shared/constants'
import type { Bookmark, HistoryEntry, PermissionDecision, Settings, SiteAccess, SitePermission, TabLink } from '@shared/types'

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
  /** False when there was no file yet (or it couldn't be read). */
  readonly loaded: boolean

  constructor(name: string, fallback: T) {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${name}.json`)
    try {
      this.data = { ...fallback, ...JSON.parse(readFileSync(this.path, 'utf8')) }
      this.loaded = true
    } catch {
      this.data = fallback
      this.loaded = false
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

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  theme: 'default',
  adblock: true,
  notifications: true,
  restoreSession: true,
  memorySaver: true,
  tabLayout: 'vertical',
  groupTabsBySite: true,
  ungroupedSites: [],
  showTabAge: false,
  showGroupLines: false,
  blockedPermissions: [],
  devices: { camera: null, microphone: null, speaker: null }
}

/** Site names learned from pages; the oldest go first past this. */
const SITE_NAMES_LIMIT = 500

class Stores {
  private history!: JsonFile<{ entries: Record<string, HistoryEntry> }>
  private bookmarksFile!: JsonFile<{ items: Bookmark[] }>
  private settingsFile!: JsonFile<Settings>
  private sessionFile!: JsonFile<{ windows: SavedWindow[] }>
  private permissionsFile!: JsonFile<{ sites: Record<string, Partial<Record<SitePermission, PermissionDecision>>> }>
  private predictorFile!: JsonFile<{ hosts: PredictorData }>
  private sitesFile!: JsonFile<{ names: Record<string, string>; colors: Record<string, string> }>
  private extensionsFile!: JsonFile<{ disabled: string[] }>
  private introFile!: JsonFile<{ done: boolean }>

  /** Must run after `app.whenReady()` so userData is final. */
  init(): void {
    this.history = new JsonFile('history', { entries: {} })
    this.bookmarksFile = new JsonFile('bookmarks', { items: [] })
    this.settingsFile = new JsonFile('settings', DEFAULT_SETTINGS)
    // Settings saved with a layout that's since been removed.
    if (!TAB_LAYOUTS.some((l) => l.id === this.settingsFile.data.tabLayout)) this.settingsFile.data.tabLayout = DEFAULT_SETTINGS.tabLayout
    if (!THEMES.some((t) => t.id === this.settingsFile.data.theme)) this.settingsFile.data.theme = DEFAULT_SETTINGS.theme
    this.sessionFile = new JsonFile('session', { windows: [] })
    this.permissionsFile = new JsonFile('permissions', { sites: {} })
    this.splitMediaPermissions()
    this.predictorFile = new JsonFile('predictor', { hosts: {} })
    this.sitesFile = new JsonFile('sites', { names: {}, colors: {} })
    this.extensionsFile = new JsonFile('extensions', { disabled: [] })
    this.introFile = new JsonFile('intro', { done: false })
    if (!this.introFile.loaded) {
      // Copies set up before the intro existed have settings already; they skip it. Saving now means
      // settings changed during the intro can't make it look like one of those next time.
      this.introFile.data.done = this.settingsFile.loaded
      this.introFile.save()
    }
  }

  flushAll(): void {
    for (const f of [this.history, this.bookmarksFile, this.settingsFile, this.sessionFile, this.permissionsFile, this.predictorFile, this.sitesFile, this.extensionsFile, this.introFile]) {
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

  /** Merges visits from another browser: counts add up and the latest visit wins. Returns how many pages were new. */
  importHistory(visits: HistoryEntry[]): number {
    const entries = this.history.data.entries
    let added = 0
    for (const v of visits) {
      const existing = entries[v.url]
      if (!existing) added++
      entries[v.url] = {
        url: v.url,
        title: existing?.title || v.title || v.url,
        visitCount: (existing?.visitCount ?? 0) + Math.max(1, v.visitCount),
        lastVisit: Math.max(existing?.lastVisit ?? 0, v.lastVisit)
      }
    }
    this.pruneHistory()
    this.history.save()
    return added
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

  /** Adds pages at the end as one change. Returns how many were added. */
  importBookmarks(pages: { url: string; title: string }[]): number {
    const now = Date.now()
    const added = pages.map((p, i) => ({ id: randomUUID(), url: p.url, title: p.title || p.url, createdAt: now + i }))
    if (!added.length) return 0
    this.bookmarksFile.data.items = [...this.bookmarks, ...added]
    this.bookmarksFile.save()
    storeEvents.emit('bookmarks-changed')
    return added.length
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

  // First-run intro

  get introDone(): boolean {
    return this.introFile.data.done
  }

  finishIntro(): void {
    this.introFile.data.done = true
    this.introFile.save()
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

  /** Early builds stored the camera and microphone as one choice, "media"; it stands for both. */
  private splitMediaPermissions(): void {
    const sites = this.permissionsFile.data.sites as Record<string, Record<string, PermissionDecision>>
    let changed = false
    for (const choices of Object.values(sites)) {
      const media = choices.media
      if (!media) continue
      choices.camera ??= media
      choices.microphone ??= media
      delete choices.media
      changed = true
    }
    if (changed) this.permissionsFile.save()
  }

  getPermission(origin: string, permission: SitePermission): PermissionDecision | undefined {
    return this.permissionsFile.data.sites[origin]?.[permission]
  }

  /** Null forgets the site's choice, so it's asked again. */
  setPermission(origin: string, permission: SitePermission, decision: PermissionDecision | null): void {
    const sites = this.permissionsFile.data.sites
    const choices = { ...sites[origin] }
    if (decision) choices[permission] = decision
    else delete choices[permission]
    if (Object.keys(choices).length) sites[origin] = choices
    else delete sites[origin]
    this.permissionsFile.save()
  }

  sitePermissions(origin: string): Partial<Record<SitePermission, PermissionDecision>> {
    return this.permissionsFile.data.sites[origin] ?? {}
  }

  /** Every site with a saved choice, by address. */
  siteAccess(): SiteAccess[] {
    return Object.entries(this.permissionsFile.data.sites)
      .map(([origin, permissions]) => ({ origin, permissions }))
      .sort((a, b) => a.origin.replace(/^https?:\/\//, '').localeCompare(b.origin.replace(/^https?:\/\//, '')))
  }

  clearSitePermissions(origin?: string): void {
    if (origin) delete this.permissionsFile.data.sites[origin]
    else this.permissionsFile.data.sites = {}
    this.permissionsFile.save()
  }
}

export const store = new Stores()
