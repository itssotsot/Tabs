/**
 * Runs in the extension's own world (page or background worker), via
 * contextBridge.executeInMainWorld. Electron serializes the function, so everything it uses must
 * be inside it: no imports, no outer variables. It sets up the helper the namespace installers
 * use, reachable as `globalThis[Symbol.for('tabs.extensions')]`.
 */

/** The helper's shape, for the installers' type checking. */
export interface ExtCore {
  readonly id: string
  readonly manifest: chrome.runtime.Manifest & Record<string, any>
  readonly worker: boolean
  /** Declared in `permissions` or `optional_permissions`. */
  declares(permission: string): boolean
  hasManifestKey(key: string): boolean
  /** Calls our implementation in the main process. Rejects with the API's error. */
  call(namespace: string, method: string, args: unknown[]): Promise<any>
  /** A chrome.* function: takes an optional trailing callback, else returns a promise. */
  fn(namespace: string, method: string, options?: FnOptions): (...args: any[]) => any
  /** The chrome.* event object for `namespace.onSomething`, created on first use. */
  event(name: string, options?: EventOptions): ExtEvent
  /** chrome.<path>, created if missing. `replace` swaps out Electron's own object. */
  namespace(path: string, replace?: boolean): Record<string, any>
  /** Sets properties on a namespace object, even over Electron's own ones. */
  define(target: Record<string, any>, props: Record<string, unknown>): void
  /** Runs `fn` with chrome.runtime.lastError set to `message`. */
  withLastError(message: string, fn: () => void): void
  /** Handlers for the main process's internal (non-API) messages. */
  onInternal(name: string, handler: (...args: any[]) => void): void
  /** Latest `sender.tab` corrections, by tab id. */
  tabsCache: Record<number, Record<string, unknown>>
}

export interface FnOptions {
  /** Rewrites the arguments before they're sent (e.g. to strip functions). */
  before?: (args: any[]) => any[] | Promise<any[]>
  /** Rewrites the result before the extension gets it. */
  after?: (result: any, args: any[]) => any
}

export interface EventOptions {
  /** Listeners get a sendResponse function and may return true or a promise to answer later. */
  response?: boolean
}

export interface ExtEvent {
  addListener(callback: (...args: any[]) => any, filter?: unknown, extra?: unknown): void
  removeListener(callback: (...args: any[]) => any): void
  hasListener(callback: (...args: any[]) => any): boolean
  hasListeners(): boolean
}

