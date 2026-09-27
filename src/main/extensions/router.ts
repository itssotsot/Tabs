import {
  ipcMain,
  webContents as webContentsModule,
  type Extension,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerEvent,
  type IpcMainServiceWorkerInvokeEvent,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { EXT_CHANNEL } from '@shared/extension-protocol'
import { hasApiPermission, loadedExtension, manifestOf } from './access'

/**
 * Routes the Chrome extension APIs we implement ourselves. The injected script
 * (src/preload/extension.ts) turns each `chrome.<namespace>.<method>()` call into an IPC call
 * handled by the module that defined the namespace, and delivers events back to the pages and
 * background workers that listen for them, starting a stopped background worker when needed.
 */

export type ContextType = 'BACKGROUND' | 'TAB' | 'POPUP' | 'SIDE_PANEL' | 'OFFSCREEN_DOCUMENT' | 'DEVELOPER_TOOLS' | 'OTHER'

/** A running extension page (in any frame) or background worker. */
export interface ExtensionContext {
  readonly key: string
  readonly extensionId: string
  readonly type: ContextType
  readonly worker?: ServiceWorkerMain
  readonly frame?: WebFrameMain
  readonly webContents?: WebContents
  /** eventName -> listener key -> the filter it was added with (null for none). */
  readonly listeners: Map<string, Map<number, unknown>>
  /** Workers: their top-level script has run. Frames are ready right away. */
  ready: boolean
  url: string
}

export interface CallContext {
  readonly extension: Extension
  readonly extensionId: string
  readonly context: ExtensionContext
  /** Chrome tab id of the calling page, when it's shown in a tab. */
  readonly tabId: number | undefined
  /** The window the caller belongs to (its tab's, or the one its popup or side panel is in). */
  readonly windowId: number | undefined
}

/** Thrown by API methods; the message reaches the extension as runtime.lastError or a rejection. */
export class ExtensionError extends Error {}

type Method = (call: CallContext, ...args: any[]) => unknown

export interface ApiDefinition {
  /** The namespace needs one of these permissions. */
  permissions?: string[]
  /** …or this manifest key (e.g. `action`, `side_panel`, `commands`). */
  manifestKey?: string
  methods: Record<string, Method>
}

export interface EventDefinition {
  /** Only extensions with one of these permissions receive it. */
  permissions?: string[]
  /** For events whose listeners take a filter: whether the event matches it. */
  matches?: (filter: any, args: unknown[], extensionId: string) => boolean
}

/** Where extension pages that aren't tabs are shown, registered by the modules that show them. */
export interface Surface {
  type: ContextType
  windowId?: number
  tabId?: number
}

// ---- registries ----

const apis = new Map<string, ApiDefinition>()
const events = new Map<string, EventDefinition>()
const contexts = new Map<string, ExtensionContext>()
const surfaces = new Map<number, Surface>()
/** For each extension's background worker: events (and filters) it listened to, even while it's stopped. */
const lazyListeners = new Map<string, Map<string, unknown[]>>()
/** Events waiting for an extension's worker to start. */
const pendingForWorker = new Map<string, { name: string; args: unknown[]; replyId: number | null }[]>()
const startingWorkers = new Map<string, Promise<void>>()
const pendingReplies = new Map<number, { resolve: (value: unknown) => void; timer: NodeJS.Timeout; remaining: number; context?: ExtensionContext }>()
let nextReplyId = 1
let ses: Session | null = null

/** Tab and window of a page, provided by the tabs model. Set in setupRouter. */
let locate: (wc: WebContents) => { tabId?: number; windowId?: number } | null = () => null

export function defineApi(namespace: string, definition: ApiDefinition): void {
  const existing = apis.get(namespace)
  if (existing) {
    // Several modules may add methods to one namespace (e.g. runtime).
    existing.methods = { ...existing.methods, ...definition.methods }
    return
  }
  apis.set(namespace, definition)
}

export function defineEvent(name: string, definition: EventDefinition = {}): void {
  events.set(name, definition)
}

export function registerSurface(wc: WebContents, surface: Surface): void {
  surfaces.set(wc.id, surface)
  wc.once('destroyed', () => surfaces.delete(wc.id))
}

export function surfaceOf(wc: WebContents): Surface | undefined {
  return surfaces.get(wc.id)
}

export function allContexts(extensionId?: string): ExtensionContext[] {
  const list = [...contexts.values()].filter((c) => isAlive(c))
  return extensionId ? list.filter((c) => c.extensionId === extensionId) : list
}

// ---- contexts ----

const EXT_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})(\/|$)/

