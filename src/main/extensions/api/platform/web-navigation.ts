import { app, webFrameMain, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { browserEvents } from '../../../browser-events'
import type { Tab } from '../../../tab'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, listeningExtensions, surfaceOf, webContentsById, type CallContext } from '../../router'
import { chromeTabId, extraWindowForWebContents, findTab, tabForWebContents } from '../../tabs-model'
import { matchesUrlFilters, type UrlFilter } from './url-filter'
import { asObject } from './util'

/**
 * chrome.webNavigation for every page in the web session: tabs (their Chrome tab id is their
 * page's id), windows extensions opened, and popups pages opened. Frame ids follow Chrome: 0 for
 * a page's main frame, the frame tree node id for subframes. Each committed document gets a
 * documentId. Details are only built when some extension listens.
 */

type FrameType = 'outermost_frame' | 'sub_frame'

interface FrameState {
  documentId: string
  url: string
  errorOccurred: boolean
  /** A subframe's later navigations are "manual_subframe". */
  committed: boolean
  pending?: { url: string; redirected: boolean; rendererInitiated: boolean }
}

/** webContents id -> frame tree node id -> what we know about the frame's document. */
const framesByPage = new Map<number, Map<number, FrameState>>()
/** Back/forward position at the last main-frame commit, per page, to spot history navigations. */
const historyPosition = new Map<number, { index: number; length: number }>()
const watched = new WeakSet<WebContents>()
const watchedFrames = new WeakSet<WebFrameMain>()
let ses: Session | null = null

const newDocumentId = (): string => randomBytes(16).toString('hex').toUpperCase()

const listening = (event: string): boolean => listeningExtensions(`webNavigation.${event}`).length > 0

/** The Chrome tab id of a page, or null for pages webNavigation doesn't cover (extension popups, background pages). */
function tabIdOf(wc: WebContents): number | null {
  if (wc.isDestroyed()) return null
  const found = tabForWebContents(wc)
  if (found) return chromeTabId(found.tab)
  if (extraWindowForWebContents(wc)) return wc.id
  if (surfaceOf(wc)) return null
  // Popups opened by web pages.
  if (wc.getType() === 'window' && !wc.getURL().startsWith('chrome-extension:')) return wc.id
  return null
}

function statesOf(wc: WebContents): Map<number, FrameState> {
  let map = framesByPage.get(wc.id)
  if (!map) framesByPage.set(wc.id, (map = new Map()))
  return map
}

function stateOf(wc: WebContents, frame: WebFrameMain): FrameState {
  const map = statesOf(wc)
  let state = map.get(frame.frameTreeNodeId)
  if (!state) {
    state = { documentId: newDocumentId(), url: frame.url, errorOccurred: false, committed: false }
    map.set(frame.frameTreeNodeId, state)
  }
  return state
}

const frameIdOf = (frame: WebFrameMain): number => (frame.parent ? frame.frameTreeNodeId : 0)
const parentFrameIdOf = (frame: WebFrameMain): number => (frame.parent ? frameIdOf(frame.parent) : -1)
const frameTypeOf = (frame: WebFrameMain): FrameType => (frame.parent ? 'sub_frame' : 'outermost_frame')

function alive(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  try {
    return !!frame && !frame.isDestroyed()
  } catch {
    return false
  }
}

/** Fields every per-frame event has. */
function frameDetails(wc: WebContents, tabId: number, frame: WebFrameMain, url: string, withDocument: boolean): Record<string, unknown> {
  const details: Record<string, unknown> = {
    tabId,
    url,
    processId: frame.processId,
    frameId: frameIdOf(frame),
    parentFrameId: parentFrameIdOf(frame),
    timeStamp: Date.now(),
    frameType: frameTypeOf(frame),
    documentLifecycle: 'active'
  }
  if (withDocument) details.documentId = stateOf(wc, frame).documentId
  if (frame.parent) details.parentDocumentId = stateOf(wc, frame.parent).documentId
  return details
}

function send(event: string, details: Record<string, unknown>): void {
  emit(`webNavigation.${event}`, [details])
}

