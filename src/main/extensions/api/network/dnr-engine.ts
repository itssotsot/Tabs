import { getDomain } from 'tldts'
import {
  A_ALLOW,
  A_ALLOW_ALL,
  A_BLOCK,
  A_MODIFY,
  A_REDIRECT,
  A_UPGRADE,
  anchoredHost,
  compileRule,
  compileUrlFilter,
  convertRegex,
  F_CASE_SENSITIVE,
  F_HEADER_STAGE,
  F_REGEX,
  F_URL_IMPLIED,
  headerConditionsMatch,
  impliedHost,
  isUnsafeAction,
  METHOD_BIT,
  redirectUrl,
  ruleRegex,
  RuleError,
  SchemaError,
  TYPE_BIT,
  upgradedUrl,
  urlFilterMatches,
  urlFilterTokens,
  urlTokens,
  type CompileOptions,
  type CompiledRule,
  type RequestMethod,
  type ResourceType,
  type UrlMatcher
} from './dnr-rules'

/**
 * The declarativeNetRequest matcher: indexes an extension's rulesets so a request only tests
 * the few rules that could match it, and decides what happens to a request the way Chrome does
 * (priorities, action precedence within and across extensions, allowAllRequests, header
 * modification conflicts).
 *
 * Pure: no Electron imports. The caller (declarative-net-request.ts) describes each request and
 * answers host permission questions through `Hooks`.
 */

// ---- requests ----

export interface RequestInput {
  /** Without the fragment. */
  url: string
  type: ResourceType
  method?: string
  tabId?: number
  /** The initiator's origin; 'null' for opaque origins, undefined when the browser started it. */
  initiator?: string
  /** URL of the top-level frame (the request's own URL for main-frame requests). */
  topUrl?: string
  responseHeaders?: Record<string, string[] | string> | null
}

const domainCache = new Map<string, string>()

/** eTLD+1 (private registries included, like Chrome's first/third-party check), or the host itself for IPs and such. */
export function registrableDomain(host: string): string {
  let d = domainCache.get(host)
  if (d === undefined) {
    d = getDomain(host, { allowPrivateDomains: true, extractHostname: false }) ?? host
    if (domainCache.size > 5000) domainCache.clear()
    domainCache.set(host, d)
  }
  return d
}