function extensionIdOf(url: string | undefined): string | null {
  return url ? (EXT_ORIGIN_RE.exec(url)?.[1] ?? null) : null
}

function isAlive(c: ExtensionContext): boolean {
  if (c.worker) return !c.worker.isDestroyed()
  if (!c.frame || c.frame.isDestroyed() || c.frame.detached) return false
  return extensionIdOf(c.frame.origin + '/') === c.extensionId
}

function frameKey(frame: WebFrameMain): string {
  return `f:${frame.processId}:${frame.routingId}`
}

function frameContext(frame: WebFrameMain | null, wc: WebContents): ExtensionContext | null {
  if (!frame || frame.isDestroyed()) return null
  const extensionId = extensionIdOf(frame.origin + '/')
  if (!extensionId || !loadedExtension(extensionId)) return null
  const key = frameKey(frame)
  let ctx = contexts.get(key)
  if (ctx && ctx.extensionId !== extensionId) {
    contexts.delete(key)
    ctx = undefined
  }
  if (!ctx) {
    const surface = surfaces.get(wc.id)
    const isTop = frame === wc.mainFrame
    const located = locate(wc)
    // Chromium hosts offscreen documents (chrome.offscreen, which Electron implements) like background pages.
    const hosted = wc.getType() === 'backgroundPage' ? 'OFFSCREEN_DOCUMENT' : 'OTHER'
    const type: ContextType = !isTop ? 'OTHER' : surface ? surface.type : located?.tabId !== undefined ? 'TAB' : hosted
    ctx = { key, extensionId, type, frame, webContents: wc, listeners: new Map(), ready: true, url: frame.url }
    contexts.set(key, ctx)
    wc.once('destroyed', () => {
      for (const [k, c] of contexts) if (c.webContents === wc) contexts.delete(k)
    })
  }
  ctx.url = frame.url
  return ctx
}

function workerContext(worker: ServiceWorkerMain): ExtensionContext | null {
  const extensionId = extensionIdOf(worker.scope)
  if (!extensionId) return null
  const key = `w:${worker.versionId}`
  let ctx = contexts.get(key)
  if (!ctx) {
    ctx = { key, extensionId, type: 'BACKGROUND', worker, listeners: new Map(), ready: false, url: worker.scriptURL }
    contexts.set(key, ctx)
  }
  return ctx
}

function send(ctx: ExtensionContext, channel: string, ...args: unknown[]): boolean {
  try {
    if (ctx.worker) {
      if (ctx.worker.isDestroyed()) return false
      ctx.worker.send(channel, ...args)
    } else {
      if (!ctx.frame || ctx.frame.isDestroyed()) return false
      ctx.frame.send(channel, ...args)
    }
    return true
  } catch {
    return false
  }
}

function callContext(ctx: ExtensionContext): CallContext {
  const extension = loadedExtension(ctx.extensionId)
  if (!extension) throw new ExtensionError('Extension is not loaded.')
  let tabId: number | undefined
  let windowId: number | undefined
  const wc = ctx.webContents
  if (wc && !wc.isDestroyed()) {
    // Popups and side panels aren't tabs (tabs.getCurrent gives undefined) but belong to a window.
    const surface = surfaces.get(wc.id)
    if (surface) windowId = surface.windowId
    else {
      // Includes extension frames inside a web page: they're in that tab.
      const located = locate(wc)
      tabId = located?.tabId
      windowId = located?.windowId
    }
  }
  return { extension, extensionId: ctx.extensionId, context: ctx, tabId, windowId }
}

// ---- calls ----

function allowed(definition: ApiDefinition | EventDefinition, extensionId: string, manifestKey?: string): boolean {
  const perms = definition.permissions
  const key = manifestKey
  if (!perms?.length && !key) return true
  if (perms?.some((p) => hasApiPermission(extensionId, p))) return true
  return !!key && manifestOf(extensionId)?.[key] !== undefined
}

