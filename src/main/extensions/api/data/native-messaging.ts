import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { lifecycle } from '../../lifecycle'
import { allContexts, defineApi, defineEvent, emit, ExtensionError, type CallContext, type ExtensionContext } from '../../router'
import { findWindow } from '../../tabs-model'
import { encodeMessage, MessageReader, NATIVE_ERRORS, NativeHostError, resolveHost } from './native-host'
import { isString } from './util'

/**
 * Native messaging: runtime.connectNative and runtime.sendNativeMessage (the extension side is in
 * custom/data.ts). Hosts are found like Chrome finds them (native-host.ts), plus a
 * NativeMessagingHosts folder in the app's own data folder, and run with the extension's origin
 * as their argument. A connection lives until either side closes it, the page or worker that
 * opened it goes away, or the extension stops.
 */

const PORT_MESSAGE = 'nativeMessaging.onPortMessage'
const PORT_DISCONNECT = 'nativeMessaging.onPortDisconnect'

interface NativePort {
  extensionId: string
  portId: string
  child: ChildProcess
  context: ExtensionContext
  /** Keeps a background worker running while its connection is open. */
  task: { end(): void } | null
  closed: boolean
}

const ports = new Map<string, NativePort>()
/** One-off hosts from sendNativeMessage, per extension, stopped if it unloads. */
const oneOffs = new Map<string, Set<ChildProcess>>()

const portKey = (extensionId: string, portId: string): string => `${extensionId}:${portId}`

function toError(err: unknown): ExtensionError {
  return new ExtensionError(err instanceof NativeHostError ? err.message : NATIVE_ERRORS.failedToStart)
}

/** The Chrome window handle hosts get on Windows (0 for background workers), as Chrome passes it. */
function parentWindowArg(call: CallContext): string {
  const win = call.windowId !== undefined && call.context.type !== 'BACKGROUND' ? findWindow(call.windowId)?.win : null
  if (!win || win.isDestroyed()) return '--parent-window=0'
  const handle = win.getNativeWindowHandle()
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  return `--parent-window=${value.toString()}`
}

