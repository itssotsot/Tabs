import type { WebContents } from 'electron'
import { browserEvents } from '../../../browser-events'

/**
 * DevTools-protocol plumbing for chrome.debugger and chrome.pageCapture, on top of the debugger
 * attachment identity.ts keeps on every tab page (never detached here). Follows each page's child
 * sessions (out-of-process frames and workers, auto-attached by identity.ts) so chrome.debugger
 * can tell extensions about them. Sends nothing to pages by itself.
 */

export interface ChildTarget {
  readonly sessionId: string
  /** The session it was auto-attached from (undefined: the page's own session). */
  readonly parentSessionId: string | undefined
  readonly targetId: string
  readonly type: string
  url: string
}

const trackers = new Map<number, Map<string, ChildTarget>>()
const wired = new WeakSet<WebContents>()

/** Sends a DevTools command on the page's shared attachment. */
export function send<T = any>(wc: WebContents, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
  if (wc.isDestroyed()) return Promise.reject(new Error('The tab was closed.'))
  return wc.debugger.sendCommand(method, params, sessionId) as Promise<T>
}

export function isTracked(wc: WebContents): boolean {
  return trackers.has(wc.id)
}

/** The page's auto-attached child sessions (frames and workers). */
export function childTargets(wc: WebContents): ChildTarget[] {
  return [...(trackers.get(wc.id)?.values() ?? [])]
}

function removeChild(children: Map<string, ChildTarget>, sessionId: string): void {
  if (!children.delete(sessionId)) return
  for (const child of [...children.values()]) if (child.parentSessionId === sessionId) removeChild(children, child.sessionId)
}

function onMessage(wc: WebContents, method: string, params: any, sessionId: string | undefined): void {
  const children = trackers.get(wc.id)
  if (!children) return
  if (method === 'Target.attachedToTarget') {
    const info = params.targetInfo ?? {}
    children.set(params.sessionId, { sessionId: params.sessionId, parentSessionId: sessionId, targetId: info.targetId, type: info.type, url: info.url ?? '' })
  } else if (method === 'Target.detachedFromTarget') {
    removeChild(children, params.sessionId ?? sessionId)
  } else if (method === 'Target.targetInfoChanged') {
    const info = params.targetInfo ?? {}
    for (const child of children.values()) if (child.targetId === info.targetId) child.url = info.url ?? child.url
  }
}

/** Starts following a tab page's child sessions. Needs identity.ts's attachment. */
export function track(wc: WebContents): void {
  if (wc.isDestroyed() || trackers.has(wc.id) || !wc.debugger.isAttached()) return
  trackers.set(wc.id, new Map())
  if (wired.has(wc)) return
  wired.add(wc)
  wc.debugger.on('message', (_e, method, params, sessionId) => onMessage(wc, method, params, sessionId || undefined))
  wc.debugger.on('detach', () => trackers.delete(wc.id))
  wc.once('destroyed', () => trackers.delete(wc.id))
  // identity.ts attaches again on navigation if the attachment was lost; follow it.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !trackers.has(wc.id)) setImmediate(() => track(wc))
  })
}

browserEvents.on('tab-webcontents-created', (_tab, wc) => track(wc))
