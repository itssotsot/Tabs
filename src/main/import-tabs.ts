import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseBinaryPlist } from './plist'

/**
 * The tabs another browser has open (or had open when it last quit), read from the file it restores them from.
 * Each browser has its own format: Chromium's command log (SNSS), Firefox's LZ4-compressed JSON, Arc's sidebar and
 * Safari's last-session property list. Tabs come back in window order, then tab order.
 */

export interface OpenTab {
  url: string
  title: string
  pinned: boolean
}

const isWeb = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 4096

/** The most recently written of these files, if any exist. */
function newest(files: string[]): string | null {
  let best: { file: string; time: number } | null = null
  for (const file of files) {
    try {
      const time = statSync(file).mtimeMs
      if (!best || time > best.time) best = { file, time }
    } catch {
      // Not there.
    }
  }
  return best?.file ?? null
}

// ---- Chromium ----

/** Command ids in Chromium's session files (components/sessions/core/session_service_commands.cc). */
const SET_TAB_WINDOW = 0
const SET_TAB_INDEX_IN_WINDOW = 2
const UPDATE_TAB_NAVIGATION = 6
const SET_SELECTED_NAVIGATION_INDEX = 7
const SET_PINNED_STATE = 12
const TAB_CLOSED = 16
const WINDOW_CLOSED = 17

interface ChromiumTab {
  window: number
  index: number
  pinned: boolean
  selected: number
  navigations: Map<number, { url: string; title: string }>
}

/** A navigation entry's pickle: a size, the tab and entry ids, then the URL (UTF-8) and title (UTF-16), each 4-byte aligned. */
function readNavigation(body: Buffer): { tab: number; index: number; url: string; title: string } | null {
  let p = 4
  const int = (): number => {
    if (p + 4 > body.length) throw new RangeError()
    const v = body.readInt32LE(p)
    p += 4
    return v
  }
  const bytes = (len: number): Buffer => {
    if (len < 0 || p + len > body.length) throw new RangeError()
    const b = body.subarray(p, p + len)
    p += (len + 3) & ~3
    return b
  }
  try {
    const tab = int()
    const index = int()
    const url = bytes(int()).toString('utf8')
    const title = bytes(int() * 2).toString('utf16le')
    return { tab, index, url, title }
  } catch {
    return null
  }
}

/**
 * Replays a session file: each command sets something about a tab or window, and later commands win. Tabs and
 * windows closed along the way are dropped.
 */
export function parseSnss(buf: Buffer): OpenTab[] {
  if (buf.toString('latin1', 0, 4) !== 'SNSS') throw new Error('Not a session file')
  // Versions 2 and 4 are encrypted.
  const version = buf.readInt32LE(4)
  if (version === 2 || version === 4) return []

  const tabs = new Map<number, ChromiumTab>()
  const closedWindows = new Set<number>()
  const tab = (id: number): ChromiumTab => {
    let t = tabs.get(id)
    if (!t) {
      t = { window: 0, index: 0, pinned: false, selected: -1, navigations: new Map() }
      tabs.set(id, t)
    }
    return t
  }

  let p = 8
  while (p + 2 <= buf.length) {
    const size = buf.readUInt16LE(p)
    p += 2
    // A command still being written when the file was copied.
    if (size === 0 || p + size > buf.length) break
    const id = buf[p]
    const body = buf.subarray(p + 1, p + size)
    p += size
    const ints = body.length >= 8
    switch (id) {
      case SET_TAB_WINDOW:
        if (ints) tab(body.readInt32LE(4)).window = body.readInt32LE(0)
        break
      case SET_TAB_INDEX_IN_WINDOW:
        if (ints) tab(body.readInt32LE(0)).index = body.readInt32LE(4)
        break
      case SET_SELECTED_NAVIGATION_INDEX:
        if (ints) tab(body.readInt32LE(0)).selected = body.readInt32LE(4)
        break
      case SET_PINNED_STATE:
        if (body.length >= 5) tab(body.readInt32LE(0)).pinned = body[4] !== 0
        break
      case UPDATE_TAB_NAVIGATION: {
        const nav = readNavigation(body)
        if (nav) tab(nav.tab).navigations.set(nav.index, { url: nav.url, title: nav.title })
        break
      }
      case TAB_CLOSED:
        if (body.length >= 4) tabs.delete(body.readInt32LE(0))
        break
      case WINDOW_CLOSED:
        if (body.length >= 4) closedWindows.add(body.readInt32LE(0))
        break
    }
  }

  const windowOrder: number[] = []
  const open: (ChromiumTab & { page: { url: string; title: string } })[] = []
  for (const t of tabs.values()) {
    if (closedWindows.has(t.window)) continue
    // The entry the tab was showing; without a selection, the latest one.
    const page = t.navigations.get(t.selected) ?? [...t.navigations.entries()].sort((a, b) => b[0] - a[0])[0]?.[1]
    if (!page || !isWeb(page.url)) continue
    if (!windowOrder.includes(t.window)) windowOrder.push(t.window)
    open.push({ ...t, page })
  }
  return open
    .sort((a, b) => windowOrder.indexOf(a.window) - windowOrder.indexOf(b.window) || a.index - b.index)
    .map((t) => ({ url: t.page.url, title: t.page.title, pinned: t.pinned }))
}

/** Newer Chromium keeps a series of Sessions/Session_<time> files; older versions a single "Current Session". */
export function chromiumTabs(dir: string): OpenTab[] {
  const sessions = join(dir, 'Sessions')
  let files: string[] = []
  try {
    files = readdirSync(sessions)
      .filter((f) => f.startsWith('Session_'))
      .map((f) => join(sessions, f))
  } catch {
    // No Sessions folder.
  }
  const file = newest(files.length ? files : [join(dir, 'Current Session')])
  return file ? parseSnss(readFileSync(file)) : []
}

