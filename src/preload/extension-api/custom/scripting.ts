/**
 * Installers for script injection and DevTools-protocol APIs. Each runs in the extension's world
 * (see core.ts): self-contained, using only the helper at `globalThis[Symbol.for('tabs.extensions')]`.
 */

/**
 * Electron's chrome.scripting doesn't honor activeTab (or optional host permissions granted later).
 * Calls Electron first; when it refuses for lack of host access, asks the main process, which
 * injects itself if the extension does have access to the tab. Functions can't cross IPC, so
 * `func` + `args` become source text here.
 */
export function installScriptingFallback(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('scripting') || !chrome.scripting) return
  const scripting = chrome.scripting as any
  const ACCESS_ERROR = /Cannot access contents of|must request permission to access/i

  const callNative = (native: (...args: any[]) => any, injection: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      try {
        native.call(scripting, injection, (result: unknown) => {
          const err = chrome.runtime.lastError
          if (err) reject(new Error(err.message))
          else resolve(result)
        })
      } catch (err) {
        reject(err)
      }
    })

  const forScript = (injection: any): unknown => {
    if (!injection || typeof injection !== 'object') return injection
    const out: Record<string, unknown> = { target: injection.target, world: injection.world, injectImmediately: injection.injectImmediately }
    const func = injection.func ?? injection.function
    if (typeof func === 'function') out.code = `(${func.toString()})(...${JSON.stringify(Array.isArray(injection.args) ? injection.args : [])})`
    else if (Array.isArray(injection.files)) out.files = injection.files
    return out
  }
  const forCss = (injection: any): unknown => {
    if (!injection || typeof injection !== 'object') return injection
    return { target: injection.target, css: injection.css, files: injection.files, origin: injection.origin }
  }

  const wrap = (name: string, prepare: (injection: any) => unknown): void => {
    const native = scripting[name]
    if (typeof native !== 'function') return
    ext.define(scripting, {
      [name](injection: unknown, callback?: (result?: unknown) => void) {
        const promise = callNative(native, injection).catch((err: unknown) => {
          const message = String((err as Error)?.message ?? err)
          if (!ACCESS_ERROR.test(message)) throw err
          return ext.call('scripting', `_${name}`, [prepare(injection), message])
        })
        if (typeof callback !== 'function') return promise
        promise.then(
          (result: unknown) => {
            try {
              if (result === undefined) callback()
              else callback(result)
            } catch (err) {
              console.error(err)
            }
          },
          (err: Error) => ext.withLastError(err.message, () => callback())
        )
        return undefined
      }
    })
  }
  wrap('executeScript', forScript)
  wrap('insertCSS', forCss)
  wrap('removeCSS', forCss)
}

/**
 * Scripts the fallback injects run in a world of our own, whose chrome.runtime.sendMessage arrives
 * as a router event. Every runtime.onMessage listener also listens to it (chaining the wrappers
 * added before), so it gets those messages like any content script's.
 */
export function installIsolatedWorldMessages(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('scripting')) return
  const native = (chrome.runtime as any)?.onMessage
  if (!native || typeof native.addListener !== 'function') return
  const add = native.addListener.bind(native)
  const remove = native.removeListener.bind(native)
  const has = native.hasListener.bind(native)
  const bridged = ext.event('tabsScripting.onIsolatedMessage', { response: true })
  const wrappers = new Map<(...args: any[]) => any, (...args: any[]) => any>()
  ext.define(native, {
    addListener(callback: (...args: any[]) => any, ...rest: unknown[]) {
      add(callback, ...rest)
      if (typeof callback !== 'function' || wrappers.has(callback)) return
      const w = function (this: unknown, message: unknown, sender: unknown, sendResponse: (value?: unknown) => void) {
        return callback.call(this, message, sender, sendResponse)
      }
      wrappers.set(callback, w)
      bridged.addListener(w)
    },
    removeListener(callback: (...args: any[]) => any) {
      remove(callback)
      const w = wrappers.get(callback)
      if (!w) return
      wrappers.delete(callback)
      bridged.removeListener(w)
    },
    hasListener(callback: (...args: any[]) => any) {
      return has(callback) || wrappers.has(callback)
    }
  })
}

/**
 * runtime.onUserScriptConnect: Electron's never fires. Ours gets connections from user scripts
 * (through the main process) and hands each listener a Port relayed by the main process.
 */
