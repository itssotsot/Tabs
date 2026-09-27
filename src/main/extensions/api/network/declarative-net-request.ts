import { app, type CallbackResponse, type Extension, type Session } from 'electron'
import { promises as fs } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { addBlockingHandler } from '../../../web-request-hub'
import { hasActiveTabGrant, hasApiPermission, hasHostAccess, manifestOf } from '../../access'
import { lifecycle, type LoadReason } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, hasListener, type CallContext } from '../../router'
import { getState, setState } from '../../state'
import { findTab, extraTabFor } from '../../tabs-model'
import { setRuleCountBadge } from '../action'
import {
  applyRequestHeaders,
  applyResponseHeaders,
  buildRuleset,
  evaluateRequest,
  evaluateResponse,
  ExtensionRules,
  isCompiledRule,
  isRegexSupported,
  KIND_ALLOW,
  KIND_BLOCK,
  KIND_NONE,
  KIND_REDIRECT,
  parseJsonArray,
  Query,
  requestHeaderPlan,
  Ruleset,
  type Hooks,
  type InheritedAllow,
  type Outcome
} from './dnr-engine'
import {
  compileRule,
  DYNAMIC_RULESET_ID,
  LIMITS,
  REQUEST_METHODS,
  RESOURCE_TYPES,
  RuleError,
  SchemaError,
  SESSION_RULESET_ID,
  type CompiledRule
} from './dnr-rules'
import {
  describeRequest,
  onDocumentCommitted,
  onWebContentsGone,
  originOf,
  stripFragment,
  tabInfo,
  watchNavigations,
  type ElectronDetails,
  type NetRequest
} from './request-info'

/**
 * chrome.declarativeNetRequest, entirely ours: Electron's native implementation stops working
 * as soon as the app registers any webRequest listener, which it always does. Rules are
 * matched by dnr-engine.ts in the web-request hub: onBeforeRequest for block, redirect, upgrade
 * and allow; onBeforeSendHeaders and onHeadersReceived for header changes and rules with
 * response header conditions.
 *
 * Static rulesets are read from the extension's files when it loads (a slice at a time, so a
 * few hundred thousand rules don't hold up startup); dynamic rules live in a file per extension
 * under userData and survive restarts and updates; session rules are in memory until the
 * extension unloads.
 */

type Rule = chrome.declarativeNetRequest.Rule

const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback']
const STATE_ENABLED = 'dnr.enabledRulesets'
const STATE_DISABLED = 'dnr.disabledRules'
const STATE_BADGE = 'dnr.badgeActionCount'
const STATE_INSTALL_TIME = 'dnr.installTime'
/** How long getMatchedRules remembers matches that aren't tied to a tab. */
const UNTABBED_MATCH_TTL = 5 * 60_000
const MAX_MATCH_RECORDS = 5000
/** Requests wait at most this long for rulesets that are still loading (Chrome holds them too). */
const LOAD_WAIT_MS = 3000

// ---- per-extension rules ----

interface ManifestRuleset {
  id: string
  path: string
  enabled: boolean
}

interface Entry {
  readonly id: string
  readonly rules: ExtensionRules
  readonly manifestRulesets: ManifestRuleset[]
  readonly folder: string
  /** Enabled static rulesets, in manifest order. */
  enabledIds: string[]
  readonly statics: Map<string, Ruleset>
  dynamicRules: Rule[]
  sessionRules: Rule[]
  dynamic: Ruleset | null
  session: Ruleset | null
  ready: Promise<void>
  /** Serializes changes. */
  queue: Promise<unknown>
  alive: boolean
}

const entries = new Map<string, Entry>()
const loading = new Set<Promise<void>>()
let loadGate: Promise<void> | null = null
let ses: Session | null = null

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function rulesDir(extensionId: string): string {
  return join(app.getPath('userData'), 'Extension Rules', extensionId)
}

function declaresDnr(extensionId: string): boolean {
  const m = manifestOf(extensionId)
  const declared = [...(m?.permissions ?? []), ...(m?.optional_permissions ?? [])]
  return DNR_PERMISSIONS.some((p) => declared.includes(p))
}

function manifestRulesets(extension: Extension): ManifestRuleset[] {
  const resources = (extension.manifest as { declarative_net_request?: { rule_resources?: unknown } }).declarative_net_request?.rule_resources
  if (!Array.isArray(resources)) return []
  const seen = new Set<string>()
  const out: ManifestRuleset[] = []
  for (const r of resources.slice(0, LIMITS.MAX_NUMBER_OF_STATIC_RULESETS)) {
    if (!r || typeof r !== 'object') continue
    const { id, path, enabled } = r as Record<string, unknown>
    if (typeof id !== 'string' || !id || id.startsWith('_') || seen.has(id) || typeof path !== 'string') continue
    seen.add(id)
    out.push({ id, path, enabled: enabled === true })
  }
  return out
}

function createEntry(extension: Extension): Entry {
  const rules = new ExtensionRules(extension.id)
  let installTime = getState<number | undefined>(extension.id, STATE_INSTALL_TIME, undefined)
  if (installTime === undefined) {
    installTime = Date.now()
    setState(extension.id, STATE_INSTALL_TIME, installTime)
  }
  rules.installTime = installTime
  const manifest = manifestRulesets(extension)
  const saved = getState<string[] | undefined>(extension.id, STATE_ENABLED, undefined)
  const enabledIds = saved ? manifest.filter((r) => saved.includes(r.id)).map((r) => r.id) : manifest.filter((r) => r.enabled).map((r) => r.id)
  const disabled = getState<Record<string, number[]>>(extension.id, STATE_DISABLED, {})
  for (const [rulesetId, ids] of Object.entries(disabled)) if (ids.length) rules.disabled.set(rulesetId, new Set(ids))
  return {
    id: extension.id,
    rules,
    manifestRulesets: manifest,
    folder: normalize(extension.path),
    enabledIds,
    statics: new Map(),
    dynamicRules: [],
    sessionRules: [],
    dynamic: null,
    session: null,
    ready: Promise.resolve(),
    queue: Promise.resolve(),
    alive: true
  }
}