// ---- Arc ----

interface ArcItem {
  id: string
  childrenIds?: string[]
  data?: { tab?: { savedURL?: string; savedTitle?: string } }
}

interface ArcSpace {
  containerIDs?: unknown[]
  profile?: { custom?: { _0?: { directoryBasename?: string } } }
}

/**
 * Arc keeps its sidebar in StorableSidebar.json, next to "User Data". Open tabs are the unpinned ("Today") ones in
 * each space of this profile; pinned ones are more like bookmarks and come over with the bookmarks bar.
 */
export function arcTabs(profileDir: string): OpenTab[] {
  const file = join(dirname(dirname(profileDir)), 'StorableSidebar.json')
  if (!existsSync(file)) return []
  const data = JSON.parse(readFileSync(file, 'utf8')) as { sidebar?: { containers?: { items?: unknown[]; spaces?: unknown[] }[] } }
  const container = data.sidebar?.containers?.find((c) => Array.isArray(c.spaces))
  if (!container) return []
  const items = new Map<string, ArcItem>()
  for (const item of container.items ?? []) {
    if (item && typeof item === 'object' && typeof (item as ArcItem).id === 'string') items.set((item as ArcItem).id, item as ArcItem)
  }

  const profile = basename(profileDir)
  const out: OpenTab[] = []
  const collect = (id: string, depth: number): void => {
    if (depth > 20) return
    for (const child of items.get(id)?.childrenIds ?? []) {
      const tab = items.get(child)?.data?.tab
      if (tab && isWeb(tab.savedURL)) out.push({ url: tab.savedURL, title: tab.savedTitle ?? '', pinned: false })
      collect(child, depth + 1)
    }
  }
  for (const space of (container.spaces ?? []) as ArcSpace[]) {
    if (!space || typeof space !== 'object' || !Array.isArray(space.containerIDs)) continue
    if ((space.profile?.custom?._0?.directoryBasename ?? 'Default') !== profile) continue
    // Pairs of a label and a container: ['pinned', id, 'unpinned', id].
    const ids = space.containerIDs
    for (let i = 0; i + 1 < ids.length; i += 2) {
      if (ids[i] === 'unpinned' && typeof ids[i + 1] === 'string') collect(ids[i + 1] as string, 0)
    }
  }
  return out
}

// ---- Firefox ----

/** Decompresses one LZ4 block (the format inside Firefox's .jsonlz4 files). */
export function lz4Block(src: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size)
  let i = 0
  let o = 0
  const length = (n: number): number => {
    if (n !== 15) return n
    let b: number
    do {
      b = src[i++]
      n += b
    } while (b === 255 && i < src.length)
    return n
  }
  while (i < src.length) {
    const token = src[i++]
    const literals = length(token >> 4)
    if (i + literals > src.length || o + literals > size) throw new Error('Bad LZ4 data')
    src.copy(out, o, i, i + literals)
    i += literals
    o += literals
    // The last sequence has only literals.
    if (i >= src.length) break
    const offset = src[i] | (src[i + 1] << 8)
    i += 2
    const match = length(token & 15) + 4
    if (offset === 0 || offset > o || o + match > size) throw new Error('Bad LZ4 data')
    // Byte by byte: the match may overlap what it's copying.
    for (let k = 0; k < match; k++) out[o + k] = out[o - offset + k]
    o += match
  }
  return out.subarray(0, o)
}

/** Firefox's "mozLz40\0" files: the magic, the decompressed size, then one LZ4 block. */
export function readMozLz4(buf: Buffer): string {
  if (buf.toString('latin1', 0, 8) !== 'mozLz40\0') throw new Error('Not a mozLz4 file')
  return lz4Block(buf.subarray(12), buf.readUInt32LE(8)).toString('utf8')
}

interface FirefoxSession {
  windows?: { tabs?: { entries?: { url?: string; title?: string }[]; index?: number; pinned?: boolean }[] }[]
}

/** The session Firefox (or Zen) would restore: recovery.jsonlz4 while it runs, sessionstore.jsonlz4 after it quits. */
export function firefoxTabs(dir: string): OpenTab[] {
  const file = newest([join(dir, 'sessionstore-backups', 'recovery.jsonlz4'), join(dir, 'sessionstore.jsonlz4')])
  if (!file) return []
  const session = JSON.parse(readMozLz4(readFileSync(file))) as FirefoxSession
  const out: OpenTab[] = []
  for (const w of session.windows ?? []) {
    for (const t of w.tabs ?? []) {
      const entries = t.entries ?? []
      // `index` is 1-based and points at the entry the tab shows.
      const entry = entries[Math.min(Math.max((t.index ?? entries.length) - 1, 0), entries.length - 1)]
      if (entry && isWeb(entry.url)) out.push({ url: entry.url, title: entry.title ?? '', pinned: t.pinned === true })
    }
  }
  return out
}

// ---- Safari ----

interface SafariSession {
  SessionWindows?: { TabStates?: { TabURL?: string; TabTitle?: string }[] }[]
}

/** Safari's windows from when it last quit (or last saved), in ~/Library/Safari/LastSession.plist. */
export function safariTabs(dir: string): OpenTab[] {
  const file = join(dir, 'LastSession.plist')
  if (!existsSync(file)) return []
  const session = parseBinaryPlist(readFileSync(file)) as SafariSession
  return (session.SessionWindows ?? []).flatMap((w) =>
    (w.TabStates ?? []).filter((t) => isWeb(t.TabURL)).map((t) => ({ url: t.TabURL!, title: t.TabTitle ?? '', pinned: false }))
  )
}
