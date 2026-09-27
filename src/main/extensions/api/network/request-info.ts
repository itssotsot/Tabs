import { app, webContents as webContentsModule, type Session, type WebContents, type WebFrameMain } from 'electron'
import { INTERNAL_SCHEME } from '@shared/url'
import { extraWindowForWebContents, tabForWebContents, chromeTabId } from '../../tabs-model'
import type { ResourceType } from './dnr-rules'

/**
 * What declarativeNetRequest and webRequest need to know about a request that Electron's
 * webRequest details don't say directly: Chrome's resource type, tab and frame ids, the
 * initiator (from the requesting frame, the navigation that started it, or the referrer), and
 * whether extensions may see the request at all.
 */

/** Fields every Electron webRequest details object has. */
export interface ElectronDetails {
  id: number
  url: string
  method: string
  webContentsId?: number
  frame?: WebFrameMain | null
  resourceType: string
  referrer: string
  timestamp: number
}

export interface NetRequest {
  readonly requestId: string
  /** Current URL (changes on redirects), without the fragment. */
  url: string
  readonly method: string
  readonly type: ResourceType
  readonly tabId: number
  readonly windowId: number
  readonly webContentsId: number | undefined
  readonly frameId: number
  readonly parentFrameId: number
  readonly frameType: 'outermost_frame' | 'sub_frame'
  readonly documentId: string | undefined
  readonly parentDocumentId: string | undefined
  /** Origin of whoever started the request ('null' when opaque); undefined for browser-initiated navigations. */
  readonly initiator: string | undefined
  /** The top-level frame's URL (for main-frame requests, their own URL). */
  topUrl: string | undefined
  /** Extensions may not see it: internal pages, the Web Store, the browser's own requests. */
  readonly hidden: boolean
  /** Started by this extension; other extensions don't see it. */
  readonly initiatorExtension: string | null
  /** Keys of the frames it comes from, innermost first, for allowAllRequests. */
  readonly frameChain: string[]
}

const TYPE_MAP: Record<string, ResourceType> = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
}

/** Schemes extension network APIs act on. */
const VISIBLE_SCHEME = /^(https?|wss?):\/\//i

/** Pages extensions never see requests to, like in Chrome (the Web Store and extension updates). */
function isSensitiveUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return true
  }
  const host = u.hostname
  if (host === 'chromewebstore.google.com') return true
  if (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true
  if ((host === 'clients2.google.com' || host === 'update.googleapis.com') && u.pathname.startsWith('/service/update2')) return true
  if (host === 'clients2.googleusercontent.com' && u.pathname.startsWith('/crx/')) return true
  return false
}

export function stripFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash >= 0 ? url.slice(0, hash) : url
}

/** Serialized origin of a URL; 'null' for opaque ones (data:, about:…). Works for chrome-extension:// too. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (!u.host && u.protocol !== 'file:') return 'null'
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
}

function frameAlive(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  try {
    return !!frame && !frame.isDestroyed() && !frame.detached
  } catch {
    return false
  }
}

/** Chrome's frame id: 0 for a tab's main frame, else a unique positive number. Matches runtime.getContexts. */
export function frameIdOf(frame: WebFrameMain): number {
  return frame.parent ? frame.frameTreeNodeId : 0
}