/** The extension's rules, loading them first if needed. */
async function entryFor(call: CallContext): Promise<Entry> {
  let entry = entries.get(call.extensionId)
  if (!entry) {
    entry = createEntry(call.extension)
    entries.set(entry.id, entry)
    startLoading(entry)
  }
  await entry.ready
  return entry
}

function mutate<T>(entry: Entry, fn: () => Promise<T> | T): Promise<T> {
  const run = entry.queue.then(fn, fn)
  entry.queue = run.catch(() => undefined)
  return run
}

function rebuild(entry: Entry): void {
  const rulesets: Ruleset[] = []
  for (const id of entry.enabledIds) {
    const rs = entry.statics.get(id)
    if (rs) rulesets.push(rs)
  }
  if (entry.dynamic?.count) rulesets.push(entry.dynamic)
  if (entry.session?.count) rulesets.push(entry.session)
  entry.rules.rulesets = rulesets
  activeCache = null
}

function staticRuleCount(entry: Entry): number {
  let n = 0
  for (const id of entry.enabledIds) n += entry.statics.get(id)?.count ?? 0
  return n
}

/** Static rules this extension may have enabled: its guaranteed share plus what's left of the global pool. */
function staticRuleAllowance(entry: Entry): number {
  let othersExcess = 0
  for (const other of entries.values()) {
    if (other !== entry) othersExcess += Math.max(0, staticRuleCount(other) - LIMITS.GUARANTEED_MINIMUM_STATIC_RULES)
  }
  return LIMITS.GUARANTEED_MINIMUM_STATIC_RULES + Math.max(0, LIMITS.GLOBAL_STATIC_RULE_LIMIT - othersExcess)
}

async function loadStatic(entry: Entry, id: string): Promise<Ruleset | null> {
  const def = entry.manifestRulesets.find((r) => r.id === id)
  if (!def) return null
  const file = normalize(join(entry.folder, def.path))
  if (!file.startsWith(entry.folder + sep)) return null
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    console.warn(`[declarativeNetRequest] ${entry.id}: can't read ruleset "${id}"`, err)
    return null
  }
  let invalid = 0
  try {
    return await buildRuleset(id, text, {
      scope: 'static',
      maxRegexRules: LIMITS.MAX_NUMBER_OF_REGEX_RULES,
      pause,
      onInvalid: (message) => {
        if (++invalid <= 3) console.warn(`[declarativeNetRequest] ${entry.id}: ruleset "${id}": ${message}`)
      }
    })
  } catch (err) {
    console.warn(`[declarativeNetRequest] ${entry.id}: ruleset "${id}" isn't valid JSON`, err)
    return null
  }
}

async function readDynamic(entry: Entry): Promise<void> {
  let text: string
  try {
    text = await fs.readFile(join(rulesDir(entry.id), 'dynamic.json'), 'utf8')
  } catch {
    return
  }
  const ruleset = new Ruleset(DYNAMIC_RULESET_ID)
  const kept: Rule[] = []
  const ids = new Set<number>()
  try {
    await parseJsonArray(
      text,
      (items) => {
        for (const raw of items) {
          try {
            const rule = compileRule(raw, { scope: 'dynamic', rulesetId: DYNAMIC_RULESET_ID })
            if (ids.has(rule.id)) continue
            ids.add(rule.id)
            ruleset.add(rule)
            kept.push(raw as Rule)
          } catch {
            // Saved by an older version with different rules; drop it.
          }
        }
      },
      pause
    )
  } catch (err) {
    console.warn(`[declarativeNetRequest] ${entry.id}: dynamic rules unreadable`, err)
    return
  }
  entry.dynamicRules = kept
  entry.dynamic = ruleset
}

function startLoading(entry: Entry): void {
  const load = (async () => {
    await readDynamic(entry)
    if (!entry.alive) return
    rebuild(entry)
    const loaded: string[] = []
    const allowance = staticRuleAllowance(entry)
    let total = 0
    for (const id of entry.enabledIds.slice(0, LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS)) {
      const rs = await loadStatic(entry, id)
      if (!entry.alive) return
      if (!rs) continue
      if (total + rs.count > allowance) {
        console.warn(`[declarativeNetRequest] ${entry.id}: ruleset "${id}" exceeds the static rule limit; not enabled`)
        continue
      }
      total += rs.count
      entry.statics.set(id, rs)
      loaded.push(id)
      // Each ruleset starts working as soon as it's in.
      rebuild(entry)
    }
    entry.enabledIds = loaded
    rebuild(entry)
  })().catch((err) => console.error(`[declarativeNetRequest] ${entry.id}: loading rules failed`, err))
  entry.ready = load
  loading.add(load)
  loadGate = null
  void load.finally(() => {
    loading.delete(load)
    loadGate = null
  })
}