/** Host of a URL or origin, lowercase, without userinfo or port. */
export function hostOf(url: string | undefined): string {
  if (!url) return ''
  const s = url.indexOf('://')
  if (s < 0) return ''
  let end = s + 3
  while (end < url.length) {
    const c = url.charCodeAt(end)
    if (c === 47 || c === 63 || c === 35) break
    end++
  }
  let authority = url.slice(s + 3, end)
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
  const colon = authority.indexOf(':')
  return (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase()
}

/** The host and each parent domain: a.b.com, b.com, com. */
function suffixes(host: string): string[] {
  if (!host) return []
  const out = [host]
  if (host.startsWith('[')) return out
  let i = host.indexOf('.')
  while (i >= 0 && i < host.length - 1) {
    out.push(host.slice(i + 1))
    i = host.indexOf('.', i + 1)
  }
  return out
}

function anyIn(list: string[], set: Set<string>): boolean {
  for (let i = 0; i < list.length; i++) if (set.has(list[i])) return true
  return false
}

const HTTP_RE = /^https?:/

/** A request, prepared once for every ruleset and extension that looks at it. */
export class Query {
  readonly url: string
  readonly urlLower: string
  readonly host: string
  readonly hostSuffixes: string[]
  readonly type: ResourceType
  readonly typeBit: number
  /** 0 for requests that aren't HTTP(S): rules with requestMethods never match those. */
  readonly methodBit: number
  readonly tabId: number
  readonly initiator: string | undefined
  readonly initiatorHost: string
  readonly initiatorSuffixes: string[]
  readonly topSuffixes: string[]
  private tokenList: string[] | null = null
  private third: boolean | undefined
  private headerMap: Map<string, string[]> | null = null
  private rawHeaders: Record<string, string[] | string> | null

  constructor(input: RequestInput) {
    const hash = input.url.indexOf('#')
    this.url = hash >= 0 ? input.url.slice(0, hash) : input.url
    this.urlLower = this.url.toLowerCase()
    this.host = hostOf(this.url)
    this.hostSuffixes = suffixes(this.host)
    this.type = input.type
    this.typeBit = TYPE_BIT[input.type] ?? TYPE_BIT.other
    const method = (input.method ?? 'get').toLowerCase()
    this.methodBit = HTTP_RE.test(this.urlLower) ? (METHOD_BIT[method as RequestMethod] ?? METHOD_BIT.other) : 0
    this.tabId = input.tabId ?? -1
    this.initiator = input.initiator
    this.initiatorHost = input.initiator && input.initiator !== 'null' ? hostOf(input.initiator) : ''
    this.initiatorSuffixes = suffixes(this.initiatorHost)
    this.topSuffixes = input.topUrl ? suffixes(hostOf(input.topUrl)) : this.initiatorSuffixes
    this.rawHeaders = input.responseHeaders ?? null
  }

  get tokens(): string[] {
    return (this.tokenList ??= urlTokens(this.urlLower))
  }

  /** Third party: a different registrable domain than the initiator (or no initiator at all). */
  get thirdParty(): boolean {
    if (this.third === undefined) {
      this.third = !this.initiatorHost || registrableDomain(this.host) !== registrableDomain(this.initiatorHost)
    }
    return this.third
  }

  setResponseHeaders(headers: Record<string, string[] | string> | null | undefined): void {
    this.rawHeaders = headers ?? null
    this.headerMap = null
  }

  get hasResponseHeaders(): boolean {
    return this.rawHeaders !== null
  }

  /** Response headers by lowercase name. */
  headers(): Map<string, string[]> {
    if (!this.headerMap) {
      const map = new Map<string, string[]>()
      for (const [name, value] of Object.entries(this.rawHeaders ?? {})) {
        const key = name.toLowerCase()
        const list = map.get(key) ?? []
        if (Array.isArray(value)) list.push(...value)
        else list.push(value)
        map.set(key, list)
      }
      this.headerMap = map
    }
    return this.headerMap
  }
}

function ruleMatches(rule: CompiledRule, q: Query, headerStage: boolean): boolean {
  if (!(rule.types & q.typeBit)) return false
  const x = rule.extra
  if (x) {
    if (x.methodsIn && !(x.methodsIn & q.methodBit)) return false
    if (x.methodsOut & q.methodBit) return false
    if (x.domainType && (x.domainType === 2) !== q.thirdParty) return false
    if (x.tabIds && !x.tabIds.has(q.tabId)) return false
    if (x.excludedTabIds && x.excludedTabIds.has(q.tabId)) return false
    if (x.excludedRequestDomains && anyIn(q.hostSuffixes, x.excludedRequestDomains)) return false
    if (x.topDomains && !anyIn(q.topSuffixes, x.topDomains)) return false
    if (x.excludedTopDomains && anyIn(q.topSuffixes, x.excludedTopDomains)) return false
  }
  if (rule.initiatorDomains && !anyIn(q.initiatorSuffixes, rule.initiatorDomains)) return false
  if (rule.excludedInitiatorDomains && anyIn(q.initiatorSuffixes, rule.excludedInitiatorDomains)) return false
  if (rule.pattern !== null && !(rule.flags & F_URL_IMPLIED)) {
    if (rule.flags & F_REGEX) {
      if (!ruleRegex(rule).test(q.url)) return false
    } else {
      const cs = (rule.flags & F_CASE_SENSITIVE) !== 0
      let m = rule.matcher as UrlMatcher | null
      if (!m) rule.matcher = m = compileUrlFilter(rule.pattern, cs)
      if (!urlFilterMatches(m, cs ? q.url : q.urlLower, q.host)) return false
    }
  }
  if (headerStage && x && !headerConditionsMatch(x, q.headers())) return false
  return true
}

// ---- rulesets ----

type Bucket = CompiledRule | CompiledRule[]

/** Tokens too common to narrow anything down. */
const COMMON_TOKENS = new Set([
  'http',
  'https',
  'www',
  'com',
  'net',
  'org',
  'js',
  'css',
  'html',
  'htm',
  'php',
  'png',
  'jpg',
  'gif',
  'svg',
  'json',
  'api',
  'static',
  'cdn',
  'img',
  'images',
  'assets',
  'ws',
  'wss'
])

let stampCounter = 0

/** One ruleset (a static one from the manifest, or the dynamic or session rules), indexed. */
export class Ruleset {
  readonly id: string
  count = 0
  regexCount = 0
  unsafeCount = 0
  headerStageCount = 0
  private readonly hosts = new Map<string, Bucket>()
  private readonly tokens = new Map<string, Bucket>()
  private readonly unindexed: CompiledRule[] = []
  /** Literal text each unindexed rule's URL must contain ('' when there's none to check). */
  private readonly unindexedLiteral: string[] = []

  constructor(id: string) {
    this.id = id
  }

  add(rule: CompiledRule): void {
    this.count++
    if (rule.isRegex) this.regexCount++
    if (isUnsafeAction(rule.action)) this.unsafeCount++
    if (rule.flags & F_HEADER_STAGE) this.headerStageCount++
    if (rule.requestDomains) {
      for (const domain of new Set(rule.requestDomains)) this.put(this.hosts, domain, rule)
      rule.requestDomains = null
      return
    }
    if (rule.pattern === null) {
      this.addUnindexed(rule, '')
      return
    }
    if (rule.isRegex) {
      const check = convertRegex(rule.pattern, (rule.flags & F_CASE_SENSITIVE) !== 0)
      const token = this.bestToken(check.tokens ?? [])
      if (token) this.put(this.tokens, token, rule)
      else this.addUnindexed(rule, check.literal ?? '')
      return
    }
    const host = rule.flags & F_URL_IMPLIED ? impliedHost(rule.pattern) : anchoredHost(rule.pattern.toLowerCase())
    if (host) {
      this.put(this.hosts, host, rule)
      // The index key says it all; keep one string instead of two.
      if (rule.flags & F_URL_IMPLIED) rule.pattern = host
      return
    }
    const token = this.bestToken(urlFilterTokens(rule.pattern))
    if (token) this.put(this.tokens, token, rule)
    else this.addUnindexed(rule, longestLiteral(rule.pattern))
  }

  private addUnindexed(rule: CompiledRule, literal: string): void {
    this.unindexed.push(rule)
    this.unindexedLiteral.push(literal)
  }

  private put(map: Map<string, Bucket>, key: string, rule: CompiledRule): void {
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, rule)
    else if (Array.isArray(bucket)) bucket.push(rule)
    else map.set(key, [bucket, rule])
  }

  /** The candidate token with the fewest rules already behind it. */
  private bestToken(candidates: string[]): string | null {
    let best: string | null = null
    let bestScore = Infinity
    for (const token of candidates) {
      const bucket = this.tokens.get(token)
      let score = bucket === undefined ? 0 : Array.isArray(bucket) ? bucket.length : 1
      if (COMMON_TOKENS.has(token)) score += 100_000
      if (token.length < 3) score += 50
      score -= Math.min(token.length, 20) * 0.01
      if (score < bestScore) {
        bestScore = score
        best = token
      }
    }
    return best
  }

  /**
   * Adds the rules matching the request to `out`. `headerStage` picks the rules with response
   * header conditions (checked once headers arrive) instead of the others.
   */
  collect(q: Query, headerStage: boolean, out: CompiledRule[], disabled: Set<number> | null): void {
    if (!this.count || (headerStage && !this.headerStageCount) || (!headerStage && this.headerStageCount === this.count)) return
    const stamp = ++stampCounter
    const visit = (rule: CompiledRule): void => {
      if (rule.seen === stamp) return
      rule.seen = stamp
      if (((rule.flags & F_HEADER_STAGE) !== 0) !== headerStage) return
      if (disabled !== null && disabled.has(rule.id)) return
      if (ruleMatches(rule, q, headerStage)) out.push(rule)
    }
    const scan = (bucket: Bucket | undefined): void => {
      if (bucket === undefined) return
      if (Array.isArray(bucket)) for (let i = 0; i < bucket.length; i++) visit(bucket[i])
      else visit(bucket)
    }
    if (this.hosts.size) for (const s of q.hostSuffixes) scan(this.hosts.get(s))
    if (this.tokens.size) for (const t of q.tokens) scan(this.tokens.get(t))
    for (let i = 0; i < this.unindexed.length; i++) {
      const rule = this.unindexed[i]
      const literal = this.unindexedLiteral[i]
      if (literal && !(rule.flags & F_CASE_SENSITIVE ? q.url : q.urlLower).includes(literal)) continue
      visit(rule)
    }
  }
}

