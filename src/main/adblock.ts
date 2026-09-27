import { app, type Session } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

let blocker: ElectronBlocker | null = null
let loading: Promise<ElectronBlocker | null> | null = null

function load(): Promise<ElectronBlocker | null> {
  loading ??= ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: join(app.getPath('userData'), 'adblock-engine.bin'),
    read: fs.readFile,
    write: fs.writeFile
  })
    .then((b) => {
      injectScriptletsOncePerPage(b)
      return (blocker = b)
    })
    .catch((err) => {
      console.error('[adblock] failed to load filter lists', err)
      loading = null
      return null
    })
  return loading
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Scriptlets that configure uBlock's shared helpers; they have to run before the rest. */
const isConfigScriptlet = (code: string): boolean => code.includes('function proxyApplyConfig(')

/**
 * Runs a page's scriptlets the way uBlock Origin does: once, together, in one private scope.
 *
 * The library injects each scriptlet as its own script, and each carries its own copy of
 * uBlock's helpers as global functions. Every copy then wraps Function.prototype.toString
 * again, and site-specific settings (like X's `skipToString`) never reach the copies that
 * matter. The stacked wrappers recurse forever, which breaks sites that inspect functions
 * (X's login) and is a classic ad-blocker tell. In one scope the helpers are shared, and
 * nothing leaks into the page's globals. The library can also ask for the same page's
 * scriptlets more than once, so each bundle runs at most once per document.
 */
function injectScriptletsOncePerPage(b: ElectronBlocker): void {
  const original = b.onInjectCosmeticFilters
  b.onInjectCosmeticFilters = async (event, url, msg) => {
    const scripts: string[] = []
    const sender = new Proxy(event.sender, {
      get(target, prop) {
        if (prop === 'executeJavaScript') {
          return (code: string) => {
            scripts.push(code)
            return Promise.resolve()
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    // The library calls executeJavaScript synchronously, once per scriptlet.
    await original({ ...event, sender } as typeof event, url, msg)
    if (!scripts.length || event.sender.isDestroyed()) return

    scripts.sort((a, c) => Number(isConfigScriptlet(c)) - Number(isConfigScriptlet(a)))
    // Plain concatenation, no per-script blocks: a function declared inside a block would
    // get a fresh copy each time, which is exactly the problem.
    const body = scripts.join('\n;\n')
    const key = hash(body)
    const bundle =
      `if (!(window[Symbol.for('browserr.scriptlets')] ??= new Set()).has('${key}')) {` +
      `window[Symbol.for('browserr.scriptlets')].add('${key}');\n(function () {\n${body}\n})();\n}`
    event.sender.executeJavaScript(bundle, true).catch(() => {})
  }
}

/** Our tab preload does the library's job (see src/preload/cosmetics.ts); drop its own copy. */
function removeLibraryPreload(ses: Session): void {
  for (const script of ses.getPreloadScripts()) {
    if (script.filePath.includes('adblocker-electron-preload')) ses.unregisterPreloadScript(script.id)
  }
}

export async function setAdblockEnabled(ses: Session, enabled: boolean): Promise<void> {
  if (enabled) {
    const b = await load()
    if (b && !b.isBlockingEnabled(ses)) {
      b.enableBlockingInSession(ses)
      removeLibraryPreload(ses)
    }
  } else if (blocker?.isBlockingEnabled(ses)) {
    try {
      blocker.disableBlockingInSession(ses)
    } catch {
      // It tries to unregister the preload we already removed.
    }
  }
}