/** Same document id scheme as runtime.getContexts. */
export function documentIdOf(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}`
}

function frameKey(frame: WebFrameMain, webContentsId: number | undefined): string {
  return frame.parent ? `f:${frame.frameTreeNodeId}` : `m:${webContentsId ?? frame.frameTreeNodeId}`
}

// ---- navigations: who started them ----

interface FrameInfo {
  frameId: number
  parentFrameId: number
  parentDocumentId: string | undefined
  /** Keys of the navigated frame's ancestors, innermost first. */
  chain: string[]
  topUrl: string | undefined
}

interface NavigationRecord {
  url: string
  initiator: string | undefined
  /** Subframes: the frame being navigated. */
  frame?: FrameInfo
}

/** Latest main-frame navigation per page (by webContents id). */
const mainNavigations = new Map<number, NavigationRecord>()
/** Subframe navigations in progress, by `<webContentsId>|<url>` and by frame. */
const subNavigations = new Map<string, NavigationRecord>()
const subNavigationsByFrame = new Map<number, string>()
const navigatedListeners = new Set<(webContentsId: number) => void>()
const goneListeners = new Set<(webContentsId: number) => void>()

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value as K)
}

function frameOrigin(frame: WebFrameMain | null | undefined): string | undefined {
  try {
    return frameAlive(frame) ? frame.origin : undefined
  } catch {
    return undefined
  }
}

function frameInfo(frame: WebFrameMain, webContentsId: number): FrameInfo {
  const parent = frame.parent
  const chain: string[] = []
  for (let f = parent; f; f = f.parent) chain.push(frameKey(f, webContentsId))
  return {
    frameId: frameIdOf(frame),
    parentFrameId: parent ? frameIdOf(parent) : -1,
    parentDocumentId: parent ? documentIdOf(parent) : undefined,
    chain,
    topUrl: frame.top?.url
  }
}

function watchWebContents(wc: WebContents): void {
  const id = wc.id
  // Electron tells us which frame navigates and who started it, before the request goes out.
  wc.on('did-start-navigation', (details) => {
    if (details.isSameDocument) return
    const url = stripFragment(details.url)
    const initiator = frameOrigin(details.initiator)
    if (details.isMainFrame) {
      remember(mainNavigations, id, { url, initiator }, 500)
      return
    }
    const frame = details.frame
    if (!frameAlive(frame)) return
    try {
      const record: NavigationRecord = { url, initiator, frame: frameInfo(frame, id) }
      const old = subNavigationsByFrame.get(frame.frameTreeNodeId)
      if (old) subNavigations.delete(old)
      remember(subNavigations, `${id}|${url}`, record, 1000)
      remember(subNavigationsByFrame, frame.frameTreeNodeId, `${id}|${url}`, 1000)
    } catch {
      // The frame went away meanwhile.
    }
  })
  wc.on('did-redirect-navigation', (details) => {
    const url = stripFragment(details.url)
    if (details.isMainFrame) {
      const record = mainNavigations.get(id)
      if (record) record.url = url
      return
    }
    try {
      const frameId = details.frame?.frameTreeNodeId
      const key = frameId === undefined ? undefined : subNavigationsByFrame.get(frameId)
      const record = key ? subNavigations.get(key) : undefined
      if (!record || frameId === undefined) return
      subNavigations.delete(key!)
      record.url = url
      remember(subNavigations, `${id}|${url}`, record, 1000)
      subNavigationsByFrame.set(frameId, `${id}|${url}`)
    } catch {
      // The frame went away meanwhile.
    }
  })
  wc.on('did-navigate', () => {
    for (const listener of navigatedListeners) listener(id)
  })
  wc.once('destroyed', () => {
    mainNavigations.delete(id)
    tabInfoCache.delete(id)
    for (const listener of goneListeners) listener(id)
  })
}

/** A tab's (or other page's) main frame committed a new document. */
export function onDocumentCommitted(listener: (webContentsId: number) => void): void {
  navigatedListeners.add(listener)
}

export function onWebContentsGone(listener: (webContentsId: number) => void): void {
  goneListeners.add(listener)
}

let watching = false

/** Starts following navigations on the web session's pages. Runs once. */
export function watchNavigations(ses: Session): void {
  if (watching) return
  watching = true
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session === ses) watchWebContents(wc)
  })
  for (const wc of webContentsModule.getAllWebContents()) if (wc.session === ses) watchWebContents(wc)
}

// ---- tabs ----

const tabInfoCache = new Map<number, { tabId: number; windowId: number; at: number }>()

/** The Chrome tab and window a page is in; -1s for pages that aren't tabs (popups, background pages…). */
export function tabInfo(webContentsId: number | undefined): { tabId: number; windowId: number } {
  if (webContentsId === undefined) return { tabId: -1, windowId: -1 }
  const now = Date.now()
  const cached = tabInfoCache.get(webContentsId)
  if (cached && now - cached.at < 1000) return cached
  let info = { tabId: -1, windowId: -1, at: now }
  const wc = webContentsModule.fromId(webContentsId)
  if (wc && !wc.isDestroyed()) {
    const found = tabForWebContents(wc)
    if (found) info = { tabId: chromeTabId(found.tab), windowId: found.controller.win.id, at: now }
    else {
      const extra = extraWindowForWebContents(wc)
      if (extra) info = { tabId: wc.id, windowId: extra.win.id, at: now }
    }
  }
  remember(tabInfoCache, webContentsId, info, 500)
  return info
}

// ---- requests ----

const requests = new Map<number, NetRequest>()

/** Forget a finished request. */
export function forgetRequest(id: number): void {
  requests.delete(id)
}

/**
 * Chrome's view of an Electron webRequest request, or null for schemes extensions don't see.
 * Computed once per request and kept across its stages (and redirects), since the frame may be
 * gone by the time the response arrives.
 */
export function describeRequest(details: ElectronDetails): NetRequest | null {
  const url = stripFragment(details.url)
  const cached = requests.get(details.id)
  if (cached) {
    if (cached.url !== url) {
      if (!VISIBLE_SCHEME.test(url)) return null
      cached.url = url
      if (cached.type === 'main_frame') cached.topUrl = url
    }
    return cached
  }
  if (!VISIBLE_SCHEME.test(url)) return null
  const request = build(details, url)
  remember(requests, details.id, request, 4096)
  return request
}

function build(details: ElectronDetails, url: string): NetRequest {
  const type = TYPE_MAP[details.resourceType] ?? 'other'
  const wcId = details.webContentsId
  const { tabId, windowId } = tabInfo(wcId)
  let frame: WebFrameMain | null = null
  try {
    frame = frameAlive(details.frame) ? details.frame : null
  } catch {
    frame = null
  }
  const referrerOrigin = details.referrer ? originOf(details.referrer) : undefined
  let frameId = -1
  let parentFrameId = -1
  let frameType: 'outermost_frame' | 'sub_frame' = 'outermost_frame'
  let documentId: string | undefined
  let parentDocumentId: string | undefined
  let initiator: string | undefined
  let topUrl: string | undefined
  const frameChain: string[] = []
  const chainFrom = (start: WebFrameMain | null): void => {
    for (let f: WebFrameMain | null = start; f; f = f.parent) frameChain.push(frameKey(f, wcId))
  }
  try {
    if (type === 'main_frame') {
      frameId = 0
      topUrl = url
      const nav = wcId === undefined ? undefined : mainNavigations.get(wcId)
      initiator = nav && nav.url === url ? nav.initiator : referrerOrigin
    } else if (type === 'sub_frame') {
      frameType = 'sub_frame'
      const nav = subNavigations.get(`${wcId}|${url}`)
      if (nav?.frame) {
        ;({ frameId, parentFrameId, parentDocumentId, topUrl } = nav.frame)
        frameChain.push(...nav.frame.chain)
        initiator = nav.initiator ?? referrerOrigin
      } else {
        // Assume Electron reports the frame being navigated.
        const parent = frame?.parent ?? null
        if (frame) frameId = frameIdOf(frame)
        if (parent) {
          parentFrameId = frameIdOf(parent)
          parentDocumentId = documentIdOf(parent)
        }
        initiator = referrerOrigin ?? frameOrigin(parent)
        topUrl = frame?.top?.url
        chainFrom(parent)
      }
    } else if (frame) {
      frameId = frameIdOf(frame)
      documentId = documentIdOf(frame)
      const parent = frame.parent
      if (parent) {
        frameType = 'sub_frame'
        parentFrameId = frameIdOf(parent)
        parentDocumentId = documentIdOf(parent)
      }
      initiator = frame.origin || referrerOrigin
      topUrl = frame.top?.url
      chainFrom(frame)
    } else {
      // Workers, or a frame that's already gone.
      initiator = referrerOrigin
    }
  } catch {
    initiator ??= referrerOrigin
  }
  const initiatorExtension = initiator?.startsWith('chrome-extension://') ? initiator.slice('chrome-extension://'.length) : null
  const browserInitiated = wcId === undefined && !frame && !details.referrer
  const hidden =
    isSensitiveUrl(url) ||
    (initiator !== undefined && initiator.startsWith(`${INTERNAL_SCHEME}:`)) ||
    (browserInitiated && type !== 'main_frame' && type !== 'sub_frame')
  return {
    requestId: String(details.id),
    url,
    method: details.method,
    type,
    tabId,
    windowId,
    webContentsId: wcId,
    frameId,
    parentFrameId,
    frameType,
    documentId,
    parentDocumentId,
    initiator,
    topUrl,
    hidden,
    initiatorExtension,
    frameChain
  }
}
