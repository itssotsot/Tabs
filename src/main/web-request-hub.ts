import type {
  BeforeSendResponse,
  CallbackResponse,
  HeadersReceivedResponse,
  OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
  OnHeadersReceivedListenerDetails,
  OnResponseStartedListenerDetails,
  OnSendHeadersListenerDetails,
  Session
} from 'electron'
import { matchesAny } from './extensions/match-pattern'

/**
 * Electron allows one listener per webRequest event per session, but several parts of the app
 * need them: the ad blocker, the browser identity headers, and Chrome extensions'
 * declarativeNetRequest and webRequest APIs. The hub owns Electron's listeners and runs every
 * handler in turn. Code that calls `session.webRequest.*` directly (the ad blocker library) is
 * routed through it too, with one slot per event like Electron itself.
 */

interface BlockingStages {
  onBeforeRequest: { details: OnBeforeRequestListenerDetails; response: CallbackResponse }
  onBeforeSendHeaders: { details: OnBeforeSendHeadersListenerDetails; response: BeforeSendResponse }
  onHeadersReceived: { details: OnHeadersReceivedListenerDetails; response: HeadersReceivedResponse }
}

interface ObserverStages {
  onSendHeaders: OnSendHeadersListenerDetails
  onResponseStarted: OnResponseStartedListenerDetails
  onBeforeRedirect: OnBeforeRedirectListenerDetails
  onCompleted: OnCompletedListenerDetails
  onErrorOccurred: OnErrorOccurredListenerDetails
}

export type BlockingStage = keyof BlockingStages
export type ObserverStage = keyof ObserverStages

type Awaitable<T> = T | Promise<T>

export interface BlockingHandler<S extends BlockingStage> {
  /** Unique; registering the same id again replaces the handler. */
  id: string
  /** Lower runs first. Defaults to 0. */
  order?: number
  /** Match patterns; every URL when omitted. */
  urls?: string[]
  handle(details: BlockingStages[S]['details']): Awaitable<BlockingStages[S]['response'] | void>
}

export interface ObserverHandler<S extends ObserverStage> {
  id: string
  urls?: string[]
  handle(details: ObserverStages[S]): void
}

const BLOCKING: BlockingStage[] = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']
const OBSERVERS: ObserverStage[] = ['onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']

type AnyBlocking = BlockingHandler<BlockingStage>
type AnyObserver = ObserverHandler<ObserverStage>

class Hub {
  private readonly blocking = new Map<BlockingStage, AnyBlocking[]>()
  private readonly observers = new Map<ObserverStage, AnyObserver[]>()
  private readonly installed = new Set<string>()

  constructor(private readonly ses: Session, private readonly original: Record<string, (...args: unknown[]) => void>) {}

  addBlocking(stage: BlockingStage, handler: AnyBlocking): void {
    const list = (this.blocking.get(stage) ?? []).filter((h) => h.id !== handler.id)
    list.push(handler)
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    this.blocking.set(stage, list)
    this.install(stage)
  }

  addObserver(stage: ObserverStage, handler: AnyObserver): void {
    const list = (this.observers.get(stage) ?? []).filter((h) => h.id !== handler.id)
    list.push(handler)
    this.observers.set(stage, list)
    this.install(stage)
  }

  remove(stage: BlockingStage | ObserverStage, id: string): void {
    const blocking = this.blocking.get(stage as BlockingStage)
    if (blocking) this.blocking.set(stage as BlockingStage, blocking.filter((h) => h.id !== id))
    const observers = this.observers.get(stage as ObserverStage)
    if (observers) this.observers.set(stage as ObserverStage, observers.filter((h) => h.id !== id))
  }

  private install(stage: string): void {
    if (this.installed.has(stage)) return
    this.installed.add(stage)
    const register = this.original[stage]
    if ((BLOCKING as string[]).includes(stage)) {
      register({ urls: ['<all_urls>'] }, (details: { url: string }, callback: (r: object) => void) => {
        void this.runBlocking(stage as BlockingStage, details as never).then(callback, (err) => {
          console.error(`[webRequest] ${stage} handler failed`, err)
          callback({})
        })
      })
    } else {
      register({ urls: ['<all_urls>'] }, (details: { url: string }) => {
        for (const h of this.observers.get(stage as ObserverStage) ?? []) {
          if (h.urls && !matchesAny(h.urls, details.url)) continue
          try {
            h.handle(details as never)
          } catch (err) {
            console.error(`[webRequest] ${stage} observer ${h.id} failed`, err)
          }
        }
      })
    }
  }