async function handleCall(ctx: ExtensionContext | null, namespace: unknown, method: unknown, args: unknown): Promise<unknown> {
  if (!ctx) throw new Error('Not allowed')
  if (typeof namespace !== 'string' || typeof method !== 'string' || !Array.isArray(args)) throw new ExtensionError('Invalid call.')
  const api = apis.get(namespace)
  const fn = api?.methods[method]
  if (!api || !fn || !Object.prototype.hasOwnProperty.call(api.methods, method)) {
    throw new ExtensionError(`chrome.${namespace}.${method} is not supported.`)
  }
  if (!allowed(api, ctx.extensionId, api.manifestKey)) {
    throw new ExtensionError(`chrome.${namespace}.${method} needs the "${api.permissions?.[0] ?? api.manifestKey}" permission.`)
  }
  return await fn(callContext(ctx), ...args)
}

/** Strips values IPC can't carry (functions, symbols) and turns undefined into null inside arrays. */
function toTransferable(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

// ---- listeners ----

function onListen(ctx: ExtensionContext | null, name: unknown, key: unknown, filter: unknown, add: unknown): void {
  if (!ctx || typeof name !== 'string' || typeof key !== 'number') return
  let byKey = ctx.listeners.get(name)
  if (add) {
    if (!byKey) ctx.listeners.set(name, (byKey = new Map()))
    byKey.set(key, filter ?? null)
  } else {
    byKey?.delete(key)
    if (byKey && !byKey.size) ctx.listeners.delete(name)
  }
  if (ctx.worker) rememberLazy(ctx)
}

/** A background worker's listeners, kept after it stops so an event can start it again. */
function rememberLazy(ctx: ExtensionContext): void {
  const map = new Map<string, unknown[]>()
  for (const [name, byKey] of ctx.listeners) map.set(name, [...byKey.values()])
  lazyListeners.set(ctx.extensionId, map)
}

function onHello(ctx: ExtensionContext | null): void {
  if (!ctx) return
  ctx.listeners.clear()
  if (ctx.worker) ctx.ready = false
}

function onReady(ctx: ExtensionContext | null): void {
  if (!ctx) return
  ctx.ready = true
  rememberLazy(ctx)
  flushPending(ctx.extensionId)
}

function onReply(replyId: unknown, value: unknown): void {
  if (typeof replyId !== 'number') return
  const pending = pendingReplies.get(replyId)
  if (!pending) return
  // "undefined" means that context had no listener that answered; wait for the others.
  if (value === undefined && --pending.remaining > 0) return
  clearTimeout(pending.timer)
  pendingReplies.delete(replyId)
  pending.resolve(value)
}

// ---- events ----

function matchingKeys(name: string, ctx: ExtensionContext, args: unknown[]): number[] | null {
  const byKey = ctx.listeners.get(name)
  if (!byKey?.size) return null
  const matches = events.get(name)?.matches
  if (!matches) return [...byKey.keys()]
  const keys: number[] = []
  for (const [key, filter] of byKey) {
    try {
      if (filter == null || matches(filter, args, ctx.extensionId)) keys.push(key)
    } catch {
      // A malformed filter matches nothing.
    }
  }
  return keys.length ? keys : null
}

function lazyMatches(extensionId: string, name: string, args: unknown[]): boolean {
  const filters = lazyListeners.get(extensionId)?.get(name)
  if (!filters?.length) return false
  const matches = events.get(name)?.matches
  if (!matches) return true
  return filters.some((f) => {
    try {
      return f == null || matches(f, args, extensionId)
    } catch {
      return false
    }
  })
}

function workerOf(extensionId: string): ExtensionContext | undefined {
  return [...contexts.values()].find((c) => c.extensionId === extensionId && c.worker && !c.worker.isDestroyed())
}

function deliver(ctx: ExtensionContext, name: string, args: unknown[], replyId: number | null): boolean {
  const keys = matchingKeys(name, ctx, args)
  if (!keys) return false
  if (ctx.worker) keepAlive(ctx.worker)
  return send(ctx, EXT_CHANNEL.event, name, toTransferable(args), replyId, keys)
}

function keepAlive(worker: ServiceWorkerMain): void {
  try {
    const task = worker.startTask()
    setTimeout(() => {
      try {
        task.end()
      } catch {
        // The worker is gone.
      }
    }, 15_000)
  } catch {
    // Not running.
  }
}

async function startWorker(extensionId: string): Promise<void> {
  const existing = startingWorkers.get(extensionId)
  if (existing) return existing
  const extension = loadedExtension(extensionId)
  const background = (extension?.manifest as { background?: { service_worker?: string } } | undefined)?.background
  if (!extension || !background?.service_worker || !ses) return
  const start = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ses!.serviceWorkers.startWorkerForScope(extension.url)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  })().finally(() => startingWorkers.delete(extensionId))
  startingWorkers.set(extensionId, start)
  return start
}