async function persistDynamic(entry: Entry, rules: Rule[]): Promise<void> {
  const dir = rulesDir(entry.id)
  try {
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, 'dynamic.json')
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(rules))
    await fs.rename(tmp, file)
  } catch (err) {
    console.error(`[declarativeNetRequest] ${entry.id}: saving dynamic rules failed`, err)
    throw new ExtensionError('Internal error while updating dynamic rules.')
  }
}

// ---- which extensions act on requests ----

interface Perms {
  dnr: boolean
  hostOnly: boolean
  feedback: boolean
  activeTab: boolean
  at: number
}

const permsCache = new Map<string, Perms>()

function perms(extensionId: string): Perms {
  const now = Date.now()
  let p = permsCache.get(extensionId)
  if (!p || now - p.at > 2000) {
    const dnr = hasApiPermission(extensionId, 'declarativeNetRequest')
    const withHost = hasApiPermission(extensionId, 'declarativeNetRequestWithHostAccess')
    p = {
      dnr: dnr || withHost,
      hostOnly: withHost && !dnr,
      feedback: hasApiPermission(extensionId, 'declarativeNetRequestFeedback'),
      activeTab: hasApiPermission(extensionId, 'activeTab'),
      at: now
    }
    permsCache.set(extensionId, p)
  }
  return p
}

let activeCache: ExtensionRules[] | null = null
let activeAt = 0

/** Extensions with rules, most recently installed first (they win ties). */
function activeExtensions(): ExtensionRules[] {
  const now = Date.now()
  if (!activeCache || now - activeAt > 2000) {
    const list: ExtensionRules[] = []
    for (const entry of entries.values()) {
      if (!entry.rules.rulesets.length) continue
      const p = perms(entry.id)
      if (!p.dnr) continue
      entry.rules.hostRequiredForAll = p.hostOnly
      list.push(entry.rules)
    }
    list.sort((a, b) => b.installTime - a.installTime)
    activeCache = list
    activeAt = now
  }
  return activeCache
}

/** Redirects and header changes need host access to the request's URL and its initiator. */
function hostAccessTo(extensionId: string, req: { url: string; initiator?: string; type: string; tabId: number }): boolean {
  const tabId = req.tabId >= 0 ? req.tabId : undefined
  if (!hasHostAccess(extensionId, req.url, tabId)) return false
  if (req.type !== 'main_frame' && req.initiator && req.initiator !== 'null' && !hasHostAccess(extensionId, `${req.initiator}/`, tabId)) return false
  return true
}

// ---- allowAllRequests: frames whose document was allowed ----

/** Frame key -> extension -> the allowAllRequests rule its current document matched. */
const frameAllows = new Map<string, Map<string, InheritedAllow>>()

function recordFrame(req: NetRequest, outcome: Outcome): void {
  const key = req.type === 'main_frame' ? `m:${req.webContentsId}` : null
  const own = key ?? (req.frameId > 0 ? `f:${req.frameId}` : null)
  if (!own) return
  let map: Map<string, InheritedAllow> | undefined
  if (outcome.kind !== KIND_BLOCK && outcome.kind !== KIND_REDIRECT) {
    for (const r of outcome.results) {
      if (!r.allowAll) continue
      map ??= new Map()
      map.set(r.ext.id, { rank: r.allowAll.rank, ruleId: r.allowAll.id, rulesetId: r.allowAll.rulesetId })
    }
  }
  if (map) {
    frameAllows.delete(own)
    frameAllows.set(own, map)
    if (frameAllows.size > 2000) frameAllows.delete(frameAllows.keys().next().value as string)
  } else {
    frameAllows.delete(own)
  }
}

function inheritedFor(req: NetRequest, extensionId: string): InheritedAllow | undefined {
  let best: InheritedAllow | undefined
  for (const key of req.frameChain) {
    const allow = frameAllows.get(key)?.get(extensionId)
    if (allow && (!best || allow.rank > best.rank)) best = allow
  }
  return best
}

function hooksFor(req: NetRequest): Hooks {
  const access = new Map<string, boolean>()
  return {
    hostAccess: (ext) => {
      let v = access.get(ext.id)
      if (v === undefined) access.set(ext.id, (v = hostAccessTo(ext.id, req)))
      return v
    },
    inherited: frameAllows.size && req.frameChain.length ? (ext) => inheritedFor(req, ext.id) : undefined
  }
}

// ---- matched rules, action counts, onRuleMatchedDebug ----

interface MatchRecord {
  ruleId: number
  rulesetId: string
  tabId: number
  timeStamp: number
  /** Matched by a main-frame request whose document hasn't committed yet. */
  pending: boolean
}

const matchRecords = new Map<string, MatchRecord[]>()
/** extension -> tab -> actions taken on the tab's current page. */
const actionCounts = new Map<string, Map<number, number>>()
/** The same for main-frame requests of navigations still in progress. */
const pendingCounts = new Map<string, Map<number, number>>()
/** tab -> the main-frame request in progress, whose matches wait for its document to commit. */
const navigationRequests = new Map<number, string>()
const dirtyBadges = new Set<string>()
let badgeTimer: NodeJS.Immediate | null = null

function bump(map: Map<string, Map<number, number>>, extensionId: string, tabId: number, by: number): number {
  let tabs = map.get(extensionId)
  if (!tabs) map.set(extensionId, (tabs = new Map()))
  const n = Math.max(0, (tabs.get(tabId) ?? 0) + by)
  tabs.set(tabId, n)
  return n
}

function badgeEnabled(extensionId: string): boolean {
  return getState<boolean>(extensionId, STATE_BADGE, false)
}