/** Starts a host program. Resolves once it's running. */
async function startHost(call: CallContext, application: unknown): Promise<ChildProcess> {
  const program = await resolveHost(application, call.extensionId, [join(app.getPath('userData'), 'NativeMessagingHosts')]).catch((err) => {
    throw toError(err)
  })
  const origin = `chrome-extension://${call.extensionId}/`
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child =
    process.platform === 'win32'
      ? // Like Chrome, through cmd.exe, so .bat and .cmd hosts work.
        spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${program}" ${origin} ${parentWindowArg(call)}"`], {
          cwd: dirname(program),
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      : spawn(program, [origin], { cwd: dirname(program), env, stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new ExtensionError(NATIVE_ERRORS.failedToStart)))
  })
  // Hosts log to stderr; Chrome shows it in its own log only.
  child.stderr?.resume()
  // A host that stops reading shouldn't crash us with EPIPE.
  child.stdin?.on('error', () => {})
  return child
}

function write(child: ChildProcess, json: string): void {
  child.stdin?.write(encodeMessage(json))
}

/** Ends a host: closes its input, then stops it if it doesn't exit by itself. */
function stopHost(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.stdin?.end()
  } catch {
    // Already closed.
  }
  const timer = setTimeout(() => child.kill(), 1000)
  child.once('exit', () => clearTimeout(timer))
}

/** Closes a connection. With `error`, the extension's port gets onDisconnect with that as runtime.lastError. */
function closePort(port: NativePort, error: string | null, notify: boolean): void {
  if (port.closed) return
  port.closed = true
  ports.delete(portKey(port.extensionId, port.portId))
  port.task?.end()
  stopHost(port.child)
  if (notify) emit(PORT_DISCONNECT, [port.portId, error], { extensionId: port.extensionId, wake: false })
}

async function connect(call: CallContext, application: unknown, portId: unknown): Promise<void> {
  if (!isString(portId) || !portId || ports.has(portKey(call.extensionId, portId))) throw new ExtensionError('Invalid port.')
  const child = await startHost(call, application)
  let task: { end(): void } | null = null
  try {
    task = call.context.worker?.startTask() ?? null
  } catch {
    // Not running; nothing to keep alive.
  }
  const port: NativePort = { extensionId: call.extensionId, portId, child, context: call.context, task, closed: false }
  ports.set(portKey(call.extensionId, portId), port)
  const reader = new MessageReader()
  child.stdout?.on('data', (chunk: Buffer) => {
    if (port.closed) return
    let messages: unknown[]
    try {
      messages = reader.push(chunk)
    } catch {
      return closePort(port, NATIVE_ERRORS.protocol, true)
    }
    for (const message of messages) emit(PORT_MESSAGE, [portId, message], { extensionId: call.extensionId, wake: false })
  })
  child.once('close', () => closePort(port, NATIVE_ERRORS.exited, true))
}

function post(call: CallContext, portId: unknown, json: unknown): void {
  const port = isString(portId) ? ports.get(portKey(call.extensionId, portId)) : undefined
  if (!port || !isString(json)) throw new ExtensionError('Attempting to use a disconnected port object')
  try {
    write(port.child, json)
  } catch {
    closePort(port, NATIVE_ERRORS.protocol, true)
  }
}

function disconnect(call: CallContext, portId: unknown): void {
  const port = isString(portId) ? ports.get(portKey(call.extensionId, portId)) : undefined
  if (port) closePort(port, null, false)
}

/** runtime.sendNativeMessage: starts the host, sends one message, and resolves with its first reply. */
async function send(call: CallContext, application: unknown, json: unknown): Promise<unknown> {
  if (!isString(json)) throw new ExtensionError('Invalid message.')
  const child = await startHost(call, application)
  let set = oneOffs.get(call.extensionId)
  if (!set) oneOffs.set(call.extensionId, (set = new Set()))
  set.add(child)
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const reader = new MessageReader()
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          const [first] = reader.push(chunk)
          if (first !== undefined) resolve(first)
        } catch {
          reject(new ExtensionError(NATIVE_ERRORS.protocol))
        }
      })
      // 'close' comes after the output is read, so a reply written just before exiting still counts.
      child.once('close', () => reject(new ExtensionError(NATIVE_ERRORS.exited)))
      try {
        write(child, json)
      } catch {
        reject(new ExtensionError(NATIVE_ERRORS.protocol))
      }
    })
  } finally {
    set.delete(child)
    stopHost(child)
  }
}

defineApi('nativeMessaging', {
  permissions: ['nativeMessaging'],
  methods: { connect, post, disconnect, send }
})

// Each port listens with its id as the filter, so only the page or worker that opened it hears about it.
const byPort = (filter: { portId?: unknown }, args: unknown[]): boolean => filter?.portId === args[0]
defineEvent(PORT_MESSAGE, { permissions: ['nativeMessaging'], matches: byPort })
defineEvent(PORT_DISCONNECT, { permissions: ['nativeMessaging'], matches: byPort })

/** Whether the page or worker that opened a port is still there and still listening to it. */
function ownerAlive(port: NativePort): boolean {
  if (!allContexts(port.extensionId).includes(port.context)) return false
  const listeners = port.context.listeners.get(PORT_MESSAGE)
  return !!listeners && [...listeners.values()].some((filter) => (filter as { portId?: unknown } | null)?.portId === port.portId)
}

setInterval(() => {
  for (const port of [...ports.values()]) if (!ownerAlive(port)) closePort(port, null, false)
}, 5000).unref()

lifecycle.on('unloaded', (extensionId) => {
  for (const port of [...ports.values()]) if (port.extensionId === extensionId) closePort(port, null, false)
  for (const child of oneOffs.get(extensionId) ?? []) child.kill()
  oneOffs.delete(extensionId)
})

app.on('will-quit', () => {
  for (const port of ports.values()) port.child.kill()
  for (const set of oneOffs.values()) for (const child of set) child.kill()
})