function queueForWorker(extensionId: string, name: string, args: unknown[], replyId: number | null): void {
  let queue = pendingForWorker.get(extensionId)
  if (!queue) pendingForWorker.set(extensionId, (queue = []))
  queue.push({ name, args, replyId })
  void startWorker(extensionId)
  // Don't hold events forever if the worker never comes up.
  setTimeout(() => {
    const q = pendingForWorker.get(extensionId)
    if (q?.length) {
      pendingForWorker.delete(extensionId)
      for (const item of q) if (item.replyId !== null) onReply(item.replyId, undefined)
    }
  }, 10_000)
}

function flushPending(extensionId: string): void {
  const queue = pendingForWorker.get(extensionId)
  if (!queue?.length) return
  pendingForWorker.delete(extensionId)
  const worker = workerOf(extensionId)
  for (const item of queue) {
    const delivered = worker ? deliver(worker, item.name, item.args, item.replyId) : false
    if (!delivered && item.replyId !== null) onReply(item.replyId, undefined)
  }
}

export interface EmitOptions {
  /** Only this extension. */
  extensionId?: string
  /** Start a stopped background worker that listens for the event. Defaults to true. */
  wake?: boolean
  /** Start the worker even if it has never listened for the event (it may never have run yet). */
  force?: boolean
}

type ArgsFor = unknown[] | ((extensionId: string) => unknown[] | null)

function targetExtensions(name: string, options: EmitOptions): string[] {
  const def = events.get(name) ?? {}
  const ids = new Set<string>()
  for (const c of contexts.values()) ids.add(c.extensionId)
  for (const id of lazyListeners.keys()) ids.add(id)
  const list = options.extensionId ? [options.extensionId].filter((id) => ids.has(id) || options.force) : [...ids]
  return list.filter((id) => loadedExtension(id) && allowed(def, id))
}

/** Sends an event to every context of every extension that listens for it. */
export function emit(name: string, args: ArgsFor, options: EmitOptions = {}): void {
  for (const extensionId of targetExtensions(name, options)) {
    const extArgs = typeof args === 'function' ? args(extensionId) : args
    if (!extArgs) continue
    let workerHandled = false
    for (const ctx of allContexts(extensionId)) {
      if (ctx.worker && !ctx.ready) continue
      if (deliver(ctx, name, extArgs, null) && ctx.worker) workerHandled = true
    }
    const worker = workerOf(extensionId)
    const workerStarting = worker && !worker.ready
    const wanted = options.force || lazyMatches(extensionId, name, extArgs)
    if (!workerHandled && options.wake !== false && (workerStarting || !worker) && wanted) {
      queueForWorker(extensionId, name, extArgs, null)
    }
  }
}

/**
 * Sends an event to one extension and resolves with the first listener's response (the
 * `sendResponse` or returned promise of runtime.onMessage-style events), or undefined.
 */
export function emitForResponse(extensionId: string, name: string, args: unknown[], timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve) => {
    const replyId = nextReplyId++
    const targets = allContexts(extensionId).filter((c) => (!c.worker || c.ready) && matchingKeys(name, c, args))
    const pending = { resolve, timer: setTimeout(() => onReply(replyId, undefined), timeoutMs), remaining: Math.max(1, targets.length) }
    pendingReplies.set(replyId, pending)
    if (targets.length) {
      pending.remaining = targets.filter((c) => deliver(c, name, args, replyId)).length || 1
      if (!targets.some((c) => c.worker) && lazyMatches(extensionId, name, args) && !workerOf(extensionId)) {
        pending.remaining++
        queueForWorker(extensionId, name, args, replyId)
      }
    } else if (lazyMatches(extensionId, name, args)) {
      queueForWorker(extensionId, name, args, replyId)
    } else {
      clearTimeout(pending.timer)
      pendingReplies.delete(replyId)
      resolve(undefined)
    }
  })
}