function scheduleBadge(extensionId: string, tabId: number): void {
  if (tabId < 0 || !badgeEnabled(extensionId)) return
  dirtyBadges.add(`${extensionId}|${tabId}`)
  badgeTimer ??= setImmediate(() => {
    badgeTimer = null
    for (const key of dirtyBadges) {
      const [extensionId, tab] = key.split('|')
      const tabId = Number(tab)
      if (!badgeEnabled(extensionId)) continue
      const count = actionCounts.get(extensionId)?.get(tabId) ?? 0
      try {
        setRuleCountBadge(extensionId, tabId, count > 0 ? String(count) : null)
      } catch (err) {
        console.error('[declarativeNetRequest] badge update failed', err)
      }
    }
    dirtyBadges.clear()
  })
}

interface RequestState {
  req: NetRequest
  q: Query
  outcome: Outcome | null
  /** Rules already reported for this request (a rule counts once per request). */
  reported: Set<unknown>
}

const requestStates = new Map<number, RequestState>()

function keepState(id: number, state: RequestState): void {
  requestStates.delete(id)
  requestStates.set(id, state)
  if (requestStates.size > 4096) requestStates.delete(requestStates.keys().next().value as number)
}

/** A rule's action was taken: remember it for getMatchedRules, count it, tell onRuleMatchedDebug. */
function report(state: RequestState, extensionId: string, rule: CompiledRule | InheritedAllow, allow: boolean): void {
  const ruleId = isCompiledRule(rule) ? rule.id : rule.ruleId
  const rulesetId = rule.rulesetId
  if (ruleId < 0 || state.reported.has(rule)) return
  state.reported.add(rule)
  const { req } = state
  const now = Date.now()
  const p = perms(extensionId)
  const mainFrame = req.type === 'main_frame'
  if (p.feedback || p.activeTab) {
    let list = matchRecords.get(extensionId)
    if (!list) matchRecords.set(extensionId, (list = []))
    list.push({ ruleId, rulesetId, tabId: req.tabId, timeStamp: now, pending: mainFrame && req.tabId >= 0 })
    if (list.length > MAX_MATCH_RECORDS) list.splice(0, list.length - MAX_MATCH_RECORDS)
  }
  if (!allow && req.tabId >= 0) {
    if (mainFrame) bump(pendingCounts, extensionId, req.tabId, 1)
    else {
      bump(actionCounts, extensionId, req.tabId, 1)
      scheduleBadge(extensionId, req.tabId)
    }
  }
  if (p.feedback && hasListener('declarativeNetRequest.onRuleMatchedDebug', extensionId)) {
    emit('declarativeNetRequest.onRuleMatchedDebug', [{ request: requestDetails(req), rule: { ruleId, rulesetId } }], { extensionId })
  }
}

function requestDetails(req: NetRequest): chrome.declarativeNetRequest.RequestDetails {
  const d: Record<string, unknown> = {
    requestId: req.requestId,
    url: req.url,
    method: req.method,
    frameId: req.frameId,
    parentFrameId: req.parentFrameId,
    tabId: req.tabId,
    type: req.type,
    frameType: req.frameType,
    documentLifecycle: 'active'
  }
  if (req.initiator !== undefined) d.initiator = req.initiator
  if (req.documentId) d.documentId = req.documentId
  if (req.parentDocumentId) d.parentDocumentId = req.parentDocumentId
  return d as unknown as chrome.declarativeNetRequest.RequestDetails
}

/** A new navigation started in a tab: forget what an earlier one that never committed (a download, a 204) matched. */
function startNavigation(req: NetRequest): void {
  if (req.tabId < 0 || navigationRequests.get(req.tabId) === req.requestId) return
  navigationRequests.set(req.tabId, req.requestId)
  for (const tabs of pendingCounts.values()) tabs.delete(req.tabId)
  for (const [extensionId, list] of matchRecords) {
    if (list.some((r) => r.pending && r.tabId === req.tabId)) matchRecords.set(extensionId, list.filter((r) => !(r.pending && r.tabId === req.tabId)))
  }
}

/** A tab's page committed: counts and matched rules start over (keeping what its own main-frame request did). */
function onCommitted(webContentsId: number): void {
  const { tabId } = tabInfo(webContentsId)
  if (tabId < 0) return
  navigationRequests.delete(tabId)
  for (const [extensionId, tabs] of actionCounts) {
    if (tabs.has(tabId) && !pendingCounts.get(extensionId)?.has(tabId)) {
      tabs.delete(tabId)
      scheduleBadge(extensionId, tabId)
    }
  }
  for (const [extensionId, tabs] of pendingCounts) {
    const n = tabs.get(tabId)
    if (n === undefined) continue
    tabs.delete(tabId)
    bump(actionCounts, extensionId, tabId, 0)
    actionCounts.get(extensionId)!.set(tabId, n)
    scheduleBadge(extensionId, tabId)
  }
  for (const [extensionId, list] of matchRecords) {
    const kept = list.filter((r) => r.tabId !== tabId || r.pending)
    for (const r of kept) if (r.tabId === tabId) r.pending = false
    matchRecords.set(extensionId, kept)
  }
}

function onGone(webContentsId: number): void {
  frameAllows.delete(`m:${webContentsId}`)
  navigationRequests.delete(webContentsId)
  for (const tabs of actionCounts.values()) tabs.delete(webContentsId)
  for (const tabs of pendingCounts.values()) tabs.delete(webContentsId)
  for (const [extensionId, list] of matchRecords) matchRecords.set(extensionId, list.filter((r) => r.tabId !== webContentsId))
}

// ---- request stages ----

const VISIBLE_URL = /^(https?|wss?):/i

