import type { WebContents } from 'electron'
import { hasActiveTabGrant, hasHostAccess } from '../../access'
import { lifecycle } from '../../lifecycle'
import { allContexts, contextWebContents, defineApi, defineEvent, emit, ExtensionError, webContentsById, type CallContext } from '../../router'
import { currentWindow, findTab } from '../../tabs-model'
import { isObject, isNumber, mayUsePageApi } from './targets'

/**
 * chrome.tabCapture (Manifest V3): getMediaStreamId hands out an id for
 * getUserMedia({ audio/video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } }),
 * from Electron's webContents.getMediaSourceId, which ties it to the page that will consume it.
 * Captures are followed by polling the tab's capturer count for getCapturedTabs and onStatusChanged.
 * capture() is Manifest V2 only (see custom/scripting.ts).
 */

type Status = 'pending' | 'active' | 'stopped' | 'error'

interface Capture {
  extensionId: string
  tabId: number
  status: Status
  since: number
}

const captures = new Map<string, Capture>()
let poller: NodeJS.Timeout | null = null

/** A stream id nobody used is gone after a while (Electron's expire after 10 seconds). */
const PENDING_LIMIT_MS = 15_000

const captureKey = (extensionId: string, tabId: number): string => `${extensionId}:${tabId}`

function setStatus(c: Capture, status: Status): void {
  c.status = status
  c.since = Date.now()
  emit('tabCapture.onStatusChanged', [{ tabId: c.tabId, status, fullscreen: false }], { extensionId: c.extensionId, wake: false })
  if (status === 'stopped' || status === 'error') captures.delete(captureKey(c.extensionId, c.tabId))
}

function poll(): void {
  for (const c of [...captures.values()]) {
    const wc = webContentsById(c.tabId)
    const captured = !!wc && wc.isBeingCaptured()
    if (!wc) setStatus(c, 'stopped')
    else if (c.status === 'pending' && captured) setStatus(c, 'active')
    else if (c.status === 'active' && !captured) setStatus(c, 'stopped')
    else if (c.status === 'pending' && Date.now() - c.since > PENDING_LIMIT_MS) setStatus(c, 'stopped')
  }
  if (!captures.size && poller) {
    clearInterval(poller)
    poller = null
  }
}

/** The page that will call getUserMedia: the consumer tab, else the caller's own page, else its offscreen document or another page. */
function consumerFor(call: CallContext, consumerTabId: unknown): WebContents {
  if (consumerTabId !== undefined && consumerTabId !== null) {
    const wc = isNumber(consumerTabId) ? findTab(consumerTabId)?.tab.liveWc : null
    if (!wc || wc.isDestroyed()) throw new ExtensionError(`No tab with id: ${String(consumerTabId)}.`)
    return wc
  }
  const own = contextWebContents(call.context)
  if (own) return own
  const contexts = allContexts(call.extensionId).filter((c) => !c.worker && contextWebContents(c))
  const pick = contexts.find((c) => c.type === 'OFFSCREEN_DOCUMENT') ?? contexts.find((c) => c.frame && !c.frame.parent)
  const wc = pick ? contextWebContents(pick) : null
  if (!wc) throw new ExtensionError('No extension page to use the stream: create an offscreen document first, or pass consumerTabId.')
  return wc
}

function getMediaStreamId(call: CallContext, options: unknown): string {
  const o = isObject(options) ? options : {}
  let targetTabId: number
  if (o.targetTabId !== undefined && o.targetTabId !== null) {
    if (!isNumber(o.targetTabId)) throw new ExtensionError('Invalid targetTabId.')
    targetTabId = o.targetTabId
  } else {
    const active = currentWindow(call)?.activeTab?.liveWc
    if (!active) throw new ExtensionError('No active tab.')
    targetTabId = active.id
  }
  const target = findTab(targetTabId)?.tab.liveWc
  if (!target || target.isDestroyed()) throw new ExtensionError(`No tab with id: ${targetTabId}.`)
  const url = target.getURL()
  // Chrome wants the extension to have been invoked on the tab (activeTab); host access is accepted too.
  const invoked = hasActiveTabGrant(call.extensionId, targetTabId) || hasHostAccess(call.extensionId, url, targetTabId)
  if (!mayUsePageApi(call.extensionId, url, targetTabId) && !invoked) throw new ExtensionError('Chrome pages cannot be captured.')
  if (!invoked) throw new ExtensionError('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.')
  const key = captureKey(call.extensionId, targetTabId)
  if (captures.get(key)?.status === 'active') throw new ExtensionError('Cannot capture a tab with an active stream.')
  const id = target.getMediaSourceId(consumerFor(call, o.consumerTabId))
  const capture: Capture = { extensionId: call.extensionId, tabId: targetTabId, status: 'pending', since: Date.now() }
  captures.set(key, capture)
  setStatus(capture, 'pending')
  poller ??= setInterval(poll, 1000)
  return id
}

defineApi('tabCapture', {
  permissions: ['tabCapture'],
  methods: {
    getMediaStreamId,
    getCapturedTabs: (call) =>
      [...captures.values()].filter((c) => c.extensionId === call.extensionId).map((c) => ({ tabId: c.tabId, status: c.status, fullscreen: false }))
  }
})

defineEvent('tabCapture.onStatusChanged', { permissions: ['tabCapture'] })

lifecycle.on('unloaded', (extensionId) => {
  for (const [key, c] of captures) if (c.extensionId === extensionId) captures.delete(key)
})