/** Whether any context (or stopped worker) of the extension listens for the event. */
export function hasListener(name: string, extensionId: string): boolean {
  return allContexts(extensionId).some((c) => c.listeners.has(name)) || !!lazyListeners.get(extensionId)?.get(name)?.length
}

/** Every extension that listens for the event (in a live page or its worker). */
export function listeningExtensions(name: string): string[] {
  return targetExtensions(name, {}).filter((id) => hasListener(name, id))
}

/** Sends a message to all live contexts without waking anything (internal state like the tabs cache). */
export function broadcastLive(name: string, args: unknown[], extensionId?: string): void {
  for (const ctx of allContexts(extensionId)) if (!ctx.worker || ctx.ready) send(ctx, EXT_CHANNEL.event, name, toTransferable(args), null, null)
}

/** The extension was unloaded: drop its contexts and forget its worker's listeners. */
export function forgetExtension(extensionId: string): void {
  for (const [key, c] of contexts) if (c.extensionId === extensionId) contexts.delete(key)
  lazyListeners.delete(extensionId)
  pendingForWorker.delete(extensionId)
}

// ---- wiring ----

function frameCtx(e: IpcMainEvent | IpcMainInvokeEvent): ExtensionContext | null {
  return frameContext(e.senderFrame, e.sender)
}

function wireWorker(worker: ServiceWorkerMain): void {
  if (!extensionIdOf(worker.scope)) return
  const ipc = worker.ipc
  const marked = worker as unknown as { __tabsExtWired?: boolean }
  if (marked.__tabsExtWired) return
  marked.__tabsExtWired = true
  const ctx = (): ExtensionContext | null => workerContext(worker)
  ipc.handle(EXT_CHANNEL.call, (_e: IpcMainServiceWorkerInvokeEvent, ns, method, args) => handleCall(ctx(), ns, method, args).then(toTransferable))
  ipc.on(EXT_CHANNEL.listen, (_e: IpcMainServiceWorkerEvent, name, key, filter, add) => onListen(ctx(), name, key, filter, add))
  ipc.on(EXT_CHANNEL.hello, () => onHello(ctx()))
  ipc.on(EXT_CHANNEL.ready, () => onReady(ctx()))
  ipc.on(EXT_CHANNEL.reply, (_e, replyId, value) => onReply(replyId, value))
}

export function setupRouter(session: Session, locator: typeof locate): void {
  ses = session
  locate = locator

  ipcMain.handle(EXT_CHANNEL.call, (e, ns, method, args) => handleCall(frameCtx(e), ns, method, args).then(toTransferable))
  ipcMain.on(EXT_CHANNEL.listen, (e, name, key, filter, add) => onListen(frameCtx(e), name, key, filter, add))
  ipcMain.on(EXT_CHANNEL.hello, (e) => onHello(frameCtx(e)))
  ipcMain.on(EXT_CHANNEL.reply, (e, replyId, value) => {
    if (frameCtx(e)) onReply(replyId, value)
  })

  session.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus === 'starting' || runningStatus === 'running') {
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
      if (worker) wireWorker(worker)
    } else if (runningStatus === 'stopped') {
      contexts.delete(`w:${versionId}`)
    }
  })
  // Workers that were already running.
  for (const versionId of Object.keys(session.serviceWorkers.getAllRunning()).map(Number)) {
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    if (worker) wireWorker(worker)
  }
}

/** The webContents a frame context lives in, if it's still around. */
export function contextWebContents(ctx: ExtensionContext): WebContents | null {
  const wc = ctx.webContents
  return wc && !wc.isDestroyed() ? wc : null
}

export function webContentsById(id: number): WebContents | null {
  const wc = webContentsModule.fromId(id)
  return wc && !wc.isDestroyed() ? wc : null
}
