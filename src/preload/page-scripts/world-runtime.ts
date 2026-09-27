import type { WorldRuntimeConfig } from '@shared/page-scripts'

/**
 * chrome.runtime for a world we run extension code in (a user-script world with messaging on, or
 * the chrome.scripting fallback's world). Runs INSIDE that world, sent as source text
 * (`worldRuntime.toString()`), so it must be self-contained: no imports, no outer variables.
 *
 * It talks to the preload through the bridge exposed at `cfg.bridgeKey`
 * (contextBridge.exposeInIsolatedWorld): `post(json)` to the main process, `subscribe(fn)` for
 * what comes back. Messages are JSON, like Chrome's.
 */
export function worldRuntime(cfg: WorldRuntimeConfig): void {
  const g = globalThis as any
  const KEY = Symbol.for('tabs.worldRuntime')
  if (g[KEY]) return
  const bridge = g[cfg.bridgeKey]
  try {
    delete g[cfg.bridgeKey]
  } catch {
    // Exposed read-only; it's only in this world anyway.
  }
  if (!bridge || typeof bridge.post !== 'function') return
  Object.defineProperty(g, KEY, { value: true })

  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
  const post = (msg: Record<string, unknown>): void => bridge.post(JSON.stringify(msg))
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const ports = new Map<string, { receive: (v: unknown) => void; close: (error?: string) => void }>()
  let nextId = 1
  let lastError: { message: string } | undefined

  const makeEvent = (): any => {
    const listeners = new Set<(...args: any[]) => void>()
    return {
      addListener(fn: (...args: any[]) => void) {
        if (typeof fn === 'function') listeners.add(fn)
      },
      removeListener(fn: (...args: any[]) => void) {
        listeners.delete(fn)
      },
      hasListener(fn: (...args: any[]) => void) {
        return listeners.has(fn)
      },
      hasListeners() {
        return listeners.size > 0
      },
      dispatch(...args: unknown[]) {
        for (const fn of [...listeners]) {
          try {
            fn(...args)
          } catch (err) {
            console.error(err)
          }
        }
      }
    }
  }

  const withLastError = (message: string, fn: () => void): void => {
    lastError = { message }
    try {
      fn()
    } catch (err) {
      console.error(err)
    } finally {
      lastError = undefined
    }
  }

  bridge.subscribe((json: string) => {
    let msg: any
    try {
      msg = JSON.parse(json)
    } catch {
      return
    }
    if (msg?.t === 'reply') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.value)
    } else if (msg?.t === 'port') {
      const port = ports.get(msg.portId)
      if (!port) return
      if (msg.kind === 'message') port.receive(msg.value)
      else port.close(msg.error)
    }
  })

  const runtime: Record<string, unknown> = {}
  Object.defineProperty(runtime, 'lastError', { get: () => lastError, enumerable: true })
  runtime.id = cfg.extensionId

  runtime.sendMessage = function (...args: any[]) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
    while (args.length > 1 && args[args.length - 1] === undefined) args.pop()
    let target: unknown
    let message: unknown
    if (args.length >= 3 || (args.length === 2 && typeof args[0] === 'string' && /^[a-p]{32}$/.test(args[0]))) {
      target = args[0]
      message = args[1]
    } else {
      message = args[0]
    }
    const promise = new Promise((resolve, reject) => {
      if (target != null && target !== cfg.extensionId) throw new Error('This world can only message its own extension.')
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        post({ t: 'msg', id, message: message === undefined ? null : message })
      } catch (err) {
        pending.delete(id)
        throw err instanceof Error && /cloned|circular/i.test(err.message) ? err : new Error(NO_RECEIVER)
      }
    })
    if (!callback) return promise
    promise.then(
      (value) => {
        try {
          callback(value)
        } catch (err) {
          console.error(err)
        }
      },
      (err: Error) => withLastError(err.message, () => callback())
    )
    return undefined
  }

  if (cfg.kind === 'user') {
    runtime.connect = function (...args: any[]) {
      const info = typeof args[0] === 'string' ? args[1] : args[0]
      if (typeof args[0] === 'string' && args[0] !== cfg.extensionId) throw new Error('User scripts can only connect to their own extension.')
      const name = info && typeof info.name === 'string' ? info.name : ''
      const portId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
      const onMessage = makeEvent()
      const onDisconnect = makeEvent()
      let connected = true
      const port: Record<string, unknown> = {
        name,
        onMessage,
        onDisconnect,
        postMessage(value: unknown) {
          if (!connected) throw new Error('Attempting to use a disconnected port object')
          post({ t: 'port', portId, kind: 'message', value: value === undefined ? null : value })
        },
        disconnect() {
          if (!connected) return
          connected = false
          ports.delete(portId)
          try {
            post({ t: 'port', portId, kind: 'disconnect' })
          } catch {
            // No connection anyway.
          }
        }
      }
      ports.set(portId, {
        receive: (value) => onMessage.dispatch(value, port),
        close: (error) => {
          if (!connected) return
          connected = false
          ports.delete(portId)
          if (error) withLastError(error, () => onDisconnect.dispatch(port))
          else onDisconnect.dispatch(port)
        }
      })
      try {
        post({ t: 'connect', portId, name })
      } catch (err) {
        setTimeout(() => ports.get(portId)?.close((err as Error).message), 0)
      }
      return port
    }
  }

  // Both kinds of world have these (Tampermonkey's page helper uses them in its user-script world).
  runtime.getURL = (path: unknown) => cfg.baseUrl + String(path ?? '').replace(/^\/+/, '')
  // Messages from the extension (tabs.sendMessage / tabs.connect) don't reach these worlds; listeners are accepted but never called.
  runtime.onMessage = makeEvent()
  runtime.onConnect = makeEvent()

  const chromeObject = g.chrome && typeof g.chrome === 'object' ? g.chrome : {}
  try {
    Object.defineProperty(chromeObject, 'runtime', { value: runtime, configurable: true, enumerable: true, writable: true })
    if (g.chrome !== chromeObject) Object.defineProperty(g, 'chrome', { value: chromeObject, configurable: true, enumerable: false, writable: true })
  } catch {
    // Something froze it; no messaging then.
  }
}