  private async runBlocking<S extends BlockingStage>(stage: S, details: BlockingStages[S]['details']): Promise<object> {
    const handlers = this.blocking.get(stage) ?? []
    if (stage === 'onBeforeRequest') {
      for (const h of handlers) {
        if (h.urls && !matchesAny(h.urls, details.url)) continue
        const r = (await h.handle(details)) as CallbackResponse | undefined
        if (r?.cancel) return { cancel: true }
        if (r?.redirectURL) return { redirectURL: r.redirectURL }
      }
      return {}
    }
    if (stage === 'onBeforeSendHeaders') {
      const d = details as OnBeforeSendHeadersListenerDetails
      let requestHeaders = d.requestHeaders
      let changed = false
      for (const h of handlers) {
        if (h.urls && !matchesAny(h.urls, d.url)) continue
        const r = (await h.handle({ ...d, requestHeaders })) as BeforeSendResponse | undefined
        if (r?.cancel) return { cancel: true }
        if (r?.requestHeaders) {
          requestHeaders = r.requestHeaders as Record<string, string>
          changed = true
        }
      }
      return changed ? { requestHeaders } : {}
    }
    const d = details as OnHeadersReceivedListenerDetails
    let responseHeaders = d.responseHeaders
    let statusLine: string | undefined
    let changed = false
    for (const h of handlers) {
      if (h.urls && !matchesAny(h.urls, d.url)) continue
      const r = (await h.handle({ ...d, responseHeaders, statusLine: statusLine ?? d.statusLine })) as HeadersReceivedResponse | undefined
      if (r?.cancel) return { cancel: true }
      if (r?.responseHeaders) {
        responseHeaders = r.responseHeaders as Record<string, string[]>
        changed = true
      }
      if (r?.statusLine) statusLine = r.statusLine
    }
    const out: HeadersReceivedResponse = {}
    if (changed) out.responseHeaders = responseHeaders
    if (statusLine) out.statusLine = statusLine
    return out
  }

  /** Replaces `session.webRequest.<stage>` so direct callers get one handler slot each. */
  patchSession(): void {
    const webRequest = this.ses.webRequest as unknown as Record<string, unknown>
    for (const stage of [...BLOCKING, ...OBSERVERS]) {
      const id = `session:${stage}`
      webRequest[stage] = (...args: unknown[]): void => {
        const listener = args.find((a) => typeof a === 'function' || a === null) as ((...a: unknown[]) => void) | null | undefined
        const filter = args.find((a) => a && typeof a === 'object') as { urls?: string[] } | undefined
        if (!listener) return this.remove(stage, id)
        const urls = filter?.urls?.length && !filter.urls.includes('<all_urls>') ? filter.urls : undefined
        if ((BLOCKING as string[]).includes(stage)) {
          this.addBlocking(stage as BlockingStage, {
            id,
            order: 100,
            urls,
            // Electron-style listener: answers through a callback.
            handle: (details) => new Promise((resolve) => listener(details, resolve))
          })
        } else {
          this.addObserver(stage as ObserverStage, { id, urls, handle: (details) => listener(details) })
        }
      }
    }
  }
}

const hubs = new WeakMap<Session, Hub>()

function hubFor(ses: Session): Hub {
  let hub = hubs.get(ses)
  if (!hub) {
    const webRequest = ses.webRequest as unknown as Record<string, (...args: unknown[]) => void>
    const original: Record<string, (...args: unknown[]) => void> = {}
    for (const stage of [...BLOCKING, ...OBSERVERS]) original[stage] = webRequest[stage].bind(ses.webRequest)
    hub = new Hub(ses, original)
    hub.patchSession()
    hubs.set(ses, hub)
  }
  return hub
}

/** Must run before anything else registers webRequest listeners on the session. */
export function setupWebRequestHub(ses: Session): void {
  hubFor(ses)
}

export function addBlockingHandler<S extends BlockingStage>(ses: Session, stage: S, handler: BlockingHandler<S>): void {
  hubFor(ses).addBlocking(stage, handler as unknown as AnyBlocking)
}

export function addObserver<S extends ObserverStage>(ses: Session, stage: S, handler: ObserverHandler<S>): void {
  hubFor(ses).addObserver(stage, handler as unknown as AnyObserver)
}

export function removeHandler(ses: Session, stage: BlockingStage | ObserverStage, id: string): void {
  hubFor(ses).remove(stage, id)
}
