import { app, type Session, type UploadData, type WebContents } from 'electron'
import { addBlockingHandler, addObserver, removeHandler, type ObserverStage } from '../../../web-request-hub'
import { hasApiPermission, hasHostAccess } from '../../access'
import { lifecycle } from '../../lifecycle'
import { matchesAny } from '../../match-pattern'
import { defineApi, defineEvent, emit, emitForResponse, ExtensionError, listeningExtensions } from '../../router'
import { describeRequest, forgetRequest, stripFragment, tabInfo, type ElectronDetails, type NetRequest } from './request-info'

/**
 * chrome.webRequest for Manifest V3: observing requests at every stage. Electron's own
 * chrome.webRequest events never fire, so we emit them from the web-request hub. Listeners can't
 * block or change requests ('blocking' is only honored for policy-installed extensions in MV3);
 * the one exception, like in Chrome, is onAuthRequired answering an auth challenge for
 * extensions with the webRequestAuthProvider permission.
 *
 * Nothing is computed unless an extension listens: the stages check a cached list of listening
 * extensions, and the observe-only stages are only hooked up while someone listens to them.
 */

const EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onAuthRequired',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
] as const
type EventName = (typeof EVENTS)[number]

const OBSERVED: Record<ObserverStage, EventName> = {
  onSendHeaders: 'onSendHeaders',
  onResponseStarted: 'onResponseStarted',
  onBeforeRedirect: 'onBeforeRedirect',
  onCompleted: 'onCompleted',
  onErrorOccurred: 'onErrorOccurred'
}

const HANDLER_ID = 'webRequest'
let ses: Session | null = null

// ---- who listens ----

const listening = new Map<EventName, string[]>()
let listeningAt = 0
let observing = false

/** Extensions listening for an event, refreshed at most once a second (or when a listener is added). */
function listeners(name: EventName): string[] {
  const now = Date.now()
  if (now - listeningAt > 1000) {
    listeningAt = now
    for (const e of EVENTS) listening.set(e, listeningExtensions(`webRequest.${e}`))
    syncObservers()
  }
  return listening.get(name) ?? []
}

/** Hooks the observe-only stages up while anyone listens to them. */
function syncObservers(): void {
  if (!ses) return
  const needed = Object.values(OBSERVED).some((e) => listening.get(e)?.length)
  if (needed === observing) return
  observing = needed
  for (const stage of Object.keys(OBSERVED) as ObserverStage[]) {
    if (!needed) {
      removeHandler(ses, stage, HANDLER_ID)
      continue
    }
    addObserver(ses, stage, {
      id: HANDLER_ID,
      handle: (details) => observe(stage, details as unknown as ObservedDetails)
    })
  }
}

// ---- details ----

interface Meta {
  req: NetRequest
  stage: EventName
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[] | string>
  uploadData?: UploadData[]
}

/** The Electron data behind each details object we send, for filling in what listeners ask for. */
const metaOf = new WeakMap<object, Meta>()

function baseDetails(req: NetRequest, timeStamp: number): Record<string, unknown> {
  const d: Record<string, unknown> = {
    requestId: req.requestId,
    url: req.url,
    method: req.method,
    frameId: req.frameId,
    parentFrameId: req.parentFrameId,
    tabId: req.tabId,
    type: req.type,
    timeStamp,
    frameType: req.frameType,
    documentLifecycle: 'active'
  }
  if (req.initiator !== undefined) d.initiator = req.initiator
  if (req.documentId) d.documentId = req.documentId
  if (req.parentDocumentId) d.parentDocumentId = req.parentDocumentId
  return d
}

function httpHeaders(headers: Record<string, string | string[]>): chrome.webRequest.HttpHeader[] {
  const out: chrome.webRequest.HttpHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) out.push({ name, value: v })
    else out.push({ name, value })
  }
  return out
}

const MAX_FORM_BYTES = 1 << 20