function waitForLoads(): Promise<void> | null {
  if (!loading.size) return null
  loadGate ??= Promise.race([Promise.all([...loading]).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, LOAD_WAIT_MS))])
  return loadGate
}

function onBeforeRequest(details: ElectronDetails): CallbackResponse | undefined | Promise<CallbackResponse | undefined> {
  if (!VISIBLE_URL.test(details.url)) return undefined
  const wait = waitForLoads()
  if (wait) return wait.then(() => beforeRequest(details))
  return beforeRequest(details)
}

function beforeRequest(details: ElectronDetails): CallbackResponse | undefined {
  requestStates.delete(details.id)
  const all = activeExtensions()
  if (!all.length) return undefined
  const req = describeRequest(details)
  if (!req || req.hidden) return undefined
  // Requests an extension makes are only seen by that extension.
  const exts = req.initiatorExtension ? all.filter((e) => e.id === req.initiatorExtension) : all
  if (!exts.length) return undefined
  const q = new Query({ url: req.url, type: req.type, method: req.method, tabId: req.tabId, initiator: req.initiator, topUrl: req.topUrl })
  const outcome = evaluateRequest(q, exts, hooksFor(req))
  if (req.type === 'main_frame') startNavigation(req)
  if (req.type === 'main_frame' || req.type === 'sub_frame') recordFrame(req, outcome)
  const state: RequestState = { req, q, outcome, reported: new Set() }
  if (outcome.results.some((r) => r.modify.length) || exts.some((e) => e.hasHeaderStageRules)) keepState(details.id, state)
  if (outcome.winner?.rule) report(state, outcome.winner.ext.id, outcome.winner.rule, outcome.kind === KIND_ALLOW)
  if (outcome.kind === KIND_BLOCK) return { cancel: true }
  if (outcome.kind === KIND_REDIRECT && outcome.redirectUrl) return { redirectURL: outcome.redirectUrl }
  return undefined
}

function onBeforeSendHeaders(details: ElectronDetails & { requestHeaders: Record<string, string> }): { requestHeaders: Record<string, string> } | undefined {
  const state = requestStates.get(details.id)
  if (!state?.outcome) return undefined
  const plan = requestHeaderPlan(state.outcome)
  if (!plan.length) return undefined
  const { headers, applied } = applyRequestHeaders(details.requestHeaders, plan)
  if (!applied.length) return undefined
  for (const a of applied) report(state, a.ext.id, a.rule, false)
  return { requestHeaders: headers }
}

function onHeadersReceived(
  details: ElectronDetails & { statusLine: string; statusCode: number; responseHeaders?: Record<string, string[]> }
): { cancel?: boolean; responseHeaders?: Record<string, string[]>; statusLine?: string } | undefined {
  let state = requestStates.get(details.id)
  requestStates.delete(details.id)
  if (!state) {
    if (!VISIBLE_URL.test(details.url)) return undefined
    const exts = activeExtensions().filter((e) => e.hasHeaderStageRules)
    if (!exts.length) return undefined
    const req = describeRequest(details)
    if (!req || req.hidden) return undefined
    const q = new Query({ url: req.url, type: req.type, method: req.method, tabId: req.tabId, initiator: req.initiator, topUrl: req.topUrl })
    state = { req, q, outcome: null, reported: new Set() }
  }
  const { req, q } = state
  const exts = state.outcome
    ? state.outcome.results.map((r) => r.ext)
    : activeExtensions().filter((e) => !req.initiatorExtension || e.id === req.initiatorExtension)
  if (!exts.length) return undefined
  const headers = details.responseHeaders ?? {}
  q.setResponseHeaders(headers)
  const response = evaluateResponse(q, exts, hooksFor(req), state.outcome)
  if (response.winner?.rule && response.kind !== KIND_NONE) report(state, response.winner.ext.id, response.winner.rule, response.kind === KIND_ALLOW)
  if (response.kind === KIND_BLOCK) return { cancel: true }
  if (response.kind === KIND_REDIRECT && response.redirectUrl) {
    // Turns the response into a redirect, which the network stack then follows.
    const out: Record<string, string[]> = {}
    for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== 'location') out[name] = value
    out.Location = [response.redirectUrl]
    return { responseHeaders: out, statusLine: 'HTTP/1.1 302 Found' }
  }
  if (!response.plan.length) return undefined
  const { headers: changed, applied } = applyResponseHeaders(headers, response.plan)
  if (!applied.length) return undefined
  for (const a of applied) report(state, a.ext.id, a.rule, false)
  return { responseHeaders: changed }
}

// ---- API ----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function paramError(param: string, message: string): ExtensionError {
  return new ExtensionError(`Error in invocation: Error at parameter '${param}': ${message}`)
}

function numberList(value: unknown, param: string, key: string): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isInteger(v))) {
    throw paramError(param, `Error at property '${key}': Invalid type: expected array of integers.`)
  }
  return value as number[]
}

function stringList(value: unknown, param: string, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw paramError(param, `Error at property '${key}': Invalid type: expected array of strings.`)
  return value as string[]
}

function asError(err: unknown): never {
  if (err instanceof RuleError || err instanceof SchemaError) throw new ExtensionError(err.message)
  throw err
}

interface UpdateResult {
  rules: Rule[]
  ruleset: Ruleset
}

