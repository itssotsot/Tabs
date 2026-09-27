/**
 * Installers for the data and account APIs that need more than a spec. Each runs in the
 * extension's world (see core.ts): self-contained, using only the helper at
 * `globalThis[Symbol.for('tabs.extensions')]`.
 */

/**
 * chrome.storage.sync backed by the main process (Electron's own fails every call), and
 * chrome.storage.onChanged extended so its listeners hear about sync changes too. Also a
 * read-only, empty chrome.storage.managed in place of Electron's, which always fails.
 */
export function installStorageSync(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('storage') || typeof chrome === 'undefined' || !chrome.storage) return
  const storage = chrome.storage as any
  // Values travel as JSON, like Chrome stores them (functions and undefined members disappear).
  const toJson = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value) ?? 'null'))
  const syncChanged = ext.event('storage.sync.onChanged')
  const area: Record<string, unknown> = {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
    get: ext.fn('storage.sync', 'get', { before: (args: any[]) => (args.length ? [toJson(args[0]) ?? null] : []) }),
    getKeys: ext.fn('storage.sync', 'getKeys'),
    set: ext.fn('storage.sync', 'set', { before: (args: any[]) => [toJson(args[0])] }),
    remove: ext.fn('storage.sync', 'remove'),
    clear: ext.fn('storage.sync', 'clear'),
    getBytesInUse: ext.fn('storage.sync', 'getBytesInUse', { before: (args: any[]) => (args.length ? [args[0] ?? null] : []) }),
    setAccessLevel: ext.fn('storage.sync', 'setAccessLevel'),
    onChanged: syncChanged
  }
  const native = storage.sync
  try {
    Object.defineProperty(storage, 'sync', { value: area, configurable: true, enumerable: true, writable: false })
  } catch {
    // Not replaceable; its methods are patched below instead.
  }
  if (storage.sync !== area && native && typeof native === 'object') ext.define(native, area)

  // chrome.storage.onChanged is Electron's; its listeners also get ours, as (changes, 'sync').
  const changed = storage.onChanged
  if (changed && typeof changed.addListener === 'function') {
    const add = changed.addListener.bind(changed)
    const remove = changed.removeListener.bind(changed)
    const has = changed.hasListener.bind(changed)
    const hasAny = typeof changed.hasListeners === 'function' ? changed.hasListeners.bind(changed) : () => false
    const wrappers = new Map<(...args: any[]) => void, (changes: unknown) => void>()
    ext.define(changed, {
      addListener(callback: (...args: any[]) => void, ...rest: unknown[]) {
        add(callback, ...rest)
        if (typeof callback !== 'function' || wrappers.has(callback)) return
        const wrapper = (changes: unknown): void => callback(changes, 'sync')
        wrappers.set(callback, wrapper)
        syncChanged.addListener(wrapper)
      },
      removeListener(callback: (...args: any[]) => void) {
        remove(callback)
        const wrapper = wrappers.get(callback)
        if (!wrapper) return
        wrappers.delete(callback)
        syncChanged.removeListener(wrapper)
      },
      hasListener(callback: (...args: any[]) => void) {
        return wrappers.has(callback) || has(callback)
      },
      hasListeners() {
        return wrappers.size > 0 || hasAny()
      }
    })
  }

  // Electron's managed area exists but every call fails ("not available"); no policies set means empty.
  {
    const settle = (value: unknown, error: string | null, args: any[]): Promise<unknown> | undefined => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
      if (!callback) return error ? Promise.reject(new Error(error)) : Promise.resolve(value)
      queueMicrotask(() => (error ? ext.withLastError(error, () => callback()) : value === undefined ? callback() : callback(value)))
      return undefined
    }
    const readOnly = 'This is a read-only store.'
    ext.define(ext.namespace('storage.managed', true), {
      get: (...args: any[]) => settle({}, null, args),
      getKeys: (...args: any[]) => settle([], null, args),
      getBytesInUse: (...args: any[]) => settle(0, null, args),
      set: (...args: any[]) => settle(undefined, readOnly, args),
      remove: (...args: any[]) => settle(undefined, readOnly, args),
      clear: (...args: any[]) => settle(undefined, readOnly, args),
      setAccessLevel: (...args: any[]) => settle(undefined, 'This StorageArea is not available for setting access level', args),
      onChanged: ext.event('storage.managed.onChanged')
    })
  }
}

/**
 * omnibox.onInputChanged's `suggest` may be called any time later, without the listener returning
 * true as other response events need, so every listener counts as answering.
 */
export function installOmniboxSuggest(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.hasManifestKey('omnibox') || !chrome.omnibox) return
  const inner = ext.event('omnibox.onInputChanged', { response: true })
  const wrappers = new Map<(...args: any[]) => void, (text: string, respond: (value: unknown) => void) => boolean>()
  ext.define(chrome.omnibox as any, {
    onInputChanged: {
      addListener(callback: (text: string, suggest: (results: any[]) => void) => void) {
        if (typeof callback !== 'function') throw new TypeError('omnibox.onInputChanged.addListener needs a function.')
        if (wrappers.has(callback)) return
        const wrapper = (text: string, respond: (value: unknown) => void): boolean => {
          let done = false
          const suggest = (results: any[]): void => {
            if (done) return
            done = true
            const list = Array.isArray(results) ? results : []
            respond(
              list
                .filter((r) => r && typeof r === 'object')
                .map((r) => ({ content: String(r.content ?? ''), description: String(r.description ?? ''), deletable: r.deletable === true }))
            )
          }
          callback(text, suggest)
          return true
        }
        wrappers.set(callback, wrapper)
        inner.addListener(wrapper)
      },
      removeListener(callback: (...args: any[]) => void) {
        const wrapper = wrappers.get(callback)
        if (!wrapper) return
        wrappers.delete(callback)
        inner.removeListener(wrapper)
      },
      hasListener(callback: (...args: any[]) => void) {
        return wrappers.has(callback)
      },
      hasListeners() {
        return wrappers.size > 0
      }
    }
  })
}