/** requestBody: parsed form fields when the body is a form, else the raw bytes and files. */
function requestBody(uploadData: UploadData[] | undefined): chrome.webRequest.OnBeforeRequestDetails['requestBody'] | undefined {
  if (!uploadData?.length) return undefined
  if (uploadData.length === 1 && uploadData[0].bytes && uploadData[0].bytes.length <= MAX_FORM_BYTES) {
    const text = uploadData[0].bytes.toString('utf8')
    const form = parseUrlEncoded(text) ?? parseMultipart(text)
    if (form) return { formData: form }
  }
  const raw: chrome.webRequest.UploadData[] = []
  for (const part of uploadData) {
    if (part.bytes) raw.push({ bytes: Uint8Array.prototype.slice.call(part.bytes).buffer as ArrayBuffer })
    else if (part.file) raw.push({ file: part.file })
  }
  return raw.length ? { raw } : undefined
}

const URLENCODED = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*$/

function parseUrlEncoded(text: string): Record<string, string[]> | null {
  if (!URLENCODED.test(text)) return null
  const out: Record<string, string[]> = {}
  for (const [key, value] of new URLSearchParams(text)) (out[key] ??= []).push(value)
  return out
}

function parseMultipart(text: string): Record<string, string[]> | null {
  const firstLine = /^--([^\r\n]+)\r\n/.exec(text)
  if (!firstLine || !/content-disposition:\s*form-data/i.test(text)) return null
  const out: Record<string, string[]> = {}
  for (const part of text.split(`--${firstLine[1]}`)) {
    const split = part.indexOf('\r\n\r\n')
    if (split < 0) continue
    const head = part.slice(0, split)
    const name = /name="([^"]*)"/i.exec(head)?.[1]
    if (name === undefined) continue
    const file = /filename="([^"]*)"/i.exec(head)?.[1]
    ;(out[name] ??= []).push(file ?? part.slice(split + 4).replace(/\r\n$/, ''))
  }
  return Object.keys(out).length ? out : null
}

