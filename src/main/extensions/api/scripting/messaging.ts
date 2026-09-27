import { ipcMain, type WebContents, type WebFrameMain } from 'electron'
import { PAGE_CHANNEL } from '@shared/page-scripts'
import { hasApiPermission, loadedExtension } from '../../access'
import { allContexts, broadcastLive, defineApi, defineEvent, emit, emitForResponse, ExtensionError, hasListener, type CallContext } from '../../router'
import { tabForWebContents, toChromeTab } from '../../tabs-model'
import { chromeFrameId, documentToken, frameKey, isLive, onDocumentStart, onFrameNavigated, onPageClosed, type FrameKey } from './frames'

/**
 * chrome.runtime messaging from the worlds we run extension code in (user-script worlds with
 * messaging on, the chrome.scripting fallback's world). The world's chrome.runtime talks to its
 * frame's preload over a contextBridge bridge; the preload sends to the main process, which knows
 * the sending frame from the IPC itself, so a world can't claim to be another frame.
 *
 * - runtime.sendMessage -> runtime.onUserScriptMessage (user worlds) or runtime.onMessage
 *   (fallback world), answered with sendResponse or a returned promise.
 * - runtime.connect (user worlds) -> runtime.onUserScriptConnect with a Port on each side; the main
 *   process relays both ways and closes the port when the frame's document or the receivers go.
 */

export interface WorldContext {
  readonly kind: 'user' | 'isolated'
  readonly extensionId: string
  /** User worlds: the world id ('' for the default world). */
  readonly worldId: string
  readonly wc: WebContents
  readonly frame: WebFrameMain
  readonly key: FrameKey
  /** The frame's document the world is in. */
  readonly token: string
}

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
const SCRIPT_URL = /^(https?|file):/i

/** Internal events: the extension-side installers (custom/scripting.ts) listen for these. */
export const ISOLATED_MESSAGE_EVENT = 'tabsScripting.onIsolatedMessage'
export const USER_CONNECT_EVENT = 'tabsUserScripts.onConnect'
export const USER_PORT_EVENT = '__tabs.userScriptPort'

defineEvent('runtime.onUserScriptMessage', { permissions: ['userScripts'] })
defineEvent(USER_CONNECT_EVENT, { permissions: ['userScripts'] })
defineEvent(ISOLATED_MESSAGE_EVENT, { permissions: ['scripting'] })

/** Sends a message to a world. False if its document is gone. */
export function deliverToWorld(ctx: WorldContext, msg: unknown): boolean {
  if (!isLive(ctx.frame) || documentToken(ctx.frame) !== ctx.token) return false
  try {
    ctx.frame.send(PAGE_CHANNEL.toWorld, { token: ctx.token, extensionId: ctx.extensionId, kind: ctx.kind, worldId: ctx.worldId, json: JSON.stringify(msg) })
    return true
  } catch {
    return false
  }
}

/** The MessageSender Chrome gives a world's messages. */
export function senderFor(ctx: WorldContext): Record<string, unknown> {
  const sender: Record<string, unknown> = {
    id: ctx.extensionId,
    url: ctx.frame.url,
    origin: ctx.frame.origin,
    frameId: chromeFrameId(ctx.frame),
    documentId: ctx.token,
    documentLifecycle: 'active'
  }
  const found = tabForWebContents(ctx.wc)
  if (found) sender.tab = toChromeTab(found.tab, found.controller, ctx.extensionId)
  if (ctx.kind === 'user' && ctx.worldId) sender.userScriptWorldId = ctx.worldId
  return sender
}