/** Removes, then adds, validating everything before anything changes. */
function updatedRules(current: Rule[], options: unknown, scope: 'dynamic' | 'session'): UpdateResult {
  if (!isObject(options)) throw paramError('options', 'Invalid type: expected declarativeNetRequest.UpdateRuleOptions.')
  const remove = new Set(numberList(options.removeRuleIds, 'options', 'removeRuleIds'))
  if (options.addRules !== undefined && !Array.isArray(options.addRules)) throw paramError('options', "Error at property 'addRules': Invalid type: expected array.")
  const add = (options.addRules as unknown[] | undefined) ?? []
  const rulesetId = scope === 'dynamic' ? DYNAMIC_RULESET_ID : SESSION_RULESET_ID
  const ruleset = new Ruleset(rulesetId)
  const kept = current.filter((r) => !remove.has(r.id))
  const ids = new Set<number>()
  for (const raw of kept) {
    ids.add(raw.id)
    try {
      ruleset.add(compileRule(raw, { scope, rulesetId }))
    } catch {
      // Stored before a validation change; it stays listed but can't match.
    }
  }
  const added: Rule[] = []
  add.forEach((raw, i) => {
    let rule: CompiledRule
    try {
      rule = compileRule(raw, { scope, rulesetId, strict: true }, `Error at parameter 'options': Error at property 'addRules': Error at index ${i}: `)
    } catch (err) {
      asError(err)
    }
    if (ids.has(rule.id)) throw new ExtensionError(`Rule with id ${rule.id} does not have a unique ID.`)
    ids.add(rule.id)
    ruleset.add(rule)
    added.push(JSON.parse(JSON.stringify(raw)) as Rule)
  })
  return { rules: [...kept, ...added], ruleset }
}

function filterRules(rules: Rule[], filter: unknown): Rule[] {
  if (filter !== undefined && filter !== null && !isObject(filter)) throw paramError('filter', 'Invalid type: expected declarativeNetRequest.GetRulesFilter.')
  const ids = isObject(filter) && filter.ruleIds !== undefined ? new Set(numberList(filter.ruleIds, 'filter', 'ruleIds')) : null
  const list = ids ? rules.filter((r) => ids.has(r.id)) : rules
  return JSON.parse(JSON.stringify(list)) as Rule[]
}

function checkRulesetId(entry: Entry, id: unknown): string {
  if (typeof id !== 'string' || !entry.manifestRulesets.some((r) => r.id === id)) throw new ExtensionError(`Invalid ruleset id: ${String(id)}.`)
  return id
}

function regexCount(dynamic: Ruleset | null, session: Ruleset | null): number {
  return (dynamic?.regexCount ?? 0) + (session?.regexCount ?? 0)
}

