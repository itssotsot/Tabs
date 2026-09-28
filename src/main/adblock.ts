import { app, type Session } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'tldts'
import { onDomain } from '@shared/links'

/**
 * Sites that stop working with their ads blocked, so nothing is blocked on their pages. Spotify won't play a
 * song until its ad has played, and the filter lists can't skip the ad, only leave it stuck.
 */
const UNBLOCKED_SITES = ['spotify.com']

/** Whether ads are blocked on the page at `url`, while blocking is on. */
export function blocksAdsOn(url: string): boolean {
  try {
    return !onDomain(new URL(url).hostname, UNBLOCKED_SITES)
  } catch {
    return true
  }
}

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
      skipUnblockedSites(b)
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

/** How the library starts every scriptlet, before its helpers and its call (see its assembleScript). */
const PRELUDE = "if (typeof scriptletGlobals === 'undefined') { var scriptletGlobals = {}; }"

/** The code of every helper scriptlets share, longest first (so a helper found inside another goes with it). */
const helpersOf = new WeakMap<ElectronBlocker, string[]>()
function helpers(b: ElectronBlocker): string[] {
  let list = helpersOf.get(b)
  if (!list) {
    const { scriptlets } = b.resources
    const bodies = new Map(scriptlets.map((s) => [s.name, s.body]))
    const names = new Set(scriptlets.flatMap((s) => s.dependencies))
    list = [...names].flatMap((name) => bodies.get(name) ?? []).sort((x, y) => y.length - x.length)
    helpersOf.set(b, list)
  }
  return list
}

/**
 * Runs a page's scriptlets the way uBlock Origin does: once, together, in one private scope.
 *
 * The library makes each scriptlet its own script, carrying its own copy of uBlock's helpers.
 * Run apart, every copy wraps Function.prototype.toString again, and site-specific settings
 * (like X's `skipToString`) never reach the copies that matter. The stacked wrappers recurse
 * forever, which breaks sites that inspect functions (X's login) and is a classic ad-blocker
 * tell. So the bundle has each helper once, then every scriptlet's call. Helpers are function
 * and class declarations, so their order doesn't matter, but a class can't be declared twice:
 * pasting whole scriptlets together fails on pages with two that use one (YouTube's JSONPath).
 * The same bundle can arrive twice (see scriptletsFor), so each runs at most once per document.
 */
function bundle(b: ElectronBlocker, scripts: string[]): string {
  const used: string[] = []
  const calls = [...scripts]
    .sort((x, y) => Number(isConfigScriptlet(y)) - Number(isConfigScriptlet(x)))
    .map((script) => {
      let call = script.startsWith(PRELUDE) ? script.slice(PRELUDE.length) : script
      for (const helper of helpers(b)) {
        if (!call.includes(helper)) continue
        call = call.replace(helper, () => '')
        if (!used.includes(helper)) used.push(helper)
      }
      return call.replace(/^;+/, '')
    })
  const body = [PRELUDE, ...used, ...calls].join(';\n')
  const key = hash(body)
  return (
    `if (!(window[Symbol.for('browserr.scriptlets')] ??= new Set()).has('${key}')) {` +
    `window[Symbol.for('browserr.scriptlets')].add('${key}');\n(function () {\n${body}\n})();\n}`
  )
}

/** The page's scriptlets, bundled, or null if it has none (or is allowlisted). */
function pageScriptlets(b: ElectronBlocker, url: string): string | null {
  const { hostname, domain } = parse(url)
  const { active, scripts } = b.getCosmeticsFilters({
    url,
    hostname: hostname ?? '',
    domain: domain ?? '',
    getBaseRules: false,
    getInjectionRules: true,
    getExtendedRules: false,
    getRulesFromHostname: true,
    getRulesFromDOM: false
  })
  return active !== false && scripts.length ? bundle(b, scripts) : null
}

/**
 * The page's scriptlets, for its preload to run before the page's own scripts, as uBlock Origin does
 * (see src/preload/adblock.ts). Sent the library's way, they arrive after the page has started: YouTube's
 * player has read its ads by then. Null until the lists have loaded; pages then get them only the late way.
 */
export function scriptletsFor(ses: Session, url: string): string | null {
  return blocker?.isBlockingEnabled(ses) ? pageScriptlets(blocker, url) : null
}

/**
 * The library's element hiding, with our scriptlet bundle instead of its scriptlets. It's the same bundle
 * the preload may already have run, which the bundle then skips.
 */
function injectScriptletsOncePerPage(b: ElectronBlocker): void {
  const original = b.onInjectCosmeticFilters
  b.onInjectCosmeticFilters = async (event, url, msg) => {
    const sender = new Proxy(event.sender, {
      get(target, prop) {
        if (prop === 'executeJavaScript') return () => Promise.resolve()
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await original({ ...event, sender } as typeof event, url, msg)
    // Only the first call, as the page starts, has scriptlets; later ones are for elements it adds.
    if (msg !== undefined || event.sender.isDestroyed()) return
    const scriptlets = pageScriptlets(b, url)
    if (scriptlets) event.sender.executeJavaScript(scriptlets, true).catch(() => {})
  }
}

/** Lets through whatever the pages of UNBLOCKED_SITES load. (Their preload asks for no element hiding or scriptlets.) */
function skipUnblockedSites(b: ElectronBlocker): void {
  const onPage = (details: { webContents?: Electron.WebContents }): boolean => {
    const wc = details.webContents
    return !!wc && !wc.isDestroyed() && !blocksAdsOn(wc.getURL())
  }
  const { onBeforeRequest, onHeadersReceived } = b
  b.onBeforeRequest = (details, callback) => (onPage(details) ? callback({}) : onBeforeRequest(details, callback))
  b.onHeadersReceived = (details, callback) => (onPage(details) ? callback({}) : onHeadersReceived(details, callback))
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