async function onSendMessage(ctx: WorldContext, msg: Record<string, unknown>): Promise<void> {
  const reply = (fields: Record<string, unknown>): void => void deliverToWorld(ctx, { t: 'reply', id: msg.id, ...fields })
  try {
    const event = ctx.kind === 'user' ? 'runtime.onUserScriptMessage' : ISOLATED_MESSAGE_EVENT
    if (!hasListener(event, ctx.extensionId)) return reply({ error: NO_RECEIVER })
    const value = await emitForResponse(ctx.extensionId, event, [msg.message, senderFor(ctx)])
    reply({ value: value ?? undefined })
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ---- ports ----

interface UserPort {
  readonly id: string
  readonly worldPortId: string
  readonly ctx: WorldContext
  /** Extension contexts that took the port (router context keys). */
  readonly receivers: Set<string>
  accepted: boolean
  /** Messages from the world before any receiver took the port. */
  readonly queue: unknown[]
  timer: NodeJS.Timeout | null
}

const ports = new Map<string, UserPort>()
const lastKeepAlive = new Map<string, number>()

/** Port traffic keeps the extension's worker running, like Chrome (at most one task every few seconds). */
function keepWorkerAlive(extensionId: string): void {
  const now = Date.now()
  if (now - (lastKeepAlive.get(extensionId) ?? 0) < 5_000) return
  lastKeepAlive.set(extensionId, now)
  for (const c of allContexts(extensionId)) {
    if (!c.worker) continue
    try {
      const task = c.worker.startTask()
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
}

const portKey = (ctx: WorldContext, worldPortId: unknown): string =>
  `${ctx.key}.${ctx.token}.${ctx.kind}.${ctx.extensionId}.${ctx.worldId}.${String(worldPortId)}`

/** Closes a port: tells whichever sides still need to know. */
function closePort(port: UserPort, notifyWorld: boolean, notifyExtension: boolean, error?: string): void {
  if (!ports.delete(port.id)) return
  if (port.timer) clearTimeout(port.timer)
  if (notifyWorld) deliverToWorld(port.ctx, { t: 'port', portId: port.worldPortId, kind: 'disconnect', error })
  if (notifyExtension) broadcastLive(USER_PORT_EVENT, [port.id, 'disconnect'], port.ctx.extensionId)
}

/** Drops receivers whose page or worker is gone; closes the port when none are left. */
function pruneReceivers(port: UserPort): boolean {
  if (!port.accepted) return true
  const alive = new Set(allContexts(port.ctx.extensionId).map((c) => c.key))
  for (const key of [...port.receivers]) if (!alive.has(key)) port.receivers.delete(key)
  if (port.receivers.size) return true
  closePort(port, true, false)
  return false
}

function onConnect(ctx: WorldContext, msg: Record<string, unknown>): void {
  const worldPortId = String(msg.portId)
  if (!hasListener(USER_CONNECT_EVENT, ctx.extensionId)) {
    deliverToWorld(ctx, { t: 'port', portId: worldPortId, kind: 'disconnect', error: NO_RECEIVER })
    return
  }
  const port: UserPort = { id: portKey(ctx, worldPortId), worldPortId, ctx, receivers: new Set(), accepted: false, queue: [], timer: null }
  ports.set(port.id, port)
  // Nobody took it (e.g. the worker didn't start): like Chrome, the opener's port disconnects.
  port.timer = setTimeout(() => {
    port.timer = null
    if (!port.accepted) closePort(port, true, false, NO_RECEIVER)
  }, 15_000)
  emit(USER_CONNECT_EVENT, [port.id, typeof msg.name === 'string' ? msg.name : '', senderFor(ctx)], { extensionId: ctx.extensionId })
}

function onPortFromWorld(ctx: WorldContext, msg: Record<string, unknown>): void {
  const port = ports.get(portKey(ctx, msg.portId))
  if (!port) return
  if (msg.kind === 'disconnect') return closePort(port, false, true)
  if (!port.accepted) {
    port.queue.push(msg.value)
    return
  }
  if (!pruneReceivers(port)) return
  keepWorkerAlive(ctx.extensionId)
  broadcastLive(USER_PORT_EVENT, [port.id, 'message', msg.value], ctx.extensionId)
}

/** Closes the ports of a frame's documents (all of them, or all but `keepToken`'s), and of frames that are gone. */
function closeFramePorts(key: FrameKey, keepToken: string | null, frame?: WebFrameMain): void {
  for (const port of [...ports.values()]) {
    const c = port.ctx
    const sameFrame = c.key === key || c.frame === frame
    if ((sameFrame && c.token !== keepToken) || !isLive(c.frame)) closePort(port, false, true)
  }
}

onDocumentStart((key, token, frame) => closeFramePorts(key, token, frame))
// Navigations to pages without page scripts don't start a document we hear about.
onFrameNavigated((_wc, key, url) => closeFramePorts(SCRIPT_URL.test(url) ? '' : key, null))
onPageClosed((wc) => {
  for (const port of [...ports.values()]) if (port.ctx.wc === wc) closePort(port, false, true)
})

function portFor(call: CallContext, id: unknown): UserPort {
  const port = typeof id === 'string' ? ports.get(id) : undefined
  if (!port || port.ctx.extensionId !== call.extensionId) throw new ExtensionError('Attempting to use a disconnected port object')
  return port
}

// Called by the extension-side Port objects (custom/scripting.ts).
defineApi('userScripts', {
  permissions: ['userScripts'],
  methods: {
    _portAccept: (call, id) => {
      const port = portFor(call, id)
      port.receivers.add(call.context.key)
      if (port.accepted) return
      port.accepted = true
      if (port.timer) clearTimeout(port.timer)
      port.timer = null
      // After this call returns, so the new Port is set up to receive them.
      const queued = port.queue.splice(0)
      if (queued.length) setTimeout(() => queued.forEach((value) => broadcastLive(USER_PORT_EVENT, [port.id, 'message', value], call.extensionId)), 0)
    },
    _portPost: (call, id, value) => {
      const port = portFor(call, id)
      keepWorkerAlive(call.extensionId)
      if (!deliverToWorld(port.ctx, { t: 'port', portId: port.worldPortId, kind: 'message', value: value ?? null })) closePort(port, false, true)
    },
    _portDisconnect: (call, id) => {
      const port = typeof id === 'string' ? ports.get(id) : undefined
      if (!port || port.ctx.extensionId !== call.extensionId) return
      port.receivers.delete(call.context.key)
      if (!port.receivers.size) closePort(port, true, false)
    }
  }
})

// ---- from the preload ----

/** Whether a user world may message (configureWorld's messaging), from user-scripts.ts. */
let userWorldMessaging: (extensionId: string, worldId: string) => boolean = () => false

export function setUserWorldMessaging(policy: typeof userWorldMessaging): void {
  userWorldMessaging = policy
}

ipcMain.on(PAGE_CHANNEL.fromWorld, (event, envelope) => {
  const frame = event.senderFrame
  if (!frame || !envelope || typeof envelope !== 'object' || typeof envelope.json !== 'string') return
  const { token, extensionId, kind, worldId } = envelope as Record<string, unknown>
  if (kind !== 'user' && kind !== 'isolated') return
  if (typeof extensionId !== 'string' || typeof worldId !== 'string' || typeof token !== 'string') return
  if (documentToken(frame) !== token || !loadedExtension(extensionId)) return
  if (!hasApiPermission(extensionId, kind === 'user' ? 'userScripts' : 'scripting')) return
  if (kind === 'user' && !userWorldMessaging(extensionId, worldId)) return
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(envelope.json)
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object') return
  const ctx: WorldContext = { kind, extensionId, worldId, wc: event.sender, frame, key: frameKey(frame), token }
  switch (msg.t) {
    case 'msg':
      void onSendMessage(ctx, msg)
      break
    case 'connect':
      if (kind === 'user') onConnect(ctx, msg)
      break
    case 'port':
      onPortFromWorld(ctx, msg)
      break
  }
})

/** An extension stopped: close its ports. */
export function forgetWorldPorts(extensionId: string): void {
  for (const port of [...ports.values()]) if (port.ctx.extensionId === extensionId) closePort(port, true, false)
}
