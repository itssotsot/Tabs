// Registered on the web session for every frame and service worker. Only extension pages and
// extension background workers get anything: the chrome.* APIs Electron lacks, implemented in
// the main process (src/main/extensions) and reached over IPC.
import { contextBridge, ipcRenderer } from 'electron'
import { EXT_CHANNEL } from '@shared/extension-protocol'
import { installCore } from './extension-api/core'
import { ALL_INSTALLERS, ALL_SPECS } from './extension-api/index'
import { installNamespaces } from './extension-api/namespaces'
import { installPageScripts } from './page-scripts/index'

const isWorker = typeof window === 'undefined'

/** The page's or worker's URL. A worker's preload world has no `location`, so ask its own world. */
function contextUrl(): string {
  if (!isWorker) return globalThis.location?.href ?? ''
  try {
    return String(contextBridge.executeInMainWorld({ func: () => globalThis.location?.href ?? '' }) ?? '')
  } catch {
    return ''
  }
}

// Every page and service worker in the session gets this script; only extensions' ones are set up.
if (contextUrl().startsWith('chrome-extension://')) {
  type Dispatch = (name: string, args: unknown[], replyId: number | null, keys: number[] | null) => void
  let dispatch: Dispatch | null = null
  const early: Parameters<Dispatch>[] = []
  ipcRenderer.on(EXT_CHANNEL.event, (_e, name, args, replyId, keys) => {
    if (dispatch) dispatch(name, args, replyId, keys)
    else early.push([name, args, replyId, keys])
  })

  // A new document or worker: the main process forgets listeners from before.
  ipcRenderer.send(EXT_CHANNEL.hello)

  contextBridge.exposeInMainWorld('__tabsExtensionBridge', {
    call: (namespace: string, method: string, args: unknown[]) => ipcRenderer.invoke(EXT_CHANNEL.call, namespace, method, args),
    listen: (name: string, key: number, filter: unknown, add: boolean) => ipcRenderer.send(EXT_CHANNEL.listen, name, key, filter, add),
    reply: (replyId: number, value: unknown) => ipcRenderer.send(EXT_CHANNEL.reply, replyId, value),
    subscribe: (fn: Dispatch) => {
      dispatch = fn
      for (const item of early.splice(0)) fn(...item)
    }
  })

  try {
    contextBridge.executeInMainWorld({ func: installCore, args: [{ worker: isWorker }] })
    contextBridge.executeInMainWorld({ func: installNamespaces, args: [ALL_SPECS] })
    for (const install of ALL_INSTALLERS) {
      try {
        contextBridge.executeInMainWorld({ func: install })
      } catch (err) {
        console.error('[extensions] installer failed', err)
      }
    }
  } catch (err) {
    console.error('[extensions] could not set up the extension APIs', err)
  }

  // Runs after the worker's top-level script, so by now its listeners are registered. (The
  // preload world of a worker has no timers; the worker's own world does.)
  if (isWorker) {
    const ready = (): void => ipcRenderer.send(EXT_CHANNEL.ready)
    try {
      contextBridge.executeInMainWorld({ func: (cb: () => void) => void setTimeout(cb, 0), args: [ready] })
    } catch {
      ready()
    }
  }
} else if (!isWorker && /^(https?|file):$/.test(globalThis.location?.protocol ?? '')) {
  // Web pages (every frame): user scripts and the injections the main process does itself.
  try {
    installPageScripts()
  } catch (err) {
    console.error('[extensions] could not set up page scripts', err)
  }
}
