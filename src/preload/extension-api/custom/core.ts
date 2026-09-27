/**
 * Installers that need more than a spec. Each runs in the extension's world (see core.ts):
 * self-contained, using only the helper at `globalThis[Symbol.for('tabs.extensions')]`.
 */

/** Electron fills sender.tab's window, index and active state in wrong; correct them from the main process's cache. */
export function installRuntimeSenderFix(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext) return
  const fixSender = (sender: any): void => {
    const id = sender?.tab?.id
    if (typeof id !== 'number') return
    const info = ext.tabsCache[id]
    if (info) Object.assign(sender.tab, info)
  }
  const wrap = (eventName: string, senderOf: (args: any[]) => any): void => {
    const native = (chrome.runtime as any)[eventName]
    if (!native || typeof native.addListener !== 'function') return
    const add = native.addListener.bind(native)
    const remove = native.removeListener.bind(native)
    const has = native.hasListener.bind(native)
    const wrapped = new Map<(...args: any[]) => any, (...args: any[]) => any>()
    ext.define(native, {
      addListener(callback: (...args: any[]) => any) {
        if (wrapped.has(callback)) return
        const w = function (this: unknown, ...args: any[]) {
          try {
            fixSender(senderOf(args))
          } catch {
            // Leave the sender as Electron made it.
          }
          return callback.apply(this, args)
        }
        wrapped.set(callback, w)
        add(w)
      },
      removeListener(callback: (...args: any[]) => any) {
        const w = wrapped.get(callback)
        wrapped.delete(callback)
        remove(w ?? callback)
      },
      hasListener(callback: (...args: any[]) => any) {
        return wrapped.has(callback) || has(callback)
      }
    })
  }
  wrap('onMessage', (args) => args[1])
  wrap('onMessageExternal', (args) => args[1])
  wrap('onConnect', (args) => args[0]?.sender)
  wrap('onConnectExternal', (args) => args[0]?.sender)
}

/** action.setIcon takes ImageData, which can't cross to the main process as is. */
export function installActionSetIcon(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.hasManifestKey('action') || !chrome.action) return
  const toPlain = (image: any): any => {
    if (!image || typeof image !== 'object') return image
    if (typeof image.width === 'number' && image.data && typeof image.data.length === 'number') {
      return { width: image.width, height: image.height, data: Array.from(image.data as ArrayLike<number>) }
    }
    const out: Record<string, unknown> = {}
    for (const [size, value] of Object.entries(image)) out[size] = toPlain(value)
    return out
  }
  ext.define(chrome.action as any, {
    setIcon: ext.fn('action', 'setIcon', {
      before: (args: any[]) => {
        const details = { ...(args[0] ?? {}) }
        if (details.imageData) details.imageData = toPlain(details.imageData)
        return [details]
      }
    })
  })
}

/** contextMenus.create returns the item's id right away, and items may carry an onclick handler. */
export function installContextMenus(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('contextMenus') || !chrome.contextMenus) return
  const handlers = new Map<string | number, (info: any, tab: any) => void>()
  let listening = false
  const listen = (): void => {
    if (listening) return
    listening = true
    ext.event('contextMenus.onClicked').addListener((info: any, tab: any) => {
      const handler = handlers.get(info?.menuItemId)
      if (handler) handler(info, tab)
    })
  }
  let counter = Math.floor(Math.random() * 1e6) * 1000
  const strip = (props: any): any => {
    const copy = { ...(props ?? {}) }
    delete copy.onclick
    return copy
  }
  const settle = (promise: Promise<unknown>, callback?: () => void): void => {
    promise.then(
      () => callback?.(),
      (err: Error) => {
        if (callback) ext.withLastError(err.message, callback)
        else console.error(err)
      }
    )
  }
  ext.define(chrome.contextMenus as any, {
    create(props: any, callback?: () => void) {
      const id = props?.id ?? ++counter
      if (typeof props?.onclick === 'function') {
        handlers.set(id, props.onclick)
        listen()
      }
      settle(ext.call('contextMenus', 'create', [{ ...strip(props), id }]), callback)
      return id
    },
    update(id: string | number, props: any, callback?: () => void) {
      if (typeof props?.onclick === 'function') {
        handlers.set(id, props.onclick)
        listen()
      }
      const p = ext.call('contextMenus', 'update', [id, strip(props)])
      if (typeof callback === 'function') return settle(p, callback)
      return p
    },
    remove(id: string | number, callback?: () => void) {
      handlers.delete(id)
      const p = ext.call('contextMenus', 'remove', [id])
      if (typeof callback === 'function') return settle(p, callback)
      return p
    },
    removeAll(callback?: () => void) {
      handlers.clear()
      const p = ext.call('contextMenus', 'removeAll', [])
      if (typeof callback === 'function') return settle(p, callback)
      return p
    }
  })
}

/** The rest of chrome.extension: old aliases and views. Other pages live in other processes, so only this one is visible. */
export function installExtensionExtras(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !chrome.extension) return
  const self = typeof window === 'undefined' ? null : window
  ext.define(chrome.extension as any, {
    getURL: (path: string) => chrome.runtime.getURL(path),
    getViews: (fetchProperties?: { type?: string }) => (self && (!fetchProperties?.type || fetchProperties.type === 'tab') ? [self] : []),
    getBackgroundPage: () => null,
    getExtensionTabs: () => (self ? [self] : [])
  })
}

export const CORE_INSTALLERS = [installRuntimeSenderFix, installActionSetIcon, installContextMenus, installExtensionExtras]