/** Longest stretch of a urlFilter without wildcards or anchors (lowercased unless case sensitive already). */
function longestLiteral(pattern: string): string {
  let best = ''
  for (const part of pattern.replace(/^\|\|?/, '').replace(/\|$/, '').split(/[*^]/)) if (part.length > best.length) best = part
  return best
}

// ---- extensions ----

/** Everything one extension has that can act on requests. */
export class ExtensionRules {
  readonly id: string
  /** Later installs win ties between extensions. */
  installTime = 0
  /** Enabled static rulesets in manifest order, then dynamic, then session. */
  rulesets: Ruleset[] = []
  /** Static rules turned off with updateStaticRules, per ruleset. */
  disabled = new Map<string, Set<number>>()
  /** Only declarativeNetRequestWithHostAccess: every action needs host access, not just redirects and header changes. */
  hostRequiredForAll = false

  constructor(id: string) {
    this.id = id
  }

  get hasHeaderStageRules(): boolean {
    return this.rulesets.some((r) => r.headerStageCount > 0)
  }
}

/** An allow that comes from elsewhere: an allowAllRequests rule on a parent frame, or an earlier stage. */
export interface InheritedAllow {
  rank: number
  ruleId: number
  rulesetId: string
}

export interface Hooks {
  /** Whether the extension has host access to this request (its URL and initiator). */
  hostAccess(ext: ExtensionRules): boolean
  /** allowAllRequests from the frames the request comes from. */
  inherited?(ext: ExtensionRules): InheritedAllow | undefined
}

