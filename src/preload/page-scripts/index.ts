import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { PAGE_CHANNEL, type FramePlan, type RunAt, type RunRequest, type RunResult, type WorldSetup } from '@shared/page-scripts'
import { worldRuntime } from './world-runtime'

/**
 * Extension code in web pages, from each frame's preload (web frames of http, https and file
 * documents, top and sub): chrome.userScripts registrations and main-process injections
 * (userScripts.execute, chrome.scripting's activeTab fallback).
 *
 * At document start it asks the main process (synchronously) which user scripts match this frame
 * and runs them at their runAt: document_start as soon as <html> exists (still before any page
 * script), document_end at DOMContentLoaded, document_idle after load or 200ms after that.
 * USER_SCRIPT code runs in an Electron isolated world per extension and world id (with that
 * world's CSP, and chrome.runtime messaging over a contextBridge bridge when configured), MAIN
 * code in the page's world.
 */

function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

export function installPageScripts(): void {
  const token = randomToken()
  /** World id -> whether its chrome.runtime is installed. */
  const worlds = new Map<number, boolean>()
  const deliverers = new Map<string, (json: string) => void>()
  const cssKeys = new Map<string, string[]>()

  const worldKey = (kind: string, extensionId: string, worldId: string): string => `${kind}\n${extensionId}\n${worldId}`

  function setUpWorld(setup: WorldSetup): void {
    const { info, runtime } = setup
    if (!worlds.has(info.id)) {
      try {
        webFrame.setIsolatedWorldInfo(info.id, { name: info.name, securityOrigin: info.securityOrigin, csp: info.csp })
      } catch (err) {
        console.error('[extensions] could not set up a script world', err)
      }
      worlds.set(info.id, false)
    }
    if (!runtime || worlds.get(info.id)) return
    worlds.set(info.id, true)
    const key = worldKey(runtime.kind, runtime.extensionId, runtime.worldId)
    // Its messages carry who it is from here (not from the world), and this document's token.
    contextBridge.exposeInIsolatedWorld(info.id, runtime.bridgeKey, {
      post: (json: unknown) => {
        if (typeof json !== 'string') return
        ipcRenderer.send(PAGE_CHANNEL.fromWorld, { token, extensionId: runtime.extensionId, kind: runtime.kind, worldId: runtime.worldId, json })
      },
      subscribe: (fn: unknown) => {
        if (typeof fn === 'function') deliverers.set(key, fn as (json: string) => void)
      }
    })
    void webFrame
      .executeJavaScriptInIsolatedWorld(info.id, [{ code: `(${worldRuntime.toString()})(${JSON.stringify(runtime)});` }])
      .catch((err) => console.error('[extensions] could not set up chrome.runtime in a script world', err))
  }

  /** Runs one piece of code; the promise settles with its result. Starts synchronously. */
  function execute(world: WorldSetup | null, code: string, userGesture: boolean): Promise<unknown> {
    if (!world) return webFrame.executeJavaScript(code, userGesture)
    setUpWorld(world)
    return webFrame.executeJavaScriptInIsolatedWorld(world.info.id, [{ code }], userGesture)
  }

  // ---- registered user scripts ----

  let plan: FramePlan | null = null
  try {
    plan = ipcRenderer.sendSync(PAGE_CHANNEL.start, { token, url: location.href }) as FramePlan | null
  } catch (err) {
    console.error('[extensions] user scripts unavailable', err)
  }

  const runPhase = (runAt: RunAt): void => {
    for (const script of plan?.scripts ?? []) {
      if (script.runAt !== runAt) continue
      for (const code of script.sources) {
        try {
          // A script that throws reports to the console; the next one still runs.
          void execute(script.world, code, false).catch(() => {})
        } catch (err) {
          console.error(err)
        }
      }
    }
  }

  if (plan?.scripts.length) {
    const has = (runAt: RunAt): boolean => plan!.scripts.some((s) => s.runAt === runAt)
    // document_start: Chrome has <html> by then; it isn't there yet at preload time. The
    // observer's callback runs before the parser runs any page script.
    if (has('document_start')) {
      if (document.documentElement) runPhase('document_start')
      else {
        const observer = new MutationObserver(() => {
          if (!document.documentElement) return
          observer.disconnect()
          runPhase('document_start')
        })
        observer.observe(document, { childList: true })
      }
    }
    if (has('document_end') || has('document_idle')) {
      let idleDone = false
      const idle = (): void => {
        if (idleDone) return
        idleDone = true
        runPhase('document_idle')
      }
      const end = (): void => {
        runPhase('document_end')
        if (document.readyState === 'complete') idle()
        else {
          addEventListener('load', idle, { once: true })
          setTimeout(idle, 200)
        }
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', end, { once: true })
      else setTimeout(end, 0)
    }
  }

  // ---- requests from the main process ----

  const documentParsed = (): Promise<void> =>
    new Promise((resolve) => {
      if (document.readyState !== 'loading') return resolve()
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
      setTimeout(resolve, 30_000)
    })

  async function handle(req: RunRequest): Promise<RunResult> {
    if (req.token !== token) return { ok: false, error: 'The frame shows another document now.', scriptError: false }
    if (req.op === 'insertCSS' || req.op === 'removeCSS') {
      const key = req.cssKey ?? ''
      if (req.op === 'insertCSS') {
        const inserted = webFrame.insertCSS(req.css ?? '', { cssOrigin: req.cssOrigin === 'user' ? 'user' : 'author' })
        cssKeys.set(key, [...(cssKeys.get(key) ?? []), inserted])
      } else {
        const keys = cssKeys.get(key)
        const last = keys?.pop()
        if (keys && !keys.length) cssKeys.delete(key)
        if (last) webFrame.removeInsertedCSS(last)
      }
      return { ok: true, value: undefined }
    }
    if (req.waitForDocument) await documentParsed()
    let value: unknown
    try {
      for (const code of req.sources) value = await execute(req.world, code, req.userGesture)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), scriptError: true }
    }
    return { ok: true, value }
  }

  ipcRenderer.on(PAGE_CHANNEL.run, (_e, req: RunRequest) => {
    if (!req || typeof req.id !== 'number') return
    handle(req)
      .catch((err): RunResult => ({ ok: false, error: err instanceof Error ? err.message : String(err), scriptError: false }))
      .then((result) => {
        try {
          ipcRenderer.send(PAGE_CHANNEL.runResult, req.id, result)
        } catch {
          // A result IPC can't carry (a DOM node, a function): like Chrome, no result.
          ipcRenderer.send(PAGE_CHANNEL.runResult, req.id, { ok: true, value: null })
        }
      })
  })

  ipcRenderer.on(PAGE_CHANNEL.toWorld, (_e, envelope) => {
    if (!envelope || envelope.token !== token || typeof envelope.json !== 'string') return
    const deliver = deliverers.get(worldKey(envelope.kind, envelope.extensionId, envelope.worldId))
    if (!deliver) return
    try {
      deliver(envelope.json)
    } catch (err) {
      console.error(err)
    }
  })
}