export function installCore(info: { worker: boolean }): void {
  const KEY = Symbol.for('tabs.extensions')
  const g = globalThis as any
  if (g[KEY]) return
  const bridge = g.__tabsExtensionBridge
  if (!bridge || typeof chrome === 'undefined' || !chrome.runtime?.id) return
  try {
    delete g.__tabsExtensionBridge
  } catch {
    // Exposed as non-configurable; harmless.
  }

  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & Record<string, any>
  const declared = new Set<string>([...((manifest as any).permissions ?? []), ...((manifest as any).optional_permissions ?? [])])
  const events = new Map<string, any>()
  const listenersByKey = new Map<number, { event: any; callback: (...args: any[]) => any }>()
  const internal = new Map<string, (...args: any[]) => void>()
  let nextKey = 1

  const cleanMessage = (err: unknown): string =>
    String((err as { message?: string })?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

  const reportError = (err: unknown): void => {
    console.error(err)
  }

  function withLastError(message: string, fn: () => void): void {
    let defined = false
    try {
      Object.defineProperty(chrome.runtime, 'lastError', { value: { message }, configurable: true, enumerable: true })
      defined = true
    } catch {
      // Can't set it; the callback still runs.
    }
    try {
      fn()
    } catch (err) {
      reportError(err)
    } finally {
      if (defined) {
        try {
          delete (chrome.runtime as any).lastError
        } catch {
          // Leave it.
        }
      }
    }
  }

  function call(namespace: string, method: string, args: unknown[]): Promise<any> {
    return Promise.resolve(bridge.call(namespace, method, args)).catch((err: unknown) => {
      throw new Error(cleanMessage(err))
    })
  }

  function fn(namespace: string, method: string, options: FnOptions = {}): (...args: any[]) => any {
    return function (...args: any[]) {
      let callback: ((...a: any[]) => void) | undefined
      if (args.length && typeof args[args.length - 1] === 'function') callback = args.pop()
      while (args.length && args[args.length - 1] === undefined) args.pop()
      const promise = Promise.resolve(options.before ? options.before(args) : args)
        .then((prepared) => call(namespace, method, prepared))
        .then((result) => (options.after ? options.after(result, args) : result))
      if (!callback) return promise
      const cb = callback
      promise.then(
        (result) => {
          try {
            if (result === undefined) cb()
            else cb(result)
          } catch (err) {
            reportError(err)
          }
        },
        (err: Error) => withLastError(err.message, () => cb())
      )
      return undefined
    }
  }

  function toFilterPayload(filter: unknown, extra: unknown): unknown {
    if (filter == null && extra == null) return null
    const base = filter && typeof filter === 'object' ? { ...(filter as object) } : {}
    return extra == null ? base : { ...base, __extra: extra }
  }

  function makeEvent(name: string, options: EventOptions): any {
    const byCallback = new Map<(...args: any[]) => any, number>()
    return {
      __name: name,
      __options: options,
      addListener(callback: (...args: any[]) => any, filter?: unknown, extra?: unknown) {
        if (typeof callback !== 'function') throw new TypeError(`${name}.addListener needs a function.`)
        if (byCallback.has(callback)) return
        const key = nextKey++
        byCallback.set(callback, key)
        listenersByKey.set(key, { event: this, callback })
        bridge.listen(name, key, toFilterPayload(filter, extra), true)
      },
      removeListener(callback: (...args: any[]) => any) {
        const key = byCallback.get(callback)
        if (key === undefined) return
        byCallback.delete(callback)
        listenersByKey.delete(key)
        bridge.listen(name, key, null, false)
      },
      hasListener(callback: (...args: any[]) => any) {
        return byCallback.has(callback)
      },
      hasListeners() {
        return byCallback.size > 0
      },
      __keys() {
        return [...byCallback.values()]
      }
    }
  }

  function event(name: string, options: EventOptions = {}): ExtEvent {
    let e = events.get(name)
    if (!e) events.set(name, (e = makeEvent(name, options)))
    return e
  }

  // Chromium also exposes the APIs as `browser` (a separate object sharing the namespaces), which
  // some extensions prefer (`self.browser || self.chrome`). Top-level namespaces we add go on both.
  const browserRoot: any = g.browser && typeof g.browser === 'object' && g.browser !== chrome ? g.browser : null

  function setProperty(target: any, key: string, value: unknown): void {
    try {
      Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true })
    } catch {
      target[key] = value
    }
  }

  function namespace(path: string, replace = false): Record<string, any> {
    let target: any = chrome
    const parts = path.split('.')
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      let next = target[part]
      if (!next || typeof next !== 'object' || (last && replace)) {
        next = {}
        setProperty(target, part, next)
      }
      if (i === 0 && browserRoot && browserRoot[part] !== next) setProperty(browserRoot, part, next)
      target = next
    })
    return target
  }

  function define(target: Record<string, any>, props: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(props)) {
      try {
        Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true })
      } catch {
        try {
          target[key] = value
        } catch {
          // Frozen; skip.
        }
      }
    }
  }

  const ext: ExtCore = {
    id: chrome.runtime.id,
    manifest,
    worker: info.worker,
    declares: (p) => declared.has(p),
    hasManifestKey: (k) => manifest[k] !== undefined,
    call,
    fn,
    event,
    namespace,
    define,
    withLastError,
    onInternal: (name, handler) => void internal.set(name, handler),
    tabsCache: {}
  }
  internal.set('__tabs.cache', (cache: Record<number, Record<string, unknown>>) => {
    ext.tabsCache = cache ?? {}
  })

  bridge.subscribe((name: string, args: unknown[], replyId: number | null, keys: number[] | null) => {
    if (name.startsWith('__')) {
      try {
        internal.get(name)?.(...(args ?? []))
      } catch (err) {
        reportError(err)
      }
      return
    }
    const e = events.get(name)
    const targetKeys: number[] = keys ?? (e ? e.__keys() : [])
    const targets = targetKeys.map((k) => listenersByKey.get(k)).filter((t): t is { event: any; callback: (...a: any[]) => any } => !!t)
    const list = Array.isArray(args) ? args : []
    if (replyId === null || replyId === undefined) {
      for (const t of targets) {
        try {
          t.callback(...list)
        } catch (err) {
          reportError(err)
        }
      }
      return
    }
    let answered = false
    let willAnswer = false
    const sendResponse = (value?: unknown): void => {
      if (answered) return
      answered = true
      bridge.reply(replyId, value === undefined ? null : value)
    }
    for (const t of targets) {
      try {
        const result = t.callback(...list, sendResponse)
        if (result === true) willAnswer = true
        else if (result && typeof (result as Promise<unknown>).then === 'function') {
          willAnswer = true
          ;(result as Promise<unknown>).then(sendResponse, (err: unknown) => {
            reportError(err)
            sendResponse(undefined)
          })
        }
      } catch (err) {
        reportError(err)
      }
    }
    if (!willAnswer && !answered) bridge.reply(replyId, undefined)
  })

  Object.defineProperty(g, KEY, { value: ext, configurable: false, enumerable: false, writable: false })
}