export const KIND_NONE = 0
export const KIND_ALLOW = 1
export const KIND_REDIRECT = 2
export const KIND_BLOCK = 3

export interface ExtensionOutcome {
  ext: ExtensionRules
  kind: number
  /** The rule behind the action. */
  rule: CompiledRule | InheritedAllow | null
  redirectUrl: string | null
  /** Rank of the strongest allow or allowAllRequests that matched (-1 for none): modifyHeaders rules must beat it. */
  allowRank: number
  /** modifyHeaders rules that apply, strongest first. */
  modify: CompiledRule[]
  /** The strongest allowAllRequests rule this (frame) request matched. */
  allowAll: CompiledRule | null
}

/** A real rule, as opposed to an allow inherited from a parent frame or an earlier stage. */
export function isCompiledRule(rule: CompiledRule | InheritedAllow | null | undefined): rule is CompiledRule {
  return !!rule && 'action' in rule
}

/** What one extension's rules say about a request. */
export function evaluateExtension(ext: ExtensionRules, q: Query, headerStage: boolean, hooks: Hooks, base: InheritedAllow | null = null): ExtensionOutcome {
  const result: ExtensionOutcome = { ext, kind: KIND_NONE, rule: null, redirectUrl: null, allowRank: -1, modify: [], allowAll: null }
  if (!ext.rulesets.length) return result
  if (ext.hostRequiredForAll && !hooks.hostAccess(ext)) return result
  const matched: CompiledRule[] = []
  for (const rs of ext.rulesets) rs.collect(q, headerStage, matched, ext.disabled.get(rs.id) ?? null)
  const virtual = base ?? (headerStage ? null : (hooks.inherited?.(ext) ?? null))
  if (!matched.length && !virtual) return result
  if (matched.length > 1) matched.sort((a, b) => b.rank - a.rank)
  let access: boolean | undefined
  const canAccess = (): boolean => (access ??= hooks.hostAccess(ext))
  if (virtual) result.allowRank = virtual.rank
  for (const rule of matched) {
    if (rule.action === A_ALLOW || rule.action === A_ALLOW_ALL) {
      if (rule.rank > result.allowRank) result.allowRank = rule.rank
      if (rule.action === A_ALLOW_ALL && !result.allowAll) result.allowAll = rule
    }
  }
  let virtualPending = !!virtual
  for (const rule of matched) {
    if (rule.action === A_MODIFY) continue
    if (virtualPending && virtual!.rank >= rule.rank) break
    if (rule.action === A_ALLOW || rule.action === A_ALLOW_ALL) {
      result.kind = KIND_ALLOW
    } else if (rule.action === A_BLOCK) {
      result.kind = KIND_BLOCK
    } else if (rule.action === A_UPGRADE) {
      const target = upgradedUrl(q.url)
      if (!target) continue
      result.kind = KIND_REDIRECT
      result.redirectUrl = target
    } else if (rule.action === A_REDIRECT) {
      const target = canAccess() ? redirectUrl(rule, q.url, ext.id) : null
      if (!target) continue
      result.kind = KIND_REDIRECT
      result.redirectUrl = target
    }
    result.rule = rule
    virtualPending = false
    break
  }
  if (result.kind === KIND_NONE && virtualPending) {
    result.kind = KIND_ALLOW
    result.rule = virtual
  }
  if (result.kind === KIND_BLOCK || result.kind === KIND_REDIRECT) return result
  for (const rule of matched) if (rule.action === A_MODIFY && rule.rank > result.allowRank) result.modify.push(rule)
  if (result.modify.length && !canAccess()) result.modify = []
  return result
}