/** identity.getRedirectURL returns its string right away. */
export function installIdentity(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('identity') || !chrome.identity) return
  ext.define(chrome.identity as any, {
    getRedirectURL(path?: string): string {
      const base = `https://${ext.id}.chromiumapp.org/`
      return typeof path === 'string' && path ? new URL(path.replace(/^\/+/, ''), base).href : base
    }
  })
}

/** runtime.connectNative (a Port, right away) and runtime.sendNativeMessage. */
export function installNativeMessaging(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('nativeMessaging') || !chrome.runtime) return
  const hostMessage = ext.event('nativeMessaging.onPortMessage')
  const hostDisconnect = ext.event('nativeMessaging.onPortDisconnect')
  let counter = 0

  const localEvent = (name: string): any => {
    const listeners = new Set<(...args: any[]) => void>()
    return {
      addListener(callback: (...args: any[]) => void) {
        if (typeof callback !== 'function') throw new TypeError(`${name}.addListener needs a function.`)
        listeners.add(callback)
      },
      removeListener(callback: (...args: any[]) => void) {
        listeners.delete(callback)
      },
      hasListener(callback: (...args: any[]) => void) {
        return listeners.has(callback)
      },
      hasListeners() {
        return listeners.size > 0
      },
      dispatch(...args: unknown[]) {
        for (const callback of [...listeners]) {
          try {
            callback(...args)
          } catch (err) {
            console.error(err)
          }
        }
      }
    }
  }
  const publicEvent = (e: any): any => ({
    addListener: e.addListener,
    removeListener: e.removeListener,
    hasListener: e.hasListener,
    hasListeners: e.hasListeners
  })

  function connectNative(application: string): chrome.runtime.Port {
    if (typeof application !== 'string') throw new TypeError('Error in invocation of runtime.connectNative(string application): No matching signature.')
    const portId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++counter}`
    const onMessage = localEvent('Port.onMessage')
    const onDisconnect = localEvent('Port.onDisconnect')
    let connected = true
    let started = false
    /** Messages posted before the host is running. */
    const queue: string[] = []

    const close = (): void => {
      connected = false
      hostMessage.removeListener(onHostMessage)
      hostDisconnect.removeListener(onHostDisconnect)
    }
    const lost = (error: string | null): void => {
      if (!connected) return
      close()
      if (error) ext.withLastError(error, () => onDisconnect.dispatch(port))
      else onDisconnect.dispatch(port)
    }
    const send = (json: string): void => {
      ext.call('nativeMessaging', 'post', [portId, json]).catch((err: Error) => lost(err.message))
    }
    function onHostMessage(id: string, message: unknown): void {
      if (id === portId && connected) onMessage.dispatch(message, port)
    }
    function onHostDisconnect(id: string, error: string | null): void {
      if (id === portId) lost(error)
    }

    const port = {
      name: application,
      sender: undefined,
      onMessage: publicEvent(onMessage),
      onDisconnect: publicEvent(onDisconnect),
      postMessage(message: unknown) {
        if (!connected) throw new Error('Attempting to use a disconnected port object')
        let json: string | undefined
        try {
          json = JSON.stringify(message)
        } catch {
          throw new Error('Could not serialize message.')
        }
        if (json === undefined) json = 'null'
        if (started) send(json)
        else queue.push(json)
      },
      disconnect() {
        if (!connected) return
        close()
        ext.call('nativeMessaging', 'disconnect', [portId]).catch(() => {})
      }
    } as unknown as chrome.runtime.Port

    // Listening first, so nothing the host sends right away is missed.
    hostMessage.addListener(onHostMessage, { portId })
    hostDisconnect.addListener(onHostDisconnect, { portId })
    ext.call('nativeMessaging', 'connect', [application, portId]).then(
      () => {
        started = true
        if (!connected) return void ext.call('nativeMessaging', 'disconnect', [portId]).catch(() => {})
        for (const json of queue.splice(0)) send(json)
      },
      (err: Error) => lost(err.message)
    )
    return port
  }

  ext.define(chrome.runtime as any, {
    connectNative,
    sendNativeMessage: ext.fn('nativeMessaging', 'send', {
      before: (args: any[]) => {
        if (typeof args[0] !== 'string') throw new Error('Error in invocation of runtime.sendNativeMessage: No matching signature.')
        return [args[0], JSON.stringify(args[1] ?? null)]
      }
    })
  })
}

export const DATA_INSTALLERS: (() => void)[] = [installStorageSync, installOmniboxSuggest, installIdentity, installNativeMessaging]