defineApi('declarativeNetRequest', {
  permissions: DNR_PERMISSIONS,
  methods: {
    async updateDynamicRules(call, options: unknown) {
      const entry = await entryFor(call)
      return mutate(entry, async () => {
        const { rules, ruleset } = updatedRules(entry.dynamicRules, options, 'dynamic')
        if (ruleset.count > LIMITS.MAX_NUMBER_OF_DYNAMIC_RULES) throw new ExtensionError('Dynamic rule count exceeded.')
        if (ruleset.unsafeCount > LIMITS.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES) throw new ExtensionError('Dynamic unsafe rule count exceeded.')
        if (regexCount(ruleset, entry.session) > LIMITS.MAX_NUMBER_OF_REGEX_RULES) throw new ExtensionError('Dynamic rule count for regex rules exceeded.')
        await persistDynamic(entry, rules)
        entry.dynamicRules = rules
        entry.dynamic = ruleset
        rebuild(entry)
      })
    },

    async getDynamicRules(call, filter: unknown) {
      const entry = await entryFor(call)
      return filterRules(entry.dynamicRules, filter)
    },

    async updateSessionRules(call, options: unknown) {
      const entry = await entryFor(call)
      return mutate(entry, () => {
        const { rules, ruleset } = updatedRules(entry.sessionRules, options, 'session')
        if (ruleset.count > LIMITS.MAX_NUMBER_OF_SESSION_RULES) throw new ExtensionError('Session rule count exceeded.')
        if (ruleset.unsafeCount > LIMITS.MAX_NUMBER_OF_UNSAFE_SESSION_RULES) throw new ExtensionError('Session unsafe rule count exceeded.')
        if (regexCount(entry.dynamic, ruleset) > LIMITS.MAX_NUMBER_OF_REGEX_RULES) throw new ExtensionError('Session rule count for regex rules exceeded.')
        entry.sessionRules = rules
        entry.session = ruleset
        rebuild(entry)
      })
    },

    async getSessionRules(call, filter: unknown) {
      const entry = await entryFor(call)
      return filterRules(entry.sessionRules, filter)
    },

    async getAvailableStaticRuleCount(call) {
      const entry = await entryFor(call)
      return Math.max(0, staticRuleAllowance(entry) - staticRuleCount(entry))
    },

    async getEnabledRulesets(call) {
      const entry = await entryFor(call)
      return [...entry.enabledIds]
    },

    async updateEnabledRulesets(call, options: unknown) {
      if (!isObject(options)) throw paramError('options', 'Invalid type: expected declarativeNetRequest.UpdateRulesetOptions.')
      const disable = stringList(options.disableRulesetIds, 'options', 'disableRulesetIds')
      const enable = stringList(options.enableRulesetIds, 'options', 'enableRulesetIds')
      const entry = await entryFor(call)
      for (const id of [...disable, ...enable]) checkRulesetId(entry, id)
      return mutate(entry, async () => {
        const wanted = new Set(entry.enabledIds)
        for (const id of disable) wanted.delete(id)
        for (const id of enable) wanted.add(id)
        const ordered = entry.manifestRulesets.map((r) => r.id).filter((id) => wanted.has(id))
        if (ordered.length > LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
          throw new ExtensionError('The number of enabled static rulesets exceeds the enabled ruleset count limit.')
        }
        const fresh = new Map<string, Ruleset>()
        for (const id of ordered) {
          if (entry.statics.has(id)) continue
          const rs = await loadStatic(entry, id)
          if (!rs) throw new ExtensionError('Internal error while updating enabled rulesets.')
          fresh.set(id, rs)
        }
        const total = ordered.reduce((n, id) => n + (entry.statics.get(id) ?? fresh.get(id))!.count, 0)
        if (total > staticRuleAllowance(entry)) throw new ExtensionError('The set of enabled rulesets exceeds the rule count limit.')
        for (const id of [...entry.statics.keys()]) if (!wanted.has(id)) entry.statics.delete(id)
        for (const [id, rs] of fresh) entry.statics.set(id, rs)
        entry.enabledIds = ordered
        setState(entry.id, STATE_ENABLED, ordered)
        rebuild(entry)
      })
    },

    async updateStaticRules(call, options: unknown) {
      if (!isObject(options)) throw paramError('options', 'Invalid type: expected declarativeNetRequest.UpdateStaticRulesOptions.')
      const disable = numberList(options.disableRuleIds, 'options', 'disableRuleIds')
      const enable = numberList(options.enableRuleIds, 'options', 'enableRuleIds')
      const entry = await entryFor(call)
      const rulesetId = checkRulesetId(entry, options.rulesetId)
      return mutate(entry, () => {
        const all = { ...getState<Record<string, number[]>>(entry.id, STATE_DISABLED, {}) }
        const set = new Set(all[rulesetId] ?? [])
        for (const id of disable) set.add(id)
        for (const id of enable) set.delete(id)
        let total = set.size
        for (const [id, list] of Object.entries(all)) if (id !== rulesetId) total += list.length
        if (total > LIMITS.MAX_NUMBER_OF_DISABLED_STATIC_RULES) throw new ExtensionError('The number of disabled static rules exceeds the disabled rule count limit.')
        if (set.size) {
          all[rulesetId] = [...set].sort((a, b) => a - b)
          entry.rules.disabled.set(rulesetId, set)
        } else {
          delete all[rulesetId]
          entry.rules.disabled.delete(rulesetId)
        }
        setState(entry.id, STATE_DISABLED, Object.keys(all).length ? all : undefined)
      })
    },

    async getDisabledRuleIds(call, options: unknown) {
      if (!isObject(options)) throw paramError('options', 'Invalid type: expected declarativeNetRequest.GetDisabledRuleIdsOptions.')
      const entry = await entryFor(call)
      const rulesetId = checkRulesetId(entry, options.rulesetId)
      return [...(entry.rules.disabled.get(rulesetId) ?? [])].sort((a, b) => a - b)
    },

    isRegexSupported(_call, options: unknown) {
      if (!isObject(options) || typeof options.regex !== 'string') throw paramError('regexOptions', "Missing required property 'regex'.")
      return isRegexSupported({
        regex: options.regex,
        isCaseSensitive: options.isCaseSensitive === undefined ? true : !!options.isCaseSensitive,
        requireCapturing: !!options.requireCapturing
      })
    },

    setExtensionActionOptions(call, options: unknown) {
      if (!isObject(options)) throw paramError('options', 'Invalid type: expected declarativeNetRequest.ExtensionActionOptions.')
      const id = call.extensionId
      if (options.displayActionCountAsBadgeText !== undefined) {
        const on = !!options.displayActionCountAsBadgeText
        const was = badgeEnabled(id)
        setState(id, STATE_BADGE, on || undefined)
        if (on !== was) {
          for (const [tabId, count] of actionCounts.get(id) ?? []) {
            if (on) scheduleBadge(id, tabId)
            else if (count > 0) setRuleCountBadge(id, tabId, null)
          }
        }
      }
      const update = options.tabUpdate
      if (update !== undefined) {
        if (!isObject(update) || typeof update.tabId !== 'number' || typeof update.increment !== 'number') {
          throw paramError('options', "Error at property 'tabUpdate': Invalid type: expected declarativeNetRequest.TabActionCountUpdate.")
        }
        if (!badgeEnabled(id)) throw new ExtensionError('Cannot modify the action count unless displayActionCountAsBadgeText is enabled.')
        const tabId = update.tabId
        if (!findTab(tabId) && !extraTabFor(tabId)) throw new ExtensionError(`No tab with id: ${tabId}.`)
        bump(actionCounts, id, tabId, Math.trunc(update.increment))
        scheduleBadge(id, tabId)
      }
    },

    getMatchedRules(call, filter: unknown) {
      if (filter !== undefined && filter !== null && !isObject(filter)) throw paramError('filter', 'Invalid type: expected declarativeNetRequest.MatchedRulesFilter.')
      const f = (filter ?? {}) as { tabId?: unknown; minTimeStamp?: unknown }
      const id = call.extensionId
      const p = perms(id)
      const tabId = typeof f.tabId === 'number' ? f.tabId : undefined
      if (!p.feedback && !(p.activeTab && tabId !== undefined && tabId >= 0 && hasActiveTabGrant(id, tabId))) {
        throw new ExtensionError(
          'The extension must have the declarativeNetRequestFeedback permission, or have activeTab granted for the specified tab ID in order to call this function.'
        )
      }
      const now = Date.now()
      const list = (matchRecords.get(id) ?? []).filter((r) => r.tabId >= 0 || now - r.timeStamp < UNTABBED_MATCH_TTL)
      matchRecords.set(id, list)
      const minTime = typeof f.minTimeStamp === 'number' ? f.minTimeStamp : undefined
      return {
        rulesMatchedInfo: list
          .filter((r) => (tabId === undefined || r.tabId === tabId) && (minTime === undefined || r.timeStamp >= minTime))
          .map((r) => ({ rule: { ruleId: r.ruleId, rulesetId: r.rulesetId }, tabId: r.tabId, timeStamp: r.timeStamp }))
      }
    },

    async testMatchOutcome(call, request: unknown) {
      if (!isObject(request)) throw paramError('request', 'Invalid type: expected declarativeNetRequest.TestMatchRequestDetails.')
      const url = typeof request.url === 'string' ? request.url : ''
      try {
        new URL(url)
      } catch {
        throw new ExtensionError('Invalid test request URL.')
      }
      if (typeof request.type !== 'string' || !(RESOURCE_TYPES as readonly string[]).includes(request.type)) {
        throw paramError('request', `Error at property 'type': Value must be one of ${RESOURCE_TYPES.join(', ')}.`)
      }
      if (request.method !== undefined && !(REQUEST_METHODS as readonly string[]).includes(String(request.method))) {
        throw paramError('request', `Error at property 'method': Value must be one of ${REQUEST_METHODS.join(', ')}.`)
      }
      const tabId = request.tabId === undefined ? -1 : request.tabId
      if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < -1) throw new ExtensionError('Invalid test request tab ID.')
      let initiator: string | undefined
      if (request.initiator !== undefined) {
        initiator = typeof request.initiator === 'string' ? originOf(request.initiator) : undefined
        if (!initiator) throw new ExtensionError('Invalid test request initiator.')
      }
      const responseHeaders = request.responseHeaders
      const validHeaders = (h: unknown): boolean => isObject(h) && Object.values(h).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
      if (responseHeaders !== undefined && !validHeaders(responseHeaders)) throw new ExtensionError('Invalid test request response headers.')
      const entry = await entryFor(call)
      const topUrl = typeof request.topUrl === 'string' ? request.topUrl : request.type === 'main_frame' ? url : undefined
      const req = { url: stripFragment(url), type: request.type, tabId, initiator }
      const method = (request.method as string | undefined) ?? 'get'
      const q = new Query({ url: req.url, type: request.type as chrome.declarativeNetRequest.ResourceType, method, tabId, initiator, topUrl })
      const hooks: Hooks = { hostAccess: () => hostAccessTo(entry.id, req) }
      const before = evaluateRequest(q, [entry.rules], hooks)
      const matched: CompiledRule[] = []
      const add = (rule: CompiledRule | InheritedAllow | null | undefined): void => {
        if (isCompiledRule(rule) && !matched.includes(rule)) matched.push(rule)
      }
      add(before.winner?.rule)
      if (before.kind !== KIND_BLOCK && before.kind !== KIND_REDIRECT) {
        for (const rule of before.results[0]?.modify ?? []) add(rule)
        if (responseHeaders !== undefined) {
          q.setResponseHeaders(responseHeaders as Record<string, string[]>)
          const after = evaluateResponse(q, [entry.rules], hooks, before)
          if (after.kind !== KIND_NONE) add(after.winner?.rule)
          for (const p of after.plan) for (const rule of p.rules) add(rule)
        }
      }
      return { matchedRules: matched.map((r) => ({ ruleId: r.id, rulesetId: r.rulesetId })) }
    }
  }
})