export interface Outcome {
  kind: number
  /** The extension whose action is taken. */
  winner: ExtensionOutcome | null
  redirectUrl: string | null
  /** Per extension, in the order given. */
  results: ExtensionOutcome[]
}

/** Across extensions: block beats redirect/upgrade beats allow; ties go to the first (most recently installed) extension. */
function decide(results: ExtensionOutcome[]): Outcome {
  let winner: ExtensionOutcome | null = null
  for (const r of results) if (r.kind > (winner?.kind ?? KIND_NONE)) winner = r
  return { kind: winner?.kind ?? KIND_NONE, winner, redirectUrl: winner?.redirectUrl ?? null, results }
}

/**
 * What happens to a request before it's sent. `extensions` must be ordered by precedence
 * (most recently installed first).
 */
export function evaluateRequest(q: Query, extensions: ExtensionRules[], hooks: Hooks): Outcome {
  return decide(extensions.map((ext) => evaluateExtension(ext, q, false, hooks)))
}

export interface HeaderPlan {
  ext: ExtensionRules
  rules: CompiledRule[]
}

/** Request header changes to make, by extension in precedence order. */
export function requestHeaderPlan(outcome: Outcome): HeaderPlan[] {
  if (outcome.kind === KIND_BLOCK || outcome.kind === KIND_REDIRECT) return []
  const plan: HeaderPlan[] = []
  for (const r of outcome.results) {
    const rules = r.modify.filter((rule) => rule.extra?.requestHeaderMods)
    if (rules.length) plan.push({ ext: r.ext, rules })
  }
  return plan
}

export interface ResponseOutcome extends Outcome {
  /** Response header changes to make (from both stages), by extension in precedence order. */
  plan: HeaderPlan[]
}

/**
 * Once response headers are in (set them on the query first): rules with response header
 * conditions, weighed against what the same extension allowed before the request was sent,
 * plus every response header change that applies.
 */
export function evaluateResponse(q: Query, extensions: ExtensionRules[], hooks: Hooks, before: Outcome | null): ResponseOutcome {
  const results = extensions.map((ext) => {
    const prev = before?.results.find((r) => r.ext === ext)
    const base: InheritedAllow | null = prev && prev.allowRank >= 0 ? { rank: prev.allowRank, ruleId: -1, rulesetId: '' } : null
    if (!ext.hasHeaderStageRules) {
      const r: ExtensionOutcome = { ext, kind: KIND_NONE, rule: null, redirectUrl: null, allowRank: base?.rank ?? -1, modify: [], allowAll: null }
      return r
    }
    const r = evaluateExtension(ext, q, true, hooks, base)
    // The earlier stage's allow wins again: nothing new to report.
    if (r.rule === base) {
      r.kind = KIND_NONE
      r.rule = null
    }
    return r
  })
  const outcome = decide(results)
  const plan: HeaderPlan[] = []
  if (outcome.kind !== KIND_BLOCK && outcome.kind !== KIND_REDIRECT) {
    results.forEach((r, i) => {
      const prev = before?.results[i]?.ext === r.ext ? before.results[i] : before?.results.find((p) => p.ext === r.ext)
      const floor = Math.max(r.allowRank, prev?.allowRank ?? -1)
      const rules = [...(prev?.modify ?? []), ...r.modify].filter((rule) => rule.extra?.responseHeaderMods && rule.rank > floor)
      if (rules.length) {
        rules.sort((a, b) => b.rank - a.rank)
        plan.push({ ext: r.ext, rules })
      }
    })
  }
  return { ...outcome, plan }
}

