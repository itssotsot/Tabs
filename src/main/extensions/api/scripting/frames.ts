import { ipcMain, type WebContents, type WebFrameMain } from 'electron'
import { PAGE_CHANNEL, type FramePlan, type RunRequest, type RunResult } from '@shared/page-scripts'

/**
 * The main-process end of the web frames' preload (src/preload/page-scripts): documents as they
 * start (each has a random token, used as its Chrome documentId), running code in a frame and
 * getting the result back, and the Electron isolated world ids the scripts run in.
 */

export type FrameKey = string

interface DocumentRecord {
  frame: WebFrameMain
  token: string
  url: string
}

/** Frames whose preload set up page scripts, and their current document. */
const documents = new Map<FrameKey, DocumentRecord>()
const watched = new WeakSet<WebContents>()

type PlanProvider = (frame: WebFrameMain, wc: WebContents, url: string) => FramePlan | null
let planProvider: PlanProvider | null = null
const startListeners: ((key: FrameKey, token: string, frame: WebFrameMain) => void)[] = []
const navigateListeners: ((wc: WebContents, key: FrameKey, url: string) => void)[] = []
const closeListeners: ((wc: WebContents) => void)[] = []

export function frameKey(frame: WebFrameMain): FrameKey {
  return `${frame.processId}:${frame.routingId}`
}

/** Chrome's frame id: 0 for a main frame, the frame tree node id for subframes. */
export function chromeFrameId(frame: WebFrameMain): number {
  return frame.parent ? frame.frameTreeNodeId : 0
}

export const isLive = (frame: WebFrameMain | null | undefined): frame is WebFrameMain => {
  try {
    return !!frame && !frame.isDestroyed() && !frame.detached
  } catch {
    return false
  }
}

/** The token of the frame's current document, if its preload set up page scripts. */
export function documentToken(frame: WebFrameMain): string | null {
  if (!isLive(frame)) return null
  return documents.get(frameKey(frame))?.token ?? null
}

/** Which user scripts a starting document runs (user-scripts.ts). */
export function setPlanProvider(provider: PlanProvider): void {
  planProvider = provider
}

/** A frame got a new document (its old one is gone). */
export function onDocumentStart(listener: (key: FrameKey, token: string, frame: WebFrameMain) => void): void {
  startListeners.push(listener)
}

/** A frame navigated (to any URL, including ones without page scripts). */
export function onFrameNavigated(listener: (wc: WebContents, key: FrameKey, url: string) => void): void {
  navigateListeners.push(listener)
}

export function onPageClosed(listener: (wc: WebContents) => void): void {
  closeListeners.push(listener)
}

function watch(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  wc.on('did-frame-navigate', (_e, url, _code, _status, _isMainFrame, processId, routingId) => {
    const key = `${processId}:${routingId}`
    for (const listener of navigateListeners) listener(wc, key, url)
  })
  wc.once('destroyed', () => {
    for (const [key, record] of documents) if (!isLive(record.frame)) documents.delete(key)
    for (const listener of closeListeners) listener(wc)
  })
}

function pruneDocuments(): void {
  if (documents.size < 1000) return
  for (const [key, record] of documents) if (!isLive(record.frame)) documents.delete(key)
}

// Every web frame's preload asks this synchronously as its document starts: always answer.
ipcMain.on(PAGE_CHANNEL.start, (event, info) => {
  let plan: FramePlan | null = null
  try {
    const frame = event.senderFrame
    const token = info?.token
    const url = info?.url
    if (frame && typeof token === 'string' && /^[0-9A-F]{32}$/.test(token) && typeof url === 'string') {
      const key = frameKey(frame)
      pruneDocuments()
      documents.set(key, { frame, token, url })
      watch(event.sender)
      for (const listener of startListeners) listener(key, token, frame)
      // The frame's own URL may not be committed on this side yet, so the document's is used.
      plan = planProvider?.(frame, event.sender, url) ?? null
    }
  } catch (err) {
    console.error('[extensions] user scripts for a frame failed', err)
  } finally {
    event.returnValue = plan
  }
})

// ---- running code in frames ----

interface PendingRun {
  key: FrameKey
  frame: WebFrameMain
  resolve: (result: RunResult) => void
  timer: NodeJS.Timeout
}

const pendingRuns = new Map<number, PendingRun>()
let nextRunId = 1

const FRAME_GONE: RunResult = { ok: false, error: 'The frame was removed or navigated.', scriptError: false }

/** Runs code or CSS in the frame's current document, through its preload. */
export function runInFrame(frame: WebFrameMain, request: Omit<RunRequest, 'id' | 'token'>, timeoutMs = 40_000): Promise<RunResult> {
  const token = documentToken(frame)
  if (!token) return Promise.resolve(FRAME_GONE)
  const id = nextRunId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRuns.delete(id)
      resolve({ ok: false, error: 'The frame did not respond.', scriptError: false })
    }, timeoutMs)
    pendingRuns.set(id, { key: frameKey(frame), frame, resolve, timer })
    try {
      frame.send(PAGE_CHANNEL.run, { ...request, id, token })
    } catch {
      clearTimeout(timer)
      pendingRuns.delete(id)
      resolve(FRAME_GONE)
    }
  })
}

ipcMain.on(PAGE_CHANNEL.runResult, (event, id, result) => {
  const pending = typeof id === 'number' ? pendingRuns.get(id) : undefined
  if (!pending || !event.senderFrame || frameKey(event.senderFrame) !== pending.key) return
  pendingRuns.delete(id)
  clearTimeout(pending.timer)
  pending.resolve(result && typeof result === 'object' && 'ok' in result ? (result as RunResult) : FRAME_GONE)
})

// A new document can't answer for the old one.
onDocumentStart((key, _token, frame) => {
  for (const [id, pending] of pendingRuns) {
    if (pending.key !== key && pending.frame !== frame) continue
    pendingRuns.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(FRAME_GONE)
  }
})

// ---- worlds ----

const worldIds = new Map<string, number>()
/** Electron uses 999 for its own isolated world and 1 << 20 up for Chrome extensions' content scripts. */
const FIRST_WORLD_ID = 1000

/** A stable Electron isolated world id for a key (e.g. an extension's user-script world). */
export function worldNumber(key: string): number {
  let id = worldIds.get(key)
  if (id === undefined) {
    id = FIRST_WORLD_ID + worldIds.size
    worldIds.set(key, id)
  }
  return id
}

/** Chrome's CSP for isolated worlds in Manifest V3, the default for user-script worlds too. */
export const DEFAULT_WORLD_CSP = "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'; object-src 'self';"
