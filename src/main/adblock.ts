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

/**
 * The library can ask for the same page's scriptlets more than once. Running uBlock's
 * helpers twice makes them wrap Function.prototype.toString twice, which then recurses
 * forever (a classic ad-blocker tell that sites detect). Guard each script so it runs
 * at most once per document.
 */
function injectScriptletsOncePerPage(b: ElectronBlocker): void {
  const original = b.onInjectCosmeticFilters
  b.onInjectCosmeticFilters = (event, url, msg) => {
    const sender = new Proxy(event.sender, {
      get(target, prop) {
        if (prop === 'executeJavaScript') {
          return (code: string, userGesture?: boolean) => {
            const guarded =
              `if (!(window[Symbol.for('browserr.scriptlets')] ??= new Set()).has('${hash(code)}')) {` +
              `window[Symbol.for('browserr.scriptlets')].add('${hash(code)}');\n${code}\n}`
            return target.executeJavaScript(guarded, userGesture).catch(() => {})
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return original({ ...event, sender } as typeof event, url, msg)
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