function frameFromIds(wc: WebContents, processId: number, routingId: number, isMainFrame: boolean): WebFrameMain | null {
  const frame = webFrameMain.fromId(processId, routingId)
  if (alive(frame)) return frame
  return isMainFrame && !wc.isDestroyed() ? wc.mainFrame : null
}

const withoutHash = (url: string): string => url.replace(/#.*$/, '')

/** Chrome's transition type and qualifiers for a cross-document commit, as far as we can tell. */
function transitionOf(wc: WebContents, frame: WebFrameMain, state: FrameState, url: string): [string, string[]] {
  const qualifiers: string[] = []
  if (state.pending?.redirected) qualifiers.push('server_redirect')
  if (frame.parent) return [state.committed ? 'manual_subframe' : 'auto_subframe', qualifiers]
  const history = wc.navigationHistory
  const index = history.getActiveIndex()
  const length = history.length()
  const previous = historyPosition.get(wc.id)
  historyPosition.set(wc.id, { index, length })
  if (previous && length === previous.length && index !== previous.index && index !== previous.index + 1) {
    qualifiers.push('forward_back')
    return ['link', qualifiers]
  }
  if (state.pending?.rendererInitiated) return ['link', qualifiers]
  if (state.committed && withoutHash(state.url) === withoutHash(url) && previous && index === previous.index) return ['reload', qualifiers]
  return ['typed', qualifiers]
}

/** Recent provisional failures, so the did-fail-load that follows isn't reported twice. */
const recentFailures = new Map<string, number>()

function reportError(wc: WebContents, code: number, description: string, url: string, isMainFrame: boolean, pid: number, rid: number): void {
  const key = `${wc.id}:${pid}:${rid}:${code}:${url}`
  const now = Date.now()
  if ((recentFailures.get(key) ?? 0) > now - 2000) return
  recentFailures.set(key, now)
  if (recentFailures.size > 200) for (const [k, t] of recentFailures) if (t < now - 2000) recentFailures.delete(k)
  let frame = frameFromIds(wc, pid, rid, isMainFrame)
  if (!frame) {
    // The frame that failed may be gone; find the one that was navigating there.
    const states = framesByPage.get(wc.id)
    const nodeId = states && [...states].find(([, s]) => s.pending?.url === url)?.[0]
    frame = nodeId !== undefined ? (wc.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === nodeId) ?? null) : null
  }
  if (!frame) return
  const state = stateOf(wc, frame)
  state.errorOccurred = true
  state.pending = undefined
  const tabId = tabIdOf(wc)
  if (tabId === null || !listening('onErrorOccurred')) return
  const error = description.startsWith('net::') ? description : `net::${description || `ERR_FAILED (${code})`}`
  send('onErrorOccurred', { ...frameDetails(wc, tabId, frame, url, true), error })
}

function watchFrame(wc: WebContents, frame: WebFrameMain | null | undefined): void {
  if (!alive(frame) || watchedFrames.has(frame)) return
  watchedFrames.add(frame)
  frame.on('dom-ready', () => {
    if (!alive(frame) || wc.isDestroyed() || !listening('onDOMContentLoaded')) return
    const tabId = tabIdOf(wc)
    if (tabId === null) return
    send('onDOMContentLoaded', frameDetails(wc, tabId, frame, frame.url, true))
  })
}

