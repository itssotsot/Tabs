import { app, nativeImage, shell, type DownloadItem } from 'electron'
import { existsSync, unlinkSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, sep } from 'node:path'
import { webSession } from '../../../env'
import {
  downloadAction,
  downloadEntry,
  downloadEvents,
  listDownloads,
  retargetDownload,
  setDownloadPlanner,
  type DownloadPlan
} from '../../../downloads'
import { hasApiPermission } from '../../access'
import { defineApi, defineEvent, emit, emitForResponse, ExtensionError, listeningExtensions, type CallContext } from '../../router'
import { extensionName, isNumber, isObject, isString, toMillis } from './util'

/**
 * chrome.downloads, on top of the app's download tracking (src/main/downloads.ts): downloads started
 * by pages and by extensions go through the same session 'will-download' handler and show up in the
 * downloads panel alike. Chrome's integer ids are the app's download ids as numbers.
 */

type Item = chrome.downloads.DownloadItem

/** What the app's download list doesn't keep. */
interface Extra {
  url: string
  finalUrl: string
  mime: string
  byExtensionId?: string
  byExtensionName?: string
  endTime?: number
  /** A save dialog decides the name, so onDeterminingFilename is skipped. */
  saveAs: boolean
}

interface Request {
  extensionId: string
  url: string
  path?: string
  saveAs: boolean
  conflictAction: string
  resolve: (id: number) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const extras = new Map<string, Extra>()
/** Last DownloadItem each download was reported as, for onChanged's deltas. */
const reported = new Map<string, Item>()
/** Downloads extensions asked for that haven't started yet. */
const requests: Request[] = []
/** Set by the planner and picked up by the 'created' event, which follow each other in one handler. */
let planned: Request | null = null
let uiEnabled = true

const DELTA_KEYS = [
  'url',
  'finalUrl',
  'filename',
  'danger',
  'mime',
  'startTime',
  'endTime',
  'state',
  'canResume',
  'paused',
  'error',
  'totalBytes',
  'fileSize',
  'exists'
] as const

const downloadsDir = (): string => app.getPath('downloads')

/** "file.zip" -> "file (1).zip" when the name is taken. */
function uniquePath(path: string): string {
  const ext = extname(path)
  const base = path.slice(0, path.length - ext.length)
  let candidate = path
  for (let i = 1; existsSync(candidate); i++) candidate = `${base} (${i})${ext}`
  return candidate
}

/** A suggested filename: relative to the Downloads folder, no "..", no absolute paths. Null if invalid. */
function safeRelative(filename: unknown): string | null {
  if (typeof filename !== 'string' || !filename.trim()) return null
  if (isAbsolute(filename) || /^[a-z]:/i.test(filename) || filename.startsWith('~')) return null
  const parts = filename.split(/[\\/]+/)
  if (parts.some((p) => p === '..' || p === '.' || /[<>:"|?*\u0000-\u001f]/.test(p))) return null
  if (parts.at(-1) === '') return null
  const full = normalize(join(downloadsDir(), ...parts))
  return full.startsWith(downloadsDir() + sep) ? full : null
}

function targetFor(path: string, conflictAction: unknown): string {
  return conflictAction === 'overwrite' ? path : uniquePath(path)
}

// ---- items ----

function toItem(id: string): Item | null {
  const entry = downloadEntry(id)
  if (!entry) return null
  const { state, item } = entry
  const extra = extras.get(id)
  const chromeState = state.state === 'progressing' ? 'in_progress' : state.state === 'completed' ? 'complete' : 'interrupted'
  const complete = chromeState === 'complete'
  const out: Item = {
    id: Number(id),
    url: extra?.url ?? state.url,
    finalUrl: extra?.finalUrl ?? state.url,
    referrer: '',
    filename: state.path,
    incognito: false,
    danger: 'safe' as Item['danger'],
    mime: extra?.mime ?? '',
    startTime: new Date(state.startTime).toISOString(),
    state: chromeState as Item['state'],
    paused: state.paused,
    canResume: !!item && state.state !== 'completed' && item.canResume(),
    bytesReceived: state.receivedBytes,
    totalBytes: complete ? state.receivedBytes : state.totalBytes > 0 ? state.totalBytes : -1,
    fileSize: complete ? state.receivedBytes : state.totalBytes > 0 ? state.totalBytes : -1,
    exists: complete ? existsSync(state.path) : chromeState === 'in_progress'
  }
  if (extra?.endTime !== undefined) out.endTime = new Date(extra.endTime).toISOString()
  if (state.state === 'cancelled') out.error = 'USER_CANCELED' as Item['error']
  else if (state.state === 'interrupted') out.error = 'NETWORK_FAILED' as Item['error']
  if (chromeState === 'in_progress' && item && !state.paused && state.totalBytes > 0) {
    const speed = item.getCurrentBytesPerSecond()
    if (speed > 0) out.estimatedEndTime = new Date(Date.now() + ((state.totalBytes - state.receivedBytes) / speed) * 1000).toISOString()
  }
  if (extra?.byExtensionId) {
    out.byExtensionId = extra.byExtensionId
    out.byExtensionName = extra.byExtensionName
  }
  return out
}

function allItems(): Item[] {
  return listDownloads()
    .map((d) => toItem(d.id))
    .filter((i): i is Item => !!i)
}

function requireItem(downloadId: unknown): Item {
  const item = isNumber(downloadId) ? toItem(String(downloadId)) : null
  if (!item) throw new ExtensionError('Invalid downloadId')
  return item
}

// ---- search ----

function regex(value: unknown, name: string): RegExp | null {
  if (value === undefined) return null
  try {
    return new RegExp(String(value))
  } catch {
    throw new ExtensionError(`Invalid ${name}`)
  }
}

function compareBy(keys: string[]): (a: Item, b: Item) => number {
  return (a, b) => {
    for (const raw of keys) {
      const desc = raw.startsWith('-')
      const key = (desc ? raw.slice(1) : raw) as keyof Item
      const x = a[key] as unknown
      const y = b[key] as unknown
      if (x === y) continue
      if (x === undefined) return 1
      if (y === undefined) return -1
      const d = (x as number | string | boolean) < (y as number | string | boolean) ? -1 : 1
      return desc ? -d : d
    }
    return 0
  }
}

/** Every downloads.DownloadQuery field Chrome documents. */
export function searchDownloads(queryInfo: unknown): Item[] {
  const q = isObject(queryInfo) ? queryInfo : {}
  const terms = (Array.isArray(q.query) ? q.query : []).filter(isString).map((t) => t.toLowerCase())
  const filenameRe = regex(q.filenameRegex, 'filenameRegex')
  const urlRe = regex(q.urlRegex, 'urlRegex')
  const finalUrlRe = regex(q.finalUrlRegex, 'finalUrlRegex')
  const time = (key: string): number => (q[key] === undefined ? NaN : toMillis(q[key]))
  const startedBefore = time('startedBefore')
  const startedAfter = time('startedAfter')
  const endedBefore = time('endedBefore')
  const endedAfter = time('endedAfter')
  const exact = ['id', 'url', 'finalUrl', 'filename', 'danger', 'mime', 'state', 'paused', 'error', 'bytesReceived', 'totalBytes', 'fileSize', 'exists'] as const

  let items = allItems().filter((item) => {
    for (const key of exact) if (q[key] !== undefined && q[key] !== item[key]) return false
    const start = Date.parse(item.startTime)
    const end = item.endTime ? Date.parse(item.endTime) : NaN
    if (q.startTime !== undefined && toMillis(q.startTime) !== start) return false
    if (q.endTime !== undefined && toMillis(q.endTime) !== end) return false
    if (!Number.isNaN(startedBefore) && !(start < startedBefore)) return false
    if (!Number.isNaN(startedAfter) && !(start > startedAfter)) return false
    if (!Number.isNaN(endedBefore) && !(end < endedBefore)) return false
    if (!Number.isNaN(endedAfter) && !(end > endedAfter)) return false
    if (isNumber(q.totalBytesGreater) && !(item.totalBytes > q.totalBytesGreater)) return false
    if (isNumber(q.totalBytesLess) && !(item.totalBytes < q.totalBytesLess)) return false
    if (filenameRe && !filenameRe.test(item.filename)) return false
    if (urlRe && !urlRe.test(item.url)) return false
    if (finalUrlRe && !finalUrlRe.test(item.finalUrl)) return false
    if (terms.length) {
      const hay = `${item.filename} ${item.url} ${item.finalUrl}`.toLowerCase()
      for (const term of terms) {
        if (term.startsWith('-') && term.length > 1 ? hay.includes(term.slice(1)) : !hay.includes(term)) return false
      }
    }
    return true
  })
  const orderBy = (Array.isArray(q.orderBy) ? q.orderBy : ['-startTime']).filter(isString)
  if (orderBy.length) items = items.sort(compareBy(orderBy))
  const limit = isNumber(q.limit) ? q.limit : 1000
  if (limit < 0) throw new ExtensionError('Invalid query filter')
  return limit === 0 ? items : items.slice(0, limit)
}

// ---- starting downloads ----

function planFor(item: DownloadItem): DownloadPlan | null {
  const chain = item.getURLChain()
  const urls = new Set([chain[0], item.getURL()].filter(Boolean))
  const index = requests.findIndex((r) => urls.has(r.url))
  if (index === -1) return null
  const [request] = requests.splice(index, 1)
  clearTimeout(request.timer)
  planned = request
  if (request.saveAs || request.conflictAction === 'prompt') {
    return { path: request.path ?? join(downloadsDir(), item.getFilename()), saveAs: true }
  }
  return request.path ? { path: targetFor(request.path, request.conflictAction) } : null
}

async function download(call: CallContext, options: unknown): Promise<number> {
  const o = isObject(options) ? options : {}
  const url = isString(o.url) ? o.url : ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ExtensionError('Invalid URL')
  }
  // No file: URLs: Chrome needs "Allow access to file URLs" for those, and we have no such switch.
  if (!/^(https?|ftp|data|blob|chrome-extension):$/.test(parsed.protocol)) throw new ExtensionError('Invalid URL')
  if (parsed.protocol === 'chrome-extension:' && parsed.host !== call.extensionId) throw new ExtensionError('Invalid URL')
  let path: string | undefined
  if (o.filename !== undefined) {
    const safe = safeRelative(o.filename)
    if (!safe) throw new ExtensionError('Invalid filename')
    path = safe
  }
  if ((o.method !== undefined && o.method !== 'GET') || o.body !== undefined) {
    throw new ExtensionError('Only GET downloads are supported in this browser.')
  }
  const headers: Record<string, string> = {}
  for (const h of Array.isArray(o.headers) ? o.headers : []) {
    if (!isObject(h) || !isString(h.name)) continue
    if (/^(host|content-length|cookie|cookie2|origin|referer|connection|keep-alive|upgrade|te|trailer|transfer-encoding|via|proxy-.*|sec-.*)$/i.test(h.name)) {
      throw new ExtensionError('Unsafe request header name')
    }
    headers[h.name] = isString(h.value) ? h.value : ''
  }
  return new Promise<number>((resolve, reject) => {
    const request: Request = {
      extensionId: call.extensionId,
      url: parsed.href,
      path,
      saveAs: o.saveAs === true,
      conflictAction: isString(o.conflictAction) ? o.conflictAction : 'uniquify',
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = requests.indexOf(request)
        if (i !== -1) requests.splice(i, 1)
        reject(new ExtensionError('Download failed: the server did not respond.'))
      }, 60_000)
    }
    requests.push(request)
    try {
      webSession().downloadURL(parsed.href, Object.keys(headers).length ? { headers } : undefined)
    } catch (err) {
      clearTimeout(request.timer)
      requests.splice(requests.indexOf(request), 1)
      reject(new ExtensionError(err instanceof Error ? err.message : 'Download failed.'))
    }
  })
}

/** Asks extensions listening to onDeterminingFilename for a name; the most recently asked one with an answer wins. */
async function determineFilename(id: string): Promise<void> {
  const extensions = listeningExtensions('downloads.onDeterminingFilename')
  const item = toItem(id)
  if (!extensions.length || !item) return
  const answers = await Promise.all(extensions.map((extensionId) => emitForResponse(extensionId, 'downloads.onDeterminingFilename', [item], 60_000)))
  let chosen: { filename: string; conflictAction?: unknown } | null = null
  for (const answer of answers) {
    if (isObject(answer) && isString(answer.filename) && answer.filename) chosen = { filename: answer.filename, conflictAction: answer.conflictAction }
  }
  const path = chosen ? safeRelative(chosen.filename) : null
  if (!chosen || !path) return
  const current = downloadEntry(id)?.state.path
  if (!current || current === path) return
  retargetDownload(id, chosen.conflictAction === 'overwrite' ? path : uniquePath(path))
}

// ---- change tracking ----

function onCreated(id: string, item: DownloadItem): void {
  const request = planned
  planned = null
  const chain = item.getURLChain()
  extras.set(id, {
    url: chain[0] ?? item.getURL(),
    finalUrl: chain.at(-1) ?? item.getURL(),
    mime: item.getMimeType(),
    byExtensionId: request?.extensionId,
    byExtensionName: request ? extensionName(request.extensionId) : undefined,
    saveAs: !!request && (request.saveAs || request.conflictAction === 'prompt')
  })
  const chromeItem = toItem(id)
  if (!chromeItem) return
  reported.set(id, chromeItem)
  request?.resolve(Number(id))
  emit('downloads.onCreated', [chromeItem])
  if (!extras.get(id)!.saveAs) void determineFilename(id)
}

function onChanged(id: string): void {
  const extra = extras.get(id)
  const entry = downloadEntry(id)
  if (!entry) return
  if (extra && entry.state.state !== 'progressing' && extra.endTime === undefined) extra.endTime = Date.now()
  if (extra && entry.item) extra.mime = entry.item.getMimeType() || extra.mime
  const next = toItem(id)
  if (!next) return
  const prev = reported.get(id)
  reported.set(id, next)
  if (!prev) return
  const delta: Record<string, unknown> = { id: next.id }
  for (const key of DELTA_KEYS) {
    if (prev[key] !== next[key]) delta[key] = { previous: prev[key], current: next[key] }
  }
  if (Object.keys(delta).length > 1) emit('downloads.onChanged', [delta])
}

function onRemoved(id: string): void {
  extras.delete(id)
  reported.delete(id)
  emit('downloads.onErased', [Number(id)])
}

downloadEvents.on('created', onCreated)
downloadEvents.on('changed', onChanged)
downloadEvents.on('removed', onRemoved)
setDownloadPlanner(planFor)

// ---- API ----

async function getFileIcon(_call: CallContext, downloadId: unknown, options: unknown): Promise<string> {
  const item = requireItem(downloadId)
  const size = isObject(options) && options.size !== undefined ? options.size : 32
  if (size !== 16 && size !== 32) throw new ExtensionError('Invalid `size`')
  if (!item.filename) throw new ExtensionError('Filename not yet determined')
  try {
    const icon = await app.getFileIcon(item.filename, { size: size === 16 ? 'small' : 'normal' })
    if (icon.isEmpty()) throw new Error('empty')
    return icon.toDataURL()
  } catch {
    throw new ExtensionError('Icon not found')
  }
}

function requireComplete(item: Item): void {
  if (item.state !== 'complete') throw new ExtensionError('Download must be complete')
  if (!existsSync(item.filename)) throw new ExtensionError('Download file already deleted')
}

defineApi('downloads', {
  permissions: ['downloads'],
  methods: {
    download,
    search: (_call, query) => searchDownloads(query),
    pause: (_call, downloadId) => {
      const item = requireItem(downloadId)
      if (item.state !== 'in_progress') throw new ExtensionError('Download must be in progress')
      downloadAction('pause', String(item.id))
    },
    resume: (_call, downloadId) => {
      const item = requireItem(downloadId)
      if (item.state !== 'in_progress') throw new ExtensionError('Download must be in progress')
      if (item.paused && !item.canResume) throw new ExtensionError('DownloadItem.canResume must be true')
      downloadAction('resume', String(item.id))
    },
    cancel: (_call, downloadId) => {
      // Chrome ignores cancelling a download that isn't running.
      const item = isNumber(downloadId) ? toItem(String(downloadId)) : null
      if (item?.state === 'in_progress') downloadAction('cancel', String(item.id))
    },
    getFileIcon,
    open: (call, downloadId) => {
      if (!hasApiPermission(call.extensionId, 'downloads.open')) throw new ExtensionError('The "downloads.open" permission is required')
      const item = requireItem(downloadId)
      requireComplete(item)
      downloadAction('open', String(item.id))
    },
    show: (_call, downloadId) => {
      const item = requireItem(downloadId)
      if (existsSync(item.filename)) shell.showItemInFolder(item.filename)
      else shell.openPath(downloadsDir()).catch(() => {})
    },
    showDefaultFolder: () => void shell.openPath(downloadsDir()).catch(() => {}),
    erase: (_call, query) => {
      const ids = searchDownloads(query).map((i) => i.id)
      for (const id of ids) downloadAction('remove', String(id))
      return ids
    },
    removeFile: (_call, downloadId) => {
      const item = requireItem(downloadId)
      requireComplete(item)
      try {
        unlinkSync(item.filename)
      } catch {
        throw new ExtensionError('Download file already deleted')
      }
      onChanged(String(item.id))
    },
    acceptDanger: (_call, downloadId) => {
      requireItem(downloadId)
      // Nothing is ever flagged dangerous here.
      throw new ExtensionError('Download must be dangerous')
    },
    drag: (call, downloadId) => {
      const item = requireItem(downloadId)
      requireComplete(item)
      const wc = call.context.webContents
      if (!wc || wc.isDestroyed()) return
      void app
        .getFileIcon(item.filename, { size: 'normal' })
        .catch(() => nativeImage.createEmpty())
        .then((icon) => {
          if (!wc.isDestroyed()) wc.startDrag({ file: item.filename, icon })
        })
    },
    setShelfEnabled: (call, enabled) => {
      if (!hasApiPermission(call.extensionId, 'downloads.shelf')) throw new ExtensionError('downloads.setShelfEnabled requires "downloads.shelf" permission.')
      uiEnabled = enabled !== false
    },
    setUiOptions: (call, options) => {
      if (!hasApiPermission(call.extensionId, 'downloads.ui')) throw new ExtensionError('downloads.setUiOptions requires "downloads.ui" permission.')
      if (!isObject(options) || typeof options.enabled !== 'boolean') throw new ExtensionError('Invalid options.')
      uiEnabled = options.enabled
    }
  }
})

/** Whether an extension asked to hide the browser's own download UI (setUiOptions). The panel may consult this. */
export function downloadUiEnabled(): boolean {
  return uiEnabled
}

defineEvent('downloads.onCreated', { permissions: ['downloads'] })
defineEvent('downloads.onErased', { permissions: ['downloads'] })
defineEvent('downloads.onChanged', { permissions: ['downloads'] })
defineEvent('downloads.onDeterminingFilename', { permissions: ['downloads'] })