defineEvent('declarativeNetRequest.onRuleMatchedDebug', { permissions: ['declarativeNetRequestFeedback'] })

// ---- lifecycle ----

lifecycle.on('ready', (session) => {
  ses = session
  watchNavigations(session)
  onDocumentCommitted(onCommitted)
  onWebContentsGone(onGone)
  addBlockingHandler(session, 'onBeforeRequest', { id: 'declarativeNetRequest', order: 50, handle: onBeforeRequest })
  addBlockingHandler(session, 'onBeforeSendHeaders', { id: 'declarativeNetRequest', order: 50, handle: onBeforeSendHeaders })
  addBlockingHandler(session, 'onHeadersReceived', { id: 'declarativeNetRequest', order: 50, handle: onHeadersReceived })
})

lifecycle.on('loaded', (extension: Extension, reason: LoadReason) => {
  if (!ses || !declaresDnr(extension.id)) return
  // The enabled rulesets (and disabled static rules) go back to the manifest's on install and update.
  if (reason === 'install' || reason === 'update') {
    setState(extension.id, STATE_ENABLED, undefined)
    setState(extension.id, STATE_DISABLED, undefined)
  }
  const previous = entries.get(extension.id)
  if (previous) previous.alive = false
  const entry = createEntry(extension)
  entries.set(entry.id, entry)
  permsCache.delete(entry.id)
  startLoading(entry)
})

lifecycle.on('unloaded', (extensionId) => {
  const entry = entries.get(extensionId)
  if (entry) entry.alive = false
  entries.delete(extensionId)
  permsCache.delete(extensionId)
  activeCache = null
  matchRecords.delete(extensionId)
  actionCounts.delete(extensionId)
  pendingCounts.delete(extensionId)
  for (const map of frameAllows.values()) map.delete(extensionId)
})

lifecycle.on('uninstalled', (extensionId) => {
  void fs.rm(rulesDir(extensionId), { recursive: true, force: true }).catch(() => {})
})
