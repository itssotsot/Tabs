import { app, ipcMain, type Session } from 'electron'
import { ElectronBlocker, ENGINE_VERSION } from '@ghostery/adblocker-electron'
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

/**
 * Where the filter lists come from: the engines Ghostery builds for its own extension, rebuilt as uBlock Origin's
 * lists change (often daily for YouTube). The library's `fromPrebuilt…` lists are copies in its repo that go
 * months without an update, and sites like YouTube detect the blocker once its fixes fall behind.
 */
const ENGINES_URL = 'https://cdn.ghostery.com/adblocker/configs'
/** Ads (EasyList, uBlock's filters), tracking (EasyPrivacy, uBlock's privacy) and uBlock's quick fixes. */
const ENGINE_NAMES = ['dnr-ads-v2', 'dnr-tracking-v2', 'dnr-fixes-v2']
/** How often to look for newer lists while the app runs. */
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
/** How long after the lists load to first look for newer ones, so it doesn't compete with restoring tabs. */
const FIRST_UPDATE_MS = 15_000
/**
 * What the lists' `!#if` sections may count on, as uBlock Origin on Chromium. Filters that rewrite responses
 * (`$replace`, HTML filtering) need what Electron can't do; uBlock has scriptlets for the same things.
 */
const ENV = new Map([
  ['ext_ghostery', true],
  ['ext_ublock', true],
  ['env_chromium', true],
  ['cap_user_stylesheet', true]
])

interface EngineList {
  engines: Record<string, { url: string; checksum: string } | undefined>
  resourcesJson?: { url: string; checksum: string }
}

const enginePath = (): string => join(app.getPath('userData'), 'adblock-engine.bin')
/** What the saved engine was built from: its lists' checksums, to tell when there are newer ones. */
const sourcesPath = (): string => join(app.getPath('userData'), 'adblock-sources.json')

let blocker: ElectronBlocker | null = null
let loading: Promise<ElectronBlocker | null> | null = null
/** The sessions blocking is on in, to move to newer lists. */
const sessions = new Set<Session>()
let updateTimer: NodeJS.Timeout | null = null

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} for ${url}`)
  return (await response.json()) as T
}

async function getBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} for ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Sets up an engine the way this app uses it. */
function prepare(b: ElectronBlocker): ElectronBlocker {
  b.updateEnv(ENV)
  injectScriptletsOncePerPage(b)
  skipUnblockedSites(b)
  return b
}

/** The saved engine, or null if there's none this library can read (older format, damaged). */
async function readSaved(): Promise<ElectronBlocker | null> {
  try {
    return ElectronBlocker.deserialize(await fs.readFile(enginePath()))
  } catch {
    return null
  }
}

async function save(b: ElectronBlocker, sources: string | null): Promise<void> {
  try {
    await fs.writeFile(enginePath(), b.serialize())
    if (sources) await fs.writeFile(sourcesPath(), sources)
    else await fs.rm(sourcesPath(), { force: true })
  } catch (err) {
    console.error('[adblock] could not save the filter lists', err)
  }
}

/**
 * Ghostery's newest engines for this library's format, merged, unless they're what the saved engine was built
 * from (`known`). Null when nothing changed; throws when they can't be had.
 */
async function download(known: string | null): Promise<{ engine: ElectronBlocker; sources: string } | null> {
  const lists = await Promise.all(ENGINE_NAMES.map((name) => getJson<EngineList>(`${ENGINES_URL}/${name}/allowed-lists.json`)))
  const builds = lists.map((list, i) => {
    const build = list.engines[ENGINE_VERSION]
    if (!build) throw new Error(`no ${ENGINE_NAMES[i]} engine for version ${ENGINE_VERSION}`)
    return build
  })
  const resources = lists[0].resourcesJson
  if (!resources) throw new Error('no scriptlet resources')
  const sources = JSON.stringify({ version: ENGINE_VERSION, engines: builds.map((b) => b.checksum), resources: resources.checksum })
  if (sources === known) return null

  const [engines, resourcesText] = await Promise.all([
    Promise.all(builds.map(async (build) => ElectronBlocker.deserialize(await getBytes(build.url)))),
    fetch(resources.url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} for ${resources.url}`)
      return r.text()
    })
  ])
  const engine = ElectronBlocker.merge(engines, { skipResources: true })
  engine.updateResources(resourcesText, resources.checksum)
  return { engine, sources }
}

/** The saved lists if there are any, otherwise Ghostery's, otherwise the library's own copies. */
function load(): Promise<ElectronBlocker | null> {
  loading ??= (async () => {
    let b = await readSaved()
    if (!b) {
      try {
        const fresh = await download(null)
        if (fresh) {
          b = fresh.engine
          await save(b, fresh.sources)
        }
      } catch (err) {
        console.warn('[adblock] could not download the filter lists, using the built-in ones', err)
      }
    }
    if (!b) {
      b = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch)
      await save(b, null)
    }
    blocker = prepare(b)
    scheduleUpdates()
    return blocker
  })().catch((err) => {
    console.error('[adblock] failed to load filter lists', err)
    loading = null
    return null
  })
  return loading
}

function scheduleUpdates(): void {
  if (updateTimer) return
  updateTimer = setTimeout(function next() {
    void update().finally(() => (updateTimer = setTimeout(next, UPDATE_EVERY_MS)))
  }, FIRST_UPDATE_MS)
}

/** Moves to newer lists, if there are any. Pages already open keep their scriptlets until they load again. */
async function update(): Promise<void> {
  if (!blocker || !sessions.size) return
  try {
    const known = await fs.readFile(sourcesPath(), 'utf8').catch(() => null)
    const fresh = await download(known)
    if (!fresh) return
    await save(fresh.engine, fresh.sources)
    swap(prepare(fresh.engine))
    console.info('[adblock] updated the filter lists')
  } catch (err) {
    console.warn('[adblock] could not update the filter lists', err)
  }
}

function swap(next: ElectronBlocker): void {
  const previous = blocker
  blocker = next
  loading = Promise.resolve(next)
  for (const ses of sessions) {
    if (previous?.isBlockingEnabled(ses)) disable(previous, ses)
    next.enableBlockingInSession(ses)
    removeLibraryPreload(ses)
  }
}

function disable(b: ElectronBlocker, ses: Session): void {
  try {
    b.disableBlockingInSession(ses)
  } catch {
    // It tries to unregister the preload we already removed, and stops before its handlers.
  }
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
  ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')
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
    sessions.add(ses)
    const b = await load()
    // Turned off again while the lists loaded.
    if (b && sessions.has(ses) && !b.isBlockingEnabled(ses)) {
      b.enableBlockingInSession(ses)
      removeLibraryPreload(ses)
    }
  } else {
    sessions.delete(ses)
    if (blocker?.isBlockingEnabled(ses)) disable(blocker, ses)
  }
}
