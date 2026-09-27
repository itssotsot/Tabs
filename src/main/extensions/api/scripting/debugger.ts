import type { WebContents } from 'electron'
import { reapplyIdentity } from '../../../identity'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { allTabs, findTab } from '../../tabs-model'
import { childTargets, send, track, isTracked } from './cdp'
import { isObject, mayUsePageApi } from './targets'

/**
 * chrome.debugger on top of the attachment every tab page already has (identity.ts). Attaching
 * means: this extension's commands go to the page and the page's events come back to it. One
 * extension per tab at a time.
 *
 * Because the attachment is shared, the app's own use is protected:
 * - Target.setAutoAttach is emulated (identity.ts keeps auto-attach on): the extension is told about
 *   existing and new child sessions, whose events it then gets.
 * - Runtime.runIfWaitingForDebugger is left to identity.ts, which resumes auto-attached targets.
 * - Page.setWebLifecycleState (the tab freezer's) and browser-level commands are refused.
 * - On detach, domains the extension enabled are disabled and common overrides are cleared, as if
 *   its session had ended, and the browser identity (user agent) is applied again.
 */

type Debuggee = { tabId?: number; targetId?: string; extensionId?: string }

interface Attachment {
  readonly extensionId: string
  readonly wc: WebContents
  readonly tabId: number
  readonly targetId: string
  /** How the extension named the target (tabId or targetId), for events. */
  readonly source: Debuggee
  /** Domains the extension used, per session ('' = the page): their events are forwarded. */
  readonly domains: Set<string>
  /** `${session}|${domain}` the extension enabled, to disable on detach. */
  readonly enabled: Set<string>
  /** Sessions whose children the extension asked to auto-attach ('' = the page). */
  readonly autoAttach: Set<string>
  /** Child sessions the extension knows about. */
  readonly known: Set<string>
  /** Sessions the extension created with Target.attachToTarget. */
  readonly own: Set<string>
  readonly pendingAttach: Set<string>
  readonly scripts: { session: string; identifier: string }[]
  readonly bindings: Set<string>
  /** Resets for overrides it set: `${session}|${method}` -> [reset method, params]. */
  readonly resets: Map<string, [string, Record<string, unknown>]>
  discover: boolean
  userAgent: boolean
  readonly cleanup: (() => void)[]
}

const attachments = new Map<number, Attachment>()
const targetIds = new WeakMap<WebContents, string>()

const PROTOCOL_ERROR = -32000

const protocolError = (message: string, code = PROTOCOL_ERROR): ExtensionError => new ExtensionError(JSON.stringify({ code, message }))

/** Commands an extension may not send on the shared attachment. */
const REFUSED = new Set([
  'Page.setWebLifecycleState',
  'Target.attachToBrowserTarget',
  'Target.exposeDevToolsProtocol',
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
  'Target.setRemoteLocations'
])
const REFUSED_DOMAINS = new Set(['Browser', 'SystemInfo', 'Tethering'])