function watch(wc: WebContents): void {
  if (watched.has(wc) || wc.isDestroyed()) return
  watched.add(wc)
  const id = wc.id

  wc.on('frame-created', (_e, { frame }) => watchFrame(wc, frame))
  watchFrame(wc, wc.mainFrame)
  for (const frame of wc.mainFrame.framesInSubtree) watchFrame(wc, frame)

  wc.on('did-start-navigation', (details) => {
    const { url, isSameDocument, frame, initiator } = details
    if (isSameDocument || !alive(frame)) return
    watchFrame(wc, frame)
    const state = stateOf(wc, frame)
    state.pending = { url, redirected: false, rendererInitiated: !!initiator }
    if (!listening('onBeforeNavigate')) return
    const tabId = tabIdOf(wc)
    if (tabId === null) return
    // Before the new document exists: processId is -1 and there's no documentId yet.
    send('onBeforeNavigate', { ...frameDetails(wc, tabId, frame, url, false), processId: -1 })
  })

  wc.on('did-redirect-navigation', (details) => {
    if (details.isSameDocument || !alive(details.frame)) return
    const state = stateOf(wc, details.frame)
    state.pending = { url: details.url, redirected: true, rendererInitiated: state.pending?.rendererInitiated ?? !!details.initiator }
  })

  wc.on('did-frame-navigate', (_e, url, _code, _status, isMainFrame, pid, rid) => {
    const frame = frameFromIds(wc, pid, rid, isMainFrame)
    if (!frame) return
    watchFrame(wc, frame)
    const state = stateOf(wc, frame)
    const [transitionType, transitionQualifiers] = transitionOf(wc, frame, state, url)
    state.documentId = newDocumentId()
    state.url = url
    state.errorOccurred = false
    state.committed = true
    state.pending = undefined
    if (!listening('onCommitted')) return
    const tabId = tabIdOf(wc)
    if (tabId === null) return
    send('onCommitted', { ...frameDetails(wc, tabId, frame, url, true), transitionType, transitionQualifiers })
  })

  wc.on('did-navigate-in-page', (_e, url, isMainFrame, pid, rid) => {
    const frame = frameFromIds(wc, pid, rid, isMainFrame)
    if (!frame) return
    const state = stateOf(wc, frame)
    const previous = state.url
    state.url = url
    // Only the fragment changed: a jump within the page. Anything else is the History API.
    const event = withoutHash(previous) === withoutHash(url) && previous !== url ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated'
    if (!listening(event)) return
    const tabId = tabIdOf(wc)
    if (tabId === null) return
    const transitionType = frame.parent ? 'manual_subframe' : 'link'
    send(event, { ...frameDetails(wc, tabId, frame, url, true), transitionType, transitionQualifiers: [] })
  })

  wc.on('did-frame-finish-load', (_e, isMainFrame, pid, rid) => {
    if (!listening('onCompleted')) return
    const frame = frameFromIds(wc, pid, rid, isMainFrame)
    const tabId = tabIdOf(wc)
    if (!frame || tabId === null) return
    send('onCompleted', frameDetails(wc, tabId, frame, frame.url, true))
  })

  wc.on('did-fail-provisional-load', (_e, code, description, url, isMainFrame, pid, rid) => reportError(wc, code, description, url, isMainFrame, pid, rid))
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame, pid, rid) => reportError(wc, code, description, url, isMainFrame, pid, rid))

  // Popups the page opens (tabs it opens come through the tab-opened browser event).
  wc.on('did-create-window', (win, details) => {
    watch(win.webContents)
    if (!listening('onCreatedNavigationTarget')) return
    const sourceTabId = tabIdOf(wc)
    if (sourceTabId === null) return
    send('onCreatedNavigationTarget', {
      sourceTabId,
      sourceProcessId: wc.mainFrame.processId,
      sourceFrameId: 0,
      url: details.url,
      tabId: win.webContents.id,
      timeStamp: Date.now()
    })
  })

  wc.once('destroyed', () => {
    framesByPage.delete(id)
    historyPosition.delete(id)
  })
}

// ---- getFrame / getAllFrames ----

function pageForTab(tabId: unknown): WebContents | null {
  if (typeof tabId !== 'number') throw new ExtensionError("Missing required property 'tabId'.")
  const found = findTab(tabId)
  if (found) return found.tab.liveWc
  const wc = webContentsById(tabId)
  return wc && tabIdOf(wc) === tabId ? wc : null
}

function frameInfo(wc: WebContents, frame: WebFrameMain): Record<string, unknown> {
  const state = stateOf(wc, frame)
  const info: Record<string, unknown> = {
    errorOccurred: state.errorOccurred,
    url: frame.url || state.url,
    parentFrameId: parentFrameIdOf(frame),
    documentId: state.documentId,
    frameType: frameTypeOf(frame),
    documentLifecycle: 'active'
  }
  if (frame.parent) info.parentDocumentId = stateOf(wc, frame.parent).documentId
  return info
}

function findByDocumentId(documentId: string): { wc: WebContents; frame: WebFrameMain } | null {
  for (const [wcId, states] of framesByPage) {
    for (const [nodeId, state] of states) {
      if (state.documentId !== documentId) continue
      const wc = webContentsById(wcId)
      const frame = wc?.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === nodeId)
      if (wc && frame) return { wc, frame }
    }
  }
  return null
}