/** Adds the parts a listener asked for in extraInfoSpec, once per details object. */
function addExtras(d: Record<string, unknown>, meta: Meta, spec: unknown[]): void {
  if (spec.includes('requestHeaders') && meta.requestHeaders && !('requestHeaders' in d)) d.requestHeaders = httpHeaders(meta.requestHeaders)
  if (spec.includes('responseHeaders') && meta.responseHeaders && !('responseHeaders' in d)) d.responseHeaders = httpHeaders(meta.responseHeaders)
  if (spec.includes('requestBody') && meta.stage === 'onBeforeRequest' && !('requestBody' in d)) {
    const body = requestBody(meta.uploadData)
    if (body) d.requestBody = body
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** RequestFilter matching: urls, types, tabId, windowId. */
function matchesFilter(filter: unknown, args: unknown[]): boolean {
  const d = args[0] as Record<string, unknown>
  const meta = d && typeof d === 'object' ? metaOf.get(d) : undefined
  if (!meta || !isObject(filter)) return false
  if (!Array.isArray(filter.urls) || !matchesAny(filter.urls as string[], meta.req.url)) return false
  if (Array.isArray(filter.types) && !filter.types.includes(d.type)) return false
  if (typeof filter.tabId === 'number' && filter.tabId !== meta.req.tabId) return false
  if (typeof filter.windowId === 'number' && filter.windowId !== meta.req.windowId) return false
  if (Array.isArray(filter.__extra)) addExtras(d, meta, filter.__extra)
  return true
}

/** Whether the extension may see this request: its host permissions cover the URL, and another extension didn't make it. */
function canSee(extensionId: string, req: NetRequest): boolean {
  if (req.initiatorExtension && req.initiatorExtension !== extensionId) return false
  return hasHostAccess(extensionId, req.url, req.tabId >= 0 ? req.tabId : undefined)
}

function dispatch(name: EventName, details: ElectronDetails, fill?: (d: Record<string, unknown>) => void, extra?: Partial<Meta>): void {
  const ids = listeners(name)
  if (!ids.length) return
  const req = describeRequest(details)
  if (!req || req.hidden) return
  const base = baseDetails(req, details.timestamp || Date.now())
  fill?.(base)
  emit(`webRequest.${name}`, (extensionId) => {
    if (!ids.includes(extensionId) || !canSee(extensionId, req)) return null
    const d = { ...base }
    metaOf.set(d, { req, stage: name, ...extra })
    return [d]
  })
}

// ---- stages ----

type ObservedDetails = ElectronDetails & {
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  ip?: string
  redirectURL?: string
  error?: string
}

function responseFields(details: ObservedDetails): (d: Record<string, unknown>) => void {
  return (d) => {
    d.statusCode = details.statusCode ?? 0
    d.statusLine = details.statusLine ?? ''
    d.fromCache = !!details.fromCache
    if (details.ip) d.ip = details.ip
  }
}

function observe(stage: ObserverStage, details: ObservedDetails): void {
  switch (stage) {
    case 'onSendHeaders':
      dispatch('onSendHeaders', details, undefined, { requestHeaders: details.requestHeaders })
      break
    case 'onResponseStarted':
      dispatch('onResponseStarted', details, responseFields(details), { responseHeaders: details.responseHeaders })
      break
    case 'onBeforeRedirect':
      dispatch(
        'onBeforeRedirect',
        details,
        (d) => {
          responseFields(details)(d)
          d.redirectUrl = details.redirectURL
        },
        { responseHeaders: details.responseHeaders }
      )
      break
    case 'onCompleted':
      dispatch('onCompleted', details, responseFields(details), { responseHeaders: details.responseHeaders })
      forgetRequest(details.id)
      break
    case 'onErrorOccurred':
      dispatch('onErrorOccurred', details, (d) => {
        d.error = details.error ?? 'net::ERR_FAILED'
        d.fromCache = !!details.fromCache
        if (details.ip) d.ip = details.ip
      })
      forgetRequest(details.id)
      break
  }
}

// ---- auth challenges ----

interface Challenge {
  req: NetRequest
  statusCode: number
  statusLine: string
}

/** Recent 401/407 responses by URL, so onAuthRequired can name the request that got them. */
const challenges = new Map<string, Challenge>()
let authCounter = 0

function rememberChallenge(details: ObservedDetails): void {
  if ((details.statusCode !== 401 && details.statusCode !== 407) || !listeners('onAuthRequired').length) return
  const req = describeRequest(details)
  if (!req) return
  challenges.delete(req.url)
  challenges.set(req.url, { req, statusCode: details.statusCode, statusLine: details.statusLine ?? '' })
  if (challenges.size > 50) challenges.delete(challenges.keys().next().value as string)
}

function pseudoRequest(url: string, wc: WebContents | null, navigation: boolean): NetRequest {
  const { tabId, windowId } = tabInfo(wc && !wc.isDestroyed() ? wc.id : undefined)
  return {
    requestId: `auth-${++authCounter}`,
    url,
    method: 'GET',
    type: navigation ? 'main_frame' : 'other',
    tabId,
    windowId,
    webContentsId: wc?.id,
    frameId: navigation ? 0 : -1,
    parentFrameId: -1,
    frameType: 'outermost_frame',
    documentId: undefined,
    parentDocumentId: undefined,
    initiator: undefined,
    topUrl: navigation ? url : undefined,
    hidden: false,
    initiatorExtension: null,
    frameChain: []
  }
}

/**
 * onAuthRequired, from Electron's login event. Everyone listening hears about it; extensions
 * with webRequestAuthProvider can answer, one after another. Without an answer the
 * request goes on without credentials, which is what Electron does anyway.
 */
function onLogin(
  event: Electron.Event,
  wc: WebContents | null,
  auth: Electron.AuthenticationResponseDetails,
  info: Electron.AuthInfo,
  callback: (username?: string, password?: string) => void
): void {
  if (!ses || (wc && wc.session !== ses)) return
  const ids = listeners('onAuthRequired')
  if (!ids.length) return
  const url = stripFragment(auth.url)
  const challenge = challenges.get(url)
  challenges.delete(url)
  const req = challenge?.req ?? pseudoRequest(url, wc, auth.isRequestForNavigation)
  if (req.hidden) return
  const base = baseDetails(req, Date.now())
  base.challenger = { host: info.host, port: info.port }
  base.isProxy = info.isProxy
  base.scheme = info.scheme
  if (info.realm) base.realm = info.realm
  base.statusCode = challenge?.statusCode ?? (info.isProxy ? 407 : 401)
  base.statusLine = challenge?.statusLine ?? ''
  const eligible = ids.filter((id) => canSee(id, req))
  const providers = eligible.filter((id) => hasApiPermission(id, 'webRequestAuthProvider'))
  const detailsFor = (): Record<string, unknown> => {
    const d = { ...base }
    metaOf.set(d, { req, stage: 'onAuthRequired', responseHeaders: auth.responseHeaders })
    return d
  }
  emit('webRequest.onAuthRequired', (extensionId) => (eligible.includes(extensionId) && !providers.includes(extensionId) ? [detailsFor()] : null))
  if (!providers.length) return
  event.preventDefault()
  void (async () => {
    for (const extensionId of providers) {
      const response = (await emitForResponse(extensionId, 'webRequest.onAuthRequired', [detailsFor()]).catch(() => undefined)) as
        | chrome.webRequest.BlockingResponse
        | undefined
      if (!response || typeof response !== 'object') continue
      if (response.cancel) return callback()
      const creds = response.authCredentials
      if (creds && typeof creds.username === 'string' && typeof creds.password === 'string') return callback(creds.username, creds.password)
    }
    callback()
  })()
}

// ---- API ----

const behaviorChangedCalls = new Map<string, number[]>()

defineApi('webRequest', {
  permissions: ['webRequest'],
  methods: {
    /** Chrome flushes its in-memory cache here; we have none, but the quota is Chrome's. */
    handlerBehaviorChanged(call) {
      const now = Date.now()
      const recent = (behaviorChangedCalls.get(call.extensionId) ?? []).filter((t) => now - t < 10 * 60_000)
      if (recent.length >= 20) throw new ExtensionError('This request exceeds the MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES quota.')
      recent.push(now)
      behaviorChangedCalls.set(call.extensionId, recent)
    },
    /** Internal: a listener was added, so start watching right away rather than within a second. */
    listenersChanged() {
      listeningAt = 0
      listeners('onBeforeRequest')
    }
  }
})

for (const name of EVENTS) defineEvent(`webRequest.${name}`, { permissions: ['webRequest'], matches: matchesFilter })
// Fired in the extension itself when it returns a blocking response we can't honor.
defineEvent('webRequest.onActionIgnored', { permissions: ['webRequest'] })

lifecycle.on('ready', (session) => {
  ses = session
  addBlockingHandler(session, 'onBeforeRequest', {
    id: HANDLER_ID,
    // After declarativeNetRequest (50): requests it blocks or redirects never get here, like in Chrome.
    order: 60,
    handle: (details) => dispatch('onBeforeRequest', details, undefined, { uploadData: details.uploadData })
  })
  addBlockingHandler(session, 'onBeforeSendHeaders', {
    id: HANDLER_ID,
    order: 60,
    handle: (details) => dispatch('onBeforeSendHeaders', details, undefined, { requestHeaders: details.requestHeaders })
  })
  addBlockingHandler(session, 'onHeadersReceived', {
    id: HANDLER_ID,
    // Before declarativeNetRequest's header changes: listeners see what the server sent.
    order: 40,
    handle: (details) => {
      const d = details as unknown as ObservedDetails
      rememberChallenge(d)
      dispatch(
        'onHeadersReceived',
        d,
        (x) => {
          x.statusCode = d.statusCode
          x.statusLine = d.statusLine ?? ''
        },
        { responseHeaders: d.responseHeaders }
      )
    }
  })
  app.on('login', onLogin)
})