/** How to undo an override when the extension's "session" ends. */
const RESETS: Record<string, [string, Record<string, unknown>]> = {
  'Emulation.setDeviceMetricsOverride': ['Emulation.clearDeviceMetricsOverride', {}],
  'Emulation.setGeolocationOverride': ['Emulation.clearGeolocationOverride', {}],
  'Emulation.setIdleOverride': ['Emulation.clearIdleOverride', {}],
  'Emulation.setEmulatedMedia': ['Emulation.setEmulatedMedia', { media: '', features: [] }],
  'Emulation.setEmulatedVisionDeficiency': ['Emulation.setEmulatedVisionDeficiency', { type: 'none' }],
  'Emulation.setTouchEmulationEnabled': ['Emulation.setTouchEmulationEnabled', { enabled: false }],
  'Emulation.setEmitTouchEventsForMouse': ['Emulation.setEmitTouchEventsForMouse', { enabled: false }],
  'Emulation.setTimezoneOverride': ['Emulation.setTimezoneOverride', { timezoneId: '' }],
  'Emulation.setLocaleOverride': ['Emulation.setLocaleOverride', {}],
  'Emulation.setCPUThrottlingRate': ['Emulation.setCPUThrottlingRate', { rate: 1 }],
  'Emulation.setScriptExecutionDisabled': ['Emulation.setScriptExecutionDisabled', { value: false }],
  'Emulation.setDefaultBackgroundColorOverride': ['Emulation.setDefaultBackgroundColorOverride', {}],
  'Emulation.setAutoDarkModeOverride': ['Emulation.setAutoDarkModeOverride', {}],
  'Emulation.setFocusEmulationEnabled': ['Emulation.setFocusEmulationEnabled', { enabled: false }],
  'Emulation.setScrollbarsHidden': ['Emulation.setScrollbarsHidden', { hidden: false }],
  'Emulation.setDocumentCookieDisabled': ['Emulation.setDocumentCookieDisabled', { disabled: false }],
  'Network.setExtraHTTPHeaders': ['Network.setExtraHTTPHeaders', { headers: {} }],
  'Network.setBlockedURLs': ['Network.setBlockedURLs', { urls: [] }],
  'Network.setCacheDisabled': ['Network.setCacheDisabled', { cacheDisabled: false }],
  'Network.setBypassServiceWorker': ['Network.setBypassServiceWorker', { bypass: false }],
  'Network.emulateNetworkConditions': ['Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
  'Page.setBypassCSP': ['Page.setBypassCSP', { enabled: false }],
  'Page.setLifecycleEventsEnabled': ['Page.setLifecycleEventsEnabled', { enabled: false }],
  'Page.startScreencast': ['Page.stopScreencast', {}],
  'Overlay.setShowFPSCounter': ['Overlay.setShowFPSCounter', { show: false }],
  'Overlay.setShowPaintRects': ['Overlay.setShowPaintRects', { result: false }]
}

/** Domains without a disable to send. */
const KEEP_ENABLED = new Set(['Target', 'Inspector'])

const sessionKey = (sessionId: string | undefined): string => sessionId ?? ''
const domainOf = (method: string): string => method.split('.')[0]

async function targetIdOf(wc: WebContents): Promise<string> {
  const cached = targetIds.get(wc)
  if (cached) return cached
  const { targetInfo } = await send<{ targetInfo: { targetId: string } }>(wc, 'Target.getTargetInfo')
  targetIds.set(wc, targetInfo.targetId)
  return targetInfo.targetId
}

/** The tab page a Debuggee names. */
async function resolveDebuggee(target: unknown): Promise<{ wc: WebContents; tabId: number; source: Debuggee }> {
  if (!isObject(target)) throw new ExtensionError('Invalid debuggee.')
  if (typeof target.tabId === 'number') {
    const found = findTab(target.tabId)
    const wc = found?.tab.liveWc
    if (!found || !wc || wc.isDestroyed()) throw new ExtensionError(`No tab with given id ${target.tabId}.`)
    return { wc, tabId: target.tabId, source: { tabId: target.tabId } }
  }
  if (typeof target.targetId === 'string') {
    for (const { tab } of allTabs()) {
      const wc = tab.liveWc
      if (!wc || wc.isDestroyed()) continue
      try {
        if ((await targetIdOf(wc)) === target.targetId) return { wc, tabId: wc.id, source: { targetId: target.targetId } }
      } catch {
        // Not attached.
      }
    }
    throw new ExtensionError(`No target with given id ${target.targetId}.`)
  }
  if (typeof target.extensionId === 'string') throw new ExtensionError('Attaching to extension background pages is not supported.')
  throw new ExtensionError('Either tabId, targetId or extensionId must be specified.')
}

function attachmentFor(call: CallContext, target: unknown): Attachment {
  if (isObject(target)) {
    for (const att of attachments.values()) {
      if (att.extensionId !== call.extensionId) continue
      if (typeof target.tabId === 'number' && att.tabId === target.tabId) return att
      if (typeof target.targetId === 'string' && att.targetId === target.targetId) return att
    }
    if (typeof target.tabId === 'number') throw new ExtensionError(`Debugger is not attached to the tab with id: ${target.tabId}.`)
    if (typeof target.targetId === 'string') throw new ExtensionError(`Debugger is not attached to the target with id: ${target.targetId}.`)
  }
  throw new ExtensionError('Invalid debuggee.')
}

const sourceFor = (att: Attachment, sessionId: string | undefined): Debuggee & { sessionId?: string } =>
  sessionId ? { ...att.source, sessionId } : { ...att.source }

function forward(att: Attachment, method: string, params: unknown, sessionId: string | undefined): void {
  emit('debugger.onEvent', [sourceFor(att, sessionId), method, params ?? {}], { extensionId: att.extensionId })
}

/** Whether a page event is one the extension would get on a session of its own. */
function wanted(att: Attachment, method: string, params: any, sessionId: string | undefined): boolean {
  if (sessionId && !att.known.has(sessionId) && !att.own.has(sessionId)) return false
  const domain = domainOf(method)
  if (method === 'Target.attachedToTarget') {
    const child = params?.sessionId
    const ok = att.autoAttach.has(sessionKey(sessionId)) || att.pendingAttach.has(params?.targetInfo?.targetId)
    if (ok && typeof child === 'string') att.known.add(child)
    return ok
  }
  if (method === 'Target.detachedFromTarget') {
    const child = params?.sessionId
    const ok = att.known.has(child) || att.own.has(child)
    att.known.delete(child)
    att.own.delete(child)
    return ok
  }
  if (domain === 'Target') return att.discover || att.autoAttach.size > 0
  if (method === 'Runtime.bindingCalled') return att.bindings.has(`${sessionKey(sessionId)}\n${params?.name}`)
  return att.domains.has(`${sessionKey(sessionId)}|${domain}`)
}

function detachAll(att: Attachment, reason: 'target_closed' | 'canceled_by_user' | null): void {
  if (attachments.get(att.wc.id) !== att) return
  attachments.delete(att.wc.id)
  for (const fn of att.cleanup) fn()
  if (!att.wc.isDestroyed()) void restore(att)
  if (reason) emit('debugger.onDetach', [{ ...att.source }, reason], { extensionId: att.extensionId })
}

/** Undoes what the extension changed on the shared attachment. */
async function restore(att: Attachment): Promise<void> {
  const wc = att.wc
  const sid = (key: string): string | undefined => key.split('|')[0] || undefined
  const jobs: Promise<unknown>[] = []
  const quiet = (p: Promise<unknown>): void => void jobs.push(p.catch(() => {}))
  for (const { session, identifier } of att.scripts) quiet(send(wc, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, session || undefined))
  for (const key of att.bindings) {
    const [session, name] = key.split('\n')
    quiet(send(wc, 'Runtime.removeBinding', { name }, session || undefined))
  }
  for (const [key, [method, params]] of att.resets) quiet(send(wc, method, params, sid(key)))
  for (const key of att.enabled) {
    const domain = key.split('|')[1]
    if (KEEP_ENABLED.has(domain)) continue
    const sessionId = sid(key)
    quiet(send(wc, `${domain}.disable`, {}, sessionId))
  }
  for (const sessionId of att.own) quiet(send(wc, 'Target.detachFromTarget', { sessionId }))
  if (att.discover) quiet(send(wc, 'Target.setDiscoverTargets', { discover: false }))
  await Promise.all(jobs)
  if (att.userAgent) reapplyIdentity(wc)
}


async function attach(call: CallContext, target: unknown, version: unknown): Promise<void> {
  if (typeof version !== 'string' || !/^1\.[0-3]$/.test(version)) throw new ExtensionError(`Requested protocol version is not supported: ${String(version)}.`)
  const { wc, tabId, source } = await resolveDebuggee(target)
  if (!mayUsePageApi(call.extensionId, wc.getURL(), tabId)) throw new ExtensionError(`Cannot access contents of url "${wc.getURL()}".`)
  const label = source.tabId !== undefined ? `tab with id: ${tabId}` : `target with id: ${source.targetId}`
  if (attachments.has(wc.id)) throw new ExtensionError(`Another debugger is already attached to the ${label}.`)
  if (!wc.debugger.isAttached()) throw new ExtensionError(`Cannot attach to the ${label}.`)
  if (!isTracked(wc)) track(wc)
  const targetId = await targetIdOf(wc).catch(() => '')
  if (attachments.has(wc.id)) throw new ExtensionError(`Another debugger is already attached to the ${label}.`)
  const att: Attachment = {
    extensionId: call.extensionId,
    wc,
    tabId,
    targetId,
    source,
    domains: new Set(),
    enabled: new Set(),
    autoAttach: new Set(),
    known: new Set(),
    own: new Set(),
    pendingAttach: new Set(),
    scripts: [],
    bindings: new Set(),
    resets: new Map(),
    discover: false,
    userAgent: false,
    cleanup: []
  }
  const onMessage = (_e: unknown, method: string, params: any, sessionId: string): void => {
    const sid = sessionId || undefined
    if (wanted(att, method, params, sid)) forward(att, method, params, sid)
  }
  const onDestroyed = (): void => detachAll(att, 'target_closed')
  const onDetach = (_e: unknown, reason: string): void => detachAll(att, /target closed|gone|crash/i.test(reason) ? 'target_closed' : 'canceled_by_user')
  // Like Chrome, leaving for a page the extension may not debug ends the session.
  const onNavigate = (_e: unknown, url: string): void => {
    if (!mayUsePageApi(att.extensionId, url, tabId)) detachAll(att, 'target_closed')
  }
  wc.debugger.on('message', onMessage)
  wc.debugger.on('detach', onDetach)
  wc.once('destroyed', onDestroyed)
  wc.on('did-navigate', onNavigate)
  att.cleanup.push(
    () => wc.debugger.off('message', onMessage),
    () => wc.debugger.off('detach', onDetach),
    () => wc.off('destroyed', onDestroyed),
    () => wc.off('did-navigate', onNavigate)
  )
  attachments.set(wc.id, att)
}

/** Tells the extension about a session's existing children, as auto-attach would. */
function announceChildren(att: Attachment, sessionId: string | undefined): void {
  for (const child of childTargets(att.wc)) {
    if (child.parentSessionId !== sessionId || att.known.has(child.sessionId)) continue
    att.known.add(child.sessionId)
    const targetInfo = { targetId: child.targetId, type: child.type, title: child.url, url: child.url, attached: true, canAccessOpener: false }
    forward(att, 'Target.attachedToTarget', { sessionId: child.sessionId, targetInfo, waitingForDebugger: false }, sessionId)
  }
}

function forgetChildren(att: Attachment, sessionId: string | undefined): void {
  for (const child of childTargets(att.wc)) {
    if (child.parentSessionId !== sessionId || !att.known.has(child.sessionId)) continue
    att.known.delete(child.sessionId)
    forward(att, 'Target.detachedFromTarget', { sessionId: child.sessionId, targetId: child.targetId }, sessionId)
  }
}

async function sendCommand(call: CallContext, target: unknown, method: unknown, params: unknown): Promise<unknown> {
  const att = attachmentFor(call, target)
  if (typeof method !== 'string' || !method) throw new ExtensionError('Invalid method.')
  const p = (isObject(params) ? params : {}) as Record<string, any>
  const sessionId = isObject(target) && typeof target.sessionId === 'string' ? target.sessionId : undefined
  if (sessionId && !att.known.has(sessionId) && !att.own.has(sessionId)) throw protocolError(`Session with given id not found.`, -32001)
  const key = sessionKey(sessionId)
  const domain = domainOf(method)
  if (REFUSED.has(method) || REFUSED_DOMAINS.has(domain)) throw protocolError(`${method} is not allowed.`)
  att.domains.add(`${key}|${domain}`)
  const own = !!sessionId && att.own.has(sessionId)

  switch (method) {
    case 'Runtime.runIfWaitingForDebugger':
      // identity.ts resumes auto-attached targets once they're set up.
      if (!own) return {}
      break
    case 'Target.setAutoAttach':
      if (own) break
      if (p.flatten === false) throw protocolError('Only flatten mode is supported.')
      if (p.autoAttach) {
        att.autoAttach.add(key)
        announceChildren(att, sessionId)
      } else {
        att.autoAttach.delete(key)
        forgetChildren(att, sessionId)
      }
      return {}
    case 'Target.detachFromTarget': {
      const child = typeof p.sessionId === 'string' ? p.sessionId : undefined
      if (child && att.own.has(child)) break
      // A shared child session: stop telling the extension about it instead.
      if (child && att.known.delete(child)) {
        const info = childTargets(att.wc).find((c) => c.sessionId === child)
        forward(att, 'Target.detachedFromTarget', { sessionId: child, targetId: info?.targetId }, sessionId)
        return {}
      }
      throw protocolError('No session with given id')
    }
    case 'Target.attachToTarget':
      if (p.flatten !== true) throw protocolError('Only flatten mode is supported.')
      if (typeof p.targetId === 'string') att.pendingAttach.add(p.targetId)
      break
    case 'Target.setDiscoverTargets':
      att.discover = p.discover === true
      break
    case 'Emulation.setUserAgentOverride':
    case 'Network.setUserAgentOverride':
      att.userAgent = true
      break
  }

  let result: any
  try {
    result = await send(att.wc, method, p, sessionId)
  } catch (err) {
    if (method === 'Target.attachToTarget') att.pendingAttach.delete(p.targetId)
    throw protocolError(err instanceof Error ? err.message : String(err))
  }

  if (method === 'Page.disable') att.scripts.splice(0, att.scripts.length, ...att.scripts.filter((x) => x.session !== key))
  if (method.endsWith('.enable')) att.enabled.add(`${key}|${domain}`)
  else if (method.endsWith('.disable')) att.enabled.delete(`${key}|${domain}`)
  if (method === 'Target.attachToTarget') {
    att.pendingAttach.delete(p.targetId)
    if (typeof result?.sessionId === 'string') {
      att.own.add(result.sessionId)
      att.known.delete(result.sessionId)
    }
  }
  if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof result?.identifier === 'string') att.scripts.push({ session: key, identifier: result.identifier })
  if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
    const i = att.scripts.findIndex((s) => s.session === key && s.identifier === p.identifier)
    if (i >= 0) att.scripts.splice(i, 1)
  }
  if (method === 'Runtime.addBinding' && typeof p.name === 'string') att.bindings.add(`${key}\n${p.name}`)
  const reset = RESETS[method]
  if (reset) att.resets.set(`${key}|${method}`, reset)
  return result ?? {}
}

async function getTargets(): Promise<chrome.debugger.TargetInfo[]> {
  const out: chrome.debugger.TargetInfo[] = []
  for (const { tab } of allTabs()) {
    const wc = tab.liveWc
    if (!wc || wc.isDestroyed()) continue
    const id = await targetIdOf(wc).catch(() => null)
    if (!id) continue
    const info: chrome.debugger.TargetInfo = {
      type: 'page' as chrome.debugger.TargetInfoType,
      id,
      tabId: wc.id,
      attached: attachments.has(wc.id),
      title: wc.getTitle(),
      url: wc.getURL()
    }
    if (tab.state.favicon) info.faviconUrl = tab.state.favicon
    out.push(info)
  }
  return out
}

defineApi('debugger', {
  permissions: ['debugger'],
  methods: {
    attach,
    detach: (call, target) => {
      detachAll(attachmentFor(call, target), null)
    },
    sendCommand,
    getTargets
  }
})

defineEvent('debugger.onEvent', { permissions: ['debugger'] })
defineEvent('debugger.onDetach', { permissions: ['debugger'] })

lifecycle.on('unloaded', (extensionId) => {
  for (const att of [...attachments.values()]) if (att.extensionId === extensionId) detachAll(att, null)
})