// ---- header changes ----

export interface AppliedRule {
  ext: ExtensionRules
  rule: CompiledRule
}

interface HeaderEntry {
  name: string
  values: string[]
}

/**
 * Applies header changes with Chrome's conflict rules: once a header is removed nothing else
 * touches it; once appended to, lower-priority rules may only append; once set, only
 * lower-priority rules of the same extension may append.
 */
function applyPlan(entries: Map<string, HeaderEntry>, plan: HeaderPlan[], request: boolean): AppliedRule[] {
  const done = new Map<string, { op: string; ext: ExtensionRules }>()
  const applied: AppliedRule[] = []
  for (const { ext, rules } of plan) {
    for (const rule of rules) {
      const mods = request ? rule.extra?.requestHeaderMods : rule.extra?.responseHeaderMods
      if (!mods) continue
      let changed = false
      for (const mod of mods) {
        const prev = done.get(mod.name)
        if (prev) {
          if (prev.op === 'remove' || mod.op !== 'append') continue
          if (prev.op === 'set' && prev.ext !== ext) continue
        }
        const existing = entries.get(mod.name)
        if (mod.op === 'remove') {
          entries.delete(mod.name)
        } else if (mod.op === 'set' || !existing) {
          entries.set(mod.name, { name: existing?.name ?? mod.display, values: [mod.value!] })
        } else if (request) {
          existing.values = [`${existing.values.join(', ')}${mod.name === 'cookie' ? '; ' : ', '}${mod.value}`]
        } else {
          existing.values.push(mod.value!)
        }
        if (!prev) done.set(mod.name, { op: mod.op, ext })
        changed = true
      }
      if (changed) applied.push({ ext, rule })
    }
  }
  return applied
}

/** Applies request header changes to Electron's header object. */
export function applyRequestHeaders(headers: Record<string, string>, plan: HeaderPlan[]): { headers: Record<string, string>; applied: AppliedRule[] } {
  const entries = new Map<string, HeaderEntry>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    const existing = entries.get(key)
    if (existing) existing.values.push(value)
    else entries.set(key, { name, values: [value] })
  }
  const applied = applyPlan(entries, plan, true)
  const out: Record<string, string> = {}
  for (const entry of entries.values()) out[entry.name] = entry.values.join(', ')
  return { headers: out, applied }
}

/** Applies response header changes to Electron's header object. */
export function applyResponseHeaders(headers: Record<string, string[]>, plan: HeaderPlan[]): { headers: Record<string, string[]>; applied: AppliedRule[] } {
  const entries = new Map<string, HeaderEntry>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    const values = Array.isArray(value) ? value : [String(value)]
    const existing = entries.get(key)
    if (existing) existing.values.push(...values)
    else entries.set(key, { name, values: [...values] })
  }
  const applied = applyPlan(entries, plan, false)
  const out: Record<string, string[]> = {}
  for (const entry of entries.values()) out[entry.name] = entry.values
  return { headers: out, applied }
}

// ---- loading rulesets ----

export interface BuildOptions extends Omit<CompileOptions, 'rulesetId'> {
  /** Called now and then so a big ruleset doesn't block the event loop. */
  pause?: () => Promise<void>
  /** Time slice between pauses, in milliseconds. */
  sliceMs?: number
  /** Regex rules beyond this are skipped (Chrome's per-ruleset limit). */
  maxRegexRules?: number
  onInvalid?: (message: string) => void
}

/**
 * Parses a ruleset file (a JSON array of rules) and indexes it a slice at a time. Invalid rules
 * are skipped and reported, like Chrome does for static rulesets.
 */