export function installUserScriptConnect(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('userScripts') || !chrome.runtime) return
  const raw = ext.event('tabsUserScripts.onConnect')
  const listeners = new Set<(port: any) => void>()
  const ports = new Map<string, { receive: (value: unknown) => void; close: () => void }>()

  const makeEvent = (): any => {
    const set = new Set<(...args: any[]) => void>()
    return {
      addListener: (fn: (...args: any[]) => void) => void (typeof fn === 'function' && set.add(fn)),
      removeListener: (fn: (...args: any[]) => void) => void set.delete(fn),
      hasListener: (fn: (...args: any[]) => void) => set.has(fn),
      hasListeners: () => set.size > 0,
      dispatch: (...args: unknown[]) => {
        for (const fn of [...set]) {
          try {
            fn(...args)
          } catch (err) {
            console.error(err)
          }
        }
      }
    }
  }

  const makePort = (id: string, name: string, sender: unknown): any => {
    const onMessage = makeEvent()
    const onDisconnect = makeEvent()
    let connected = true
    const port = {
      name,
      sender,
      onMessage,
      onDisconnect,
      postMessage(value: unknown) {
        if (!connected) throw new Error('Attempting to use a disconnected port object')
        ext.call('userScripts', '_portPost', [id, value === undefined ? null : value]).catch(() => {})
      },
      disconnect() {
        if (!connected) return
        connected = false
        ports.delete(id)
        ext.call('userScripts', '_portDisconnect', [id]).catch(() => {})
      }
    }
    ports.set(id, {
      receive: (value) => onMessage.dispatch(value, port),
      close: () => {
        if (!connected) return
        connected = false
        ports.delete(id)
        onDisconnect.dispatch(port)
      }
    })
    return port
  }

  ext.onInternal('__tabs.userScriptPort', (id: string, kind: string, value: unknown) => {
    const port = ports.get(id)
    if (!port) return
    if (kind === 'message') port.receive(value)
    else port.close()
  })

  const dispatcher = (id: string, name: string, sender: unknown): void => {
    if (!listeners.size || ports.has(id)) return
    const port = makePort(id, name, sender)
    ext.call('userScripts', '_portAccept', [id]).catch(() => ports.get(id)?.close())
    for (const listener of [...listeners]) {
      try {
        listener(port)
      } catch (err) {
        console.error(err)
      }
    }
  }

  ext.define(chrome.runtime as any, {
    onUserScriptConnect: {
      addListener(callback: (port: any) => void) {
        if (typeof callback !== 'function') throw new TypeError('runtime.onUserScriptConnect.addListener needs a function.')
        if (!listeners.size) raw.addListener(dispatcher)
        listeners.add(callback)
      },
      removeListener(callback: (port: any) => void) {
        listeners.delete(callback)
        if (!listeners.size) raw.removeListener(dispatcher)
      },
      hasListener: (callback: (port: any) => void) => listeners.has(callback),
      hasListeners: () => listeners.size > 0
    }
  })
}

/** pageCapture.saveAsMHTML gives a Blob; the main process sends the MHTML text. */
export function installPageCapture(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('pageCapture')) return
  ext.define(ext.namespace('pageCapture'), {
    saveAsMHTML: ext.fn('pageCapture', 'saveAsMHTML', {
      after: (data: unknown) => (typeof data === 'string' ? new Blob([data], { type: 'application/x-mimearchive' }) : undefined)
    })
  })
}

/** tabCapture.capture is Manifest V2 only; getMediaStreamId replaces it. */
export function installTabCaptureCapture(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('tabCapture') || !chrome.tabCapture) return
  const message = 'tabCapture.capture() is not supported. Use tabCapture.getMediaStreamId() with getUserMedia() instead.'
  ext.define(chrome.tabCapture as any, {
    capture(_options: unknown, callback?: (stream: MediaStream | null) => void) {
      if (typeof callback === 'function') {
        ext.withLastError(message, () => callback(null))
        return undefined
      }
      return Promise.reject(new Error(message))
    }
  })
}

export const SCRIPTING_INSTALLERS: (() => void)[] = [
  installScriptingFallback,
  installIsolatedWorldMessages,
  installUserScriptConnect,
  installPageCapture,
  installTabCaptureCapture
]