function getFrame(_call: CallContext, details: unknown): Record<string, unknown> | null {
  const d = asObject(details)
  if (typeof d.documentId === 'string') {
    const found = findByDocumentId(d.documentId)
    if (!found) throw new ExtensionError(`No frame with documentId "${d.documentId}".`)
    if (typeof d.tabId === 'number' && tabIdOf(found.wc) !== d.tabId) return null
    return frameInfo(found.wc, found.frame)
  }
  const wc = pageForTab(d.tabId)
  if (!wc || wc.isDestroyed()) return null
  if (typeof d.frameId !== 'number') throw new ExtensionError("Missing required property 'frameId'.")
  const frame = d.frameId === 0 ? wc.mainFrame : wc.mainFrame.framesInSubtree.find((f) => f.parent && f.frameTreeNodeId === d.frameId)
  if (!frame) return null
  return frameInfo(wc, frame)
}

function getAllFrames(_call: CallContext, details: unknown): Record<string, unknown>[] | null {
  const wc = pageForTab(asObject(details).tabId)
  if (!wc || wc.isDestroyed()) return null
  return wc.mainFrame.framesInSubtree.map((frame) => ({ ...frameInfo(wc, frame), processId: frame.processId, frameId: frameIdOf(frame) }))
}

/** A webNavigation document id's frame, for other APIs (scripting, cookies) that take documentIds. */
export function frameForDocumentId(documentId: string): { wc: WebContents; frame: WebFrameMain; tabId: number | null } | null {
  const found = findByDocumentId(documentId)
  return found ? { ...found, tabId: tabIdOf(found.wc) } : null
}

/** The document id of a frame, as webNavigation reports it. */
export function documentIdOf(wc: WebContents, frame: WebFrameMain): string {
  return stateOf(wc, frame).documentId
}

defineApi('webNavigation', {
  permissions: ['webNavigation'],
  methods: { getFrame, getAllFrames }
})

const urlMatches = (filter: { url?: UrlFilter[] }, args: unknown[]): boolean => {
  const url = (args[0] as { url?: unknown } | undefined)?.url
  return typeof url === 'string' && matchesUrlFilters(url, filter?.url)
}

for (const name of [
  'onBeforeNavigate',
  'onCommitted',
  'onDOMContentLoaded',
  'onCompleted',
  'onErrorOccurred',
  'onCreatedNavigationTarget',
  'onReferenceFragmentUpdated',
  'onHistoryStateUpdated'
]) {
  defineEvent(`webNavigation.${name}`, { permissions: ['webNavigation'], matches: urlMatches })
}
defineEvent('webNavigation.onTabReplaced', { permissions: ['webNavigation'] })

// ---- wiring ----

/** The page id each sleeping tab had, so waking it up can be reported as a replacement. */
const previousPage = new WeakMap<Tab, number>()

lifecycle.on('ready', (session) => {
  ses = session
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session === ses) watch(wc)
  })
})

browserEvents.on('tab-webcontents-created', (tab, wc) => {
  watch(wc)
  const previous = previousPage.get(tab)
  if (previous !== undefined && previous !== wc.id && listening('onTabReplaced')) {
    send('onTabReplaced', { replacedTabId: previous, tabId: wc.id, timeStamp: Date.now() })
  }
})

browserEvents.on('tab-webcontents-destroyed', (tab, wc) => {
  previousPage.set(tab, wc.id)
})

// Tabs a page opened (links with a target, window.open without features). Emitted by window.ts
// as `tab-opened` (tab, opener, url) once it's wired up; see the report for the needed change.
;(browserEvents as unknown as EventEmitter).on('tab-opened', (tab: Tab, opener: Tab, url: string) => {
  if (!listening('onCreatedNavigationTarget')) return
  const source = opener.liveWc
  send('onCreatedNavigationTarget', {
    sourceTabId: chromeTabId(opener),
    sourceProcessId: source && !source.isDestroyed() ? source.mainFrame.processId : -1,
    sourceFrameId: 0,
    url,
    tabId: chromeTabId(tab),
    timeStamp: Date.now()
  })
})