export async function buildRuleset(id: string, text: string, options: BuildOptions): Promise<Ruleset> {
  const ruleset = new Ruleset(id)
  const ids = new Set<number>()
  const maxRegex = options.maxRegexRules ?? Infinity
  const compileOptions: CompileOptions = { scope: options.scope, rulesetId: id, strict: false }
  await parseJsonArray(
    text,
    (items) => {
      for (const item of items) addRule(ruleset, item, compileOptions, ids, maxRegex, options.onInvalid)
    },
    options.pause,
    options.sliceMs
  )
  return ruleset
}

function addRule(ruleset: Ruleset, item: unknown, options: CompileOptions, ids: Set<number>, maxRegex: number, onInvalid?: (m: string) => void): void {
  try {
    const rule = compileRule(item, options)
    if (ids.has(rule.id)) throw new RuleError(`Rule with id ${rule.id} does not have a unique ID.`)
    if (rule.isRegex && ruleset.regexCount >= maxRegex) throw new RuleError(`Rule with id ${rule.id} exceeds the regular expression rule count limit.`)
    ids.add(rule.id)
    ruleset.add(rule)
  } catch (err) {
    if (err instanceof RuleError || err instanceof SchemaError) onInvalid?.(err.message)
    else throw err
  }
}

/** Indexes rules that are already validated objects (dynamic and session rules). */
export function rulesetFromRules(id: string, rules: unknown[], options: Omit<CompileOptions, 'rulesetId'>): Ruleset {
  const ruleset = new Ruleset(id)
  for (const raw of rules) ruleset.add(compileRule(raw, { ...options, rulesetId: id }))
  return ruleset
}

/**
 * Walks a JSON array without parsing it all at once: finds where the next few hundred elements
 * end, parses just that slice, hands it over, and pauses once a time slice is used up.
 */
export async function parseJsonArray(text: string, onBatch: (items: unknown[]) => void, pause?: () => Promise<void>, sliceMs = 8): Promise<void> {
  const BATCH = 256
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1
  while (i < n && /\s/.test(text[i])) i++
  if (text[i] !== '[') throw new SyntaxError('A ruleset must be a JSON array.')
  i++
  let sliceStart = performance.now()
  for (;;) {
    const start = i
    let depth = 0
    let count = 0
    let done = false
    for (; i < n; i++) {
      const c = text.charCodeAt(i)
      if (c === 34) {
        i = skipString(text, i)
      } else if (c === 123 || c === 91) {
        depth++
      } else if (c === 125 || c === 93) {
        if (depth === 0) {
          done = true
          break
        }
        depth--
        if (depth === 0 && ++count === BATCH) {
          i++
          break
        }
      }
    }
    if (i >= n && !done) {
      if (depth !== 0) throw new SyntaxError('Unexpected end of ruleset JSON.')
      done = true
    }
    const slice = text.slice(start, i).replace(/^[\s,]+/, '').replace(/[\s,]+$/, '')
    if (slice) onBatch(JSON.parse(`[${slice}]`) as unknown[])
    if (done) return
    if (pause && performance.now() - sliceStart >= sliceMs) {
      await pause()
      sliceStart = performance.now()
    }
  }
}

function skipString(text: string, start: number): number {
  let j = start + 1
  for (;;) {
    const k = text.indexOf('"', j)
    if (k < 0) throw new SyntaxError('Unterminated string in ruleset JSON.')
    let backslashes = 0
    for (let b = k - 1; b > start && text.charCodeAt(b) === 92; b--) backslashes++
    if (backslashes % 2 === 0) return k
    j = k + 1
  }
}

// ---- misc API helpers ----

/** chrome.declarativeNetRequest.isRegexSupported. */
export function isRegexSupported(options: { regex: string; isCaseSensitive?: boolean; requireCapturing?: boolean }): {
  isSupported: boolean
  reason?: 'syntaxError' | 'memoryLimitExceeded'
} {
  if (/[^\x00-\x7f]/.test(options.regex)) return { isSupported: false, reason: 'syntaxError' }
  const check = convertRegex(options.regex, options.isCaseSensitive ?? true)
  return check.ok ? { isSupported: true } : { isSupported: false, reason: check.reason ?? 'syntaxError' }
}

