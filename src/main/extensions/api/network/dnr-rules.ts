/**
 * declarativeNetRequest rules: validation (with Chrome's error messages), compilation into the
 * compact form the matcher (dnr-engine.ts) indexes, URL filters, regular expressions (Chrome
 * uses RE2; we translate to JavaScript), redirects and header patterns.
 *
 * Pure: no Electron imports, so it can be unit tested with plain Node.
 */

export const DYNAMIC_RULESET_ID = '_dynamic'
export const SESSION_RULESET_ID = '_session'

export const LIMITS = {
  GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
  /** Chrome's shared pool of static rules above each extension's guaranteed minimum. */
  GLOBAL_STATIC_RULE_LIMIT: 300_000,
  MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
  MAX_NUMBER_OF_SESSION_RULES: 5000,
  MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
  MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
  MAX_NUMBER_OF_STATIC_RULESETS: 100,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
  MAX_NUMBER_OF_DISABLED_STATIC_RULES: 5000,
  MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
  GETMATCHEDRULES_QUOTA_INTERVAL: 10
} as const

export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const TYPE_BIT = Object.fromEntries(RESOURCE_TYPES.map((t, i) => [t, 1 << i])) as Record<ResourceType, number>
const ALL_TYPES = (1 << RESOURCE_TYPES.length) - 1
const FRAME_TYPES = TYPE_BIT.main_frame | TYPE_BIT.sub_frame

export const REQUEST_METHODS = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'] as const
export type RequestMethod = (typeof REQUEST_METHODS)[number]
export const METHOD_BIT = Object.fromEntries(REQUEST_METHODS.map((m, i) => [m, 1 << i])) as Record<RequestMethod, number>

/** Action types, numbered by Chrome's tie-break order when priorities are equal (higher wins). */
export const A_MODIFY = 0
export const A_REDIRECT = 1
export const A_UPGRADE = 2
export const A_BLOCK = 3
export const A_ALLOW_ALL = 4
export const A_ALLOW = 5
export const ACTION_TYPES = ['modifyHeaders', 'redirect', 'upgradeScheme', 'block', 'allowAllRequests', 'allow'] as const

/** Rules counted against the "unsafe" limits: everything that changes a request rather than letting it through or stopping it. */
export const isUnsafeAction = (action: number): boolean => action === A_MODIFY || action === A_REDIRECT

/** Request headers Chrome lets rules append to (headers that take several comma-separated values). */
const APPENDABLE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for'
])

const TRANSFORM_SCHEMES = ['http', 'https', 'ftp', 'chrome-extension']

const RULE_KEYS = new Set(['id', 'priority', 'condition', 'action'])
const ACTION_KEYS = new Set(['type', 'redirect', 'requestHeaders', 'responseHeaders'])
const CONDITION_KEYS = new Set([
  'urlFilter',
  'regexFilter',
  'isUrlFilterCaseSensitive',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'requestDomains',
  'excludedRequestDomains',
  'topDomains',
  'excludedTopDomains',
  'domains',
  'excludedDomains',
  'resourceTypes',
  'excludedResourceTypes',
  'requestMethods',
  'excludedRequestMethods',
  'domainType',
  'tabIds',
  'excludedTabIds',
  'responseHeaders',
  'excludedResponseHeaders'
])

/** Malformed input: Chrome reports these from its schema check, before looking at what the rule means. */
export class SchemaError extends Error {}
/** A well-formed rule Chrome still refuses. */
export class RuleError extends Error {}

// ---- compiled form ----

export type HeaderOp = 'append' | 'set' | 'remove'

export interface HeaderMod {
  /** Lowercase. */
  name: string
  /** As the extension wrote it, for the header we add. */
  display: string
  op: HeaderOp
  value?: string
}

export interface HeaderCondition {
  name: string
  values: RegExp[] | null
  excluded: RegExp[] | null
}

export interface UrlTransform {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: { removeParams?: string[]; addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[] }
  fragment?: string
  username?: string
  password?: string
}

export type Redirect =
  | { kind: 'extensionPath'; value: string }
  | { kind: 'transform'; value: UrlTransform }
  | { kind: 'url'; value: string }
  | { kind: 'regexSubstitution'; value: string }

/** Conditions and action data most rules don't have, kept out of the main object to save memory. */
export interface RuleExtra {
  methodsIn: number
  methodsOut: number
  domainType: 0 | 1 | 2
  tabIds: Set<number> | null
  excludedTabIds: Set<number> | null
  excludedRequestDomains: Set<string> | null
  topDomains: Set<string> | null
  excludedTopDomains: Set<string> | null
  responseHeaders: HeaderCondition[] | null
  excludedResponseHeaders: HeaderCondition[] | null
  redirect: Redirect | null
  requestHeaderMods: HeaderMod[] | null
  responseHeaderMods: HeaderMod[] | null
}

export const F_CASE_SENSITIVE = 1
/** Matched only once response headers are known (it has response header conditions). */
export const F_HEADER_STAGE = 2
/** Its urlFilter is exactly `||host^`, so a hit in the host index already proves it matches. */
export const F_URL_IMPLIED = 4
export const F_REGEX = 8

export interface UrlMatcher {
  kind: number
  text: string
  re: RegExp | null
}

export class CompiledRule {
  id: number
  priority: number
  /** priority * 8 + action: one number that orders rules by priority, then action type. */
  rank: number
  action: number
  types: number
  flags: number
  /** The urlFilter (lowercased unless case sensitive) or regexFilter source. */
  pattern: string | null
  matcher: UrlMatcher | RegExp | null = null
  initiatorDomains: Set<string> | null
  excludedInitiatorDomains: Set<string> | null
  /** Only until the rule is indexed: the index covers requestDomains from then on. */
  requestDomains: string[] | null
  extra: RuleExtra | null
  rulesetId: string
  /** Dedupes a rule reached through several index keys during one lookup. */
  seen = 0

  constructor(fields: {
    id: number
    priority: number
    action: number
    types: number
    flags: number
    pattern: string | null
    initiatorDomains: Set<string> | null
    excludedInitiatorDomains: Set<string> | null
    requestDomains: string[] | null
    extra: RuleExtra | null
    rulesetId: string
  }) {
    this.id = fields.id
    this.priority = fields.priority
    this.rank = fields.priority * 8 + fields.action
    this.action = fields.action
    this.types = fields.types
    this.flags = fields.flags
    this.pattern = fields.pattern
    this.initiatorDomains = fields.initiatorDomains
    this.excludedInitiatorDomains = fields.excludedInitiatorDomains
    this.requestDomains = fields.requestDomains
    this.extra = fields.extra
    this.rulesetId = fields.rulesetId
  }

  get isRegex(): boolean {
    return (this.flags & F_REGEX) !== 0
  }
}

export interface CompileOptions {
  scope: 'static' | 'dynamic' | 'session'
  rulesetId: string
  /** Reject keys Chrome's schema doesn't know (API calls); static rulesets just ignore them. */
  strict?: boolean
}

// ---- helpers ----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const typeName = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v)
const NON_ASCII = /[^\x00-\x7f]/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_BAD = /[\0\r\n]/

export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

class Path {
  private readonly prefix: string

  constructor(prefix: string) {
    this.prefix = prefix
  }

  prop(name: string): Path {
    return new Path(`${this.prefix}Error at property '${name}': `)
  }
  index(i: number): Path {
    return new Path(`${this.prefix}Error at index ${i}: `)
  }
  error(message: string): SchemaError {
    return new SchemaError(this.prefix + message)
  }
}

function invalidType(path: Path, expected: string, value: unknown): SchemaError {
  return path.error(`Invalid type: expected ${expected}, found ${typeName(value)}.`)
}

function checkKeys(path: Path, obj: Record<string, unknown>, known: Set<string>, strict: boolean | undefined): void {
  if (!strict) return
  for (const key of Object.keys(obj)) if (!known.has(key)) throw path.error(`Unexpected property: '${key}'.`)
}

function optInteger(path: Path, obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) throw invalidType(path.prop(key), 'integer', v)
  return v
}

function optBoolean(path: Path, obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw invalidType(path.prop(key), 'boolean', v)
  return v
}

function optString(path: Path, obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw invalidType(path.prop(key), 'string', v)
  return v
}

function optArray<T>(path: Path, obj: Record<string, unknown>, key: string, item: (v: unknown, p: Path) => T): T[] | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw invalidType(path.prop(key), 'array', v)
  return v.map((x, i) => item(x, path.prop(key).index(i)))
}

function enumOf<T extends string>(values: readonly T[]): (v: unknown, p: Path) => T {
  return (v, p) => {
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      if (typeof v !== 'string') throw invalidType(p, 'string', v)
      throw p.error(`Value must be one of ${values.join(', ')}.`)
    }
    return v as T
  }
}

const stringItem = (v: unknown, p: Path): string => {
  if (typeof v !== 'string') throw invalidType(p, 'string', v)
  return v
}
const integerItem = (v: unknown, p: Path): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw invalidType(p, 'integer', v)
  return v
}

// ---- rule compilation ----

/**
 * Validates a rule and compiles it. Throws SchemaError for malformed input (Chrome's schema
 * messages, prefixed with `prefix`) and RuleError for rules Chrome refuses.
 */
export function compileRule(input: unknown, options: CompileOptions, prefix = ''): CompiledRule {
  const path = new Path(prefix)
  if (!isObject(input)) throw invalidType(path, 'declarativeNetRequest.Rule', input)
  checkKeys(path, input, RULE_KEYS, options.strict)
  if (input.id === undefined) throw path.error("Missing required property 'id'.")
  if (input.condition === undefined) throw path.error("Missing required property 'condition'.")
  if (input.action === undefined) throw path.error("Missing required property 'action'.")
  const id = optInteger(path, input, 'id')!
  const priorityIn = optInteger(path, input, 'priority')
  const condition = input.condition
  const action = input.action
  if (!isObject(condition)) throw invalidType(path.prop('condition'), 'declarativeNetRequest.RuleCondition', condition)
  if (!isObject(action)) throw invalidType(path.prop('action'), 'declarativeNetRequest.RuleAction', action)
  const cp = path.prop('condition')
  const ap = path.prop('action')
  checkKeys(cp, condition, CONDITION_KEYS, options.strict)
  checkKeys(ap, action, ACTION_KEYS, options.strict)
  if (action.type === undefined) throw ap.error("Missing required property 'type'.")
  const actionType = enumOf(ACTION_TYPES)(action.type, ap.prop('type'))

  // Schema-level shapes first, like Chrome.
  const urlFilter = optString(cp, condition, 'urlFilter')
  const regexFilter = optString(cp, condition, 'regexFilter')
  const caseSensitive = optBoolean(cp, condition, 'isUrlFilterCaseSensitive') ?? false
  const domains = optArray(cp, condition, 'domains', stringItem)
  const excludedDomains = optArray(cp, condition, 'excludedDomains', stringItem)
  let initiatorDomains = optArray(cp, condition, 'initiatorDomains', stringItem)
  let excludedInitiatorDomains = optArray(cp, condition, 'excludedInitiatorDomains', stringItem)
  const requestDomains = optArray(cp, condition, 'requestDomains', stringItem)
  const excludedRequestDomains = optArray(cp, condition, 'excludedRequestDomains', stringItem)
  const topDomains = optArray(cp, condition, 'topDomains', stringItem)
  const excludedTopDomains = optArray(cp, condition, 'excludedTopDomains', stringItem)
  const resourceTypes = optArray(cp, condition, 'resourceTypes', enumOf(RESOURCE_TYPES))
  const excludedResourceTypes = optArray(cp, condition, 'excludedResourceTypes', enumOf(RESOURCE_TYPES))
  const requestMethods = optArray(cp, condition, 'requestMethods', enumOf(REQUEST_METHODS))
  const excludedRequestMethods = optArray(cp, condition, 'excludedRequestMethods', enumOf(REQUEST_METHODS))
  const domainType = condition.domainType === undefined ? undefined : enumOf(['firstParty', 'thirdParty'] as const)(condition.domainType, cp.prop('domainType'))
  const tabIds = optArray(cp, condition, 'tabIds', integerItem)
  const excludedTabIds = optArray(cp, condition, 'excludedTabIds', integerItem)
  const responseHeaders = optArray(cp, condition, 'responseHeaders', (v, p) => headerInfoShape(v, p))
  const excludedResponseHeaders = optArray(cp, condition, 'excludedResponseHeaders', (v, p) => headerInfoShape(v, p))
  const redirect = action.redirect === undefined ? undefined : redirectShape(action.redirect, ap.prop('redirect'))
  const requestHeaders = optArray(ap, action, 'requestHeaders', (v, p) => modifyHeaderShape(v, p))
  const responseHeaderMods = optArray(ap, action, 'responseHeaders', (v, p) => modifyHeaderShape(v, p))

  // Then what the rule means.
  const fail = (message: string): RuleError => new RuleError(`Rule with id ${id} ${message}`)
  const emptyList = (key: string): RuleError => fail(`cannot have an empty list as the value for "${key}" key.`)
  if (id < 1) throw fail('must have a positive id.')
  if (priorityIn !== undefined && priorityIn < 1) throw fail('must have a priority >= 1.')
  const priority = priorityIn ?? 1

  if (domains && initiatorDomains) throw fail('cannot specify both "domains" and "initiatorDomains" keys.')
  if (excludedDomains && excludedInitiatorDomains) throw fail('cannot specify both "excludedDomains" and "excludedInitiatorDomains" keys.')
  initiatorDomains ??= domains
  excludedInitiatorDomains ??= excludedDomains
  const domainKey = (key: string, list: string[] | undefined, allowEmpty: boolean): string[] | undefined => {
    if (!list) return undefined
    if (!list.length && !allowEmpty) throw emptyList(key)
    for (const d of list) {
      if (NON_ASCII.test(d)) throw fail(`cannot have non-ascii characters as part of "${key}" key.`)
      if (!d) throw fail(`cannot have an empty value for "${key}" key.`)
    }
    return list.map((d) => d.toLowerCase())
  }
  const initiators = domainKey(domains ? 'domains' : 'initiatorDomains', initiatorDomains, false)
  const excludedInitiators = domainKey(excludedDomains ? 'excludedDomains' : 'excludedInitiatorDomains', excludedInitiatorDomains, true)
  const requests = domainKey('requestDomains', requestDomains, false)
  const excludedRequests = domainKey('excludedRequestDomains', excludedRequestDomains, true)
  const tops = domainKey('topDomains', topDomains, false)
  const excludedTops = domainKey('excludedTopDomains', excludedTopDomains, true)

  if (resourceTypes && !resourceTypes.length) throw emptyList('resourceTypes')
  if (resourceTypes && excludedResourceTypes?.some((t) => resourceTypes.includes(t))) throw fail('includes and excludes the same resource.')
  let types = resourceTypes
    ? resourceTypes.reduce((m, t) => m | TYPE_BIT[t], 0)
    : excludedResourceTypes
      ? excludedResourceTypes.reduce((m, t) => m & ~TYPE_BIT[t], ALL_TYPES)
      : ALL_TYPES & ~TYPE_BIT.main_frame
  if (resourceTypes && excludedResourceTypes) types &= ~excludedResourceTypes.reduce((m, t) => m | TYPE_BIT[t], 0)
  if (!types) throw fail('is not applicable to any resource type.')

  if (requestMethods && !requestMethods.length) throw emptyList('requestMethods')
  if (requestMethods && excludedRequestMethods?.some((m) => requestMethods.includes(m))) throw fail('includes and excludes the same request method.')

  if ((tabIds || excludedTabIds) && options.scope !== 'session') {
    throw fail('specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.')
  }
  if (tabIds && !tabIds.length) throw emptyList('tabIds')
  if (tabIds && excludedTabIds?.some((t) => tabIds.includes(t))) throw fail('includes and excludes the same tab ID.')

  if (urlFilter !== undefined && regexFilter !== undefined) throw fail('can only specify one of "urlFilter" or "regexFilter" keys.')
  let flags = caseSensitive ? F_CASE_SENSITIVE : 0
  let pattern: string | null = null
  if (urlFilter !== undefined) {
    if (!urlFilter) throw fail('cannot have an empty value for "urlFilter" key.')
    if (NON_ASCII.test(urlFilter)) throw fail('cannot have non-ascii characters as part of "urlFilter" key.')
    if (urlFilter.startsWith('||*')) {
      throw fail('specifies an incorrect value for the "urlFilter" key. A pattern beginning with "||*" is not allowed. Use "*" instead.')
    }
    pattern = caseSensitive ? urlFilter : urlFilter.toLowerCase()
  } else if (regexFilter !== undefined) {
    if (!regexFilter) throw fail('cannot have an empty value for "regexFilter" key.')
    if (NON_ASCII.test(regexFilter)) throw fail('cannot have non-ascii characters as part of "regexFilter" key.')
    const check = convertRegex(regexFilter, caseSensitive)
    if (check.reason === 'memoryLimitExceeded') throw fail('specified a more complex regex than allowed as part of the "regexFilter" key.')
    if (!check.ok) throw fail('specified an invalid regular expression as the "regexFilter" key.')
    pattern = regexFilter
    flags |= F_REGEX
  }

  const act = ACTION_TYPES.indexOf(actionType)
  if (act === A_ALLOW_ALL && (!resourceTypes || types & ~FRAME_TYPES)) {
    throw fail('is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.')
  }

  let redirectSpec: Redirect | null = null
  if (act === A_REDIRECT) {
    if (!redirect) throw fail('does not specify the value for "action.redirect" key. This is required for "redirect" rules.')
    redirectSpec = validateRedirect(redirect, fail, regexFilter)
  }

  let requestMods: HeaderMod[] | null = null
  let responseMods: HeaderMod[] | null = null
  if (act === A_MODIFY) {
    if (!requestHeaders && !responseHeaderMods) {
      throw fail('does not specify the value for "action.requestHeaders" or "action.responseHeaders" key. This is required for "modifyHeaders" rules.')
    }
    if (requestHeaders && !requestHeaders.length) throw emptyList('action.requestHeaders')
    if (responseHeaderMods && !responseHeaderMods.length) throw emptyList('action.responseHeaders')
    requestMods = requestHeaders ? requestHeaders.map((h) => validateHeaderMod(h, fail, true)) : null
    responseMods = responseHeaderMods ? responseHeaderMods.map((h) => validateHeaderMod(h, fail, false)) : null
  }

  const headerConditions = (key: string, list: HeaderInfoShape[] | undefined): HeaderCondition[] | null => {
    if (!list) return null
    if (!list.length) throw emptyList(key)
    return list.map((h) => {
      if (!HEADER_NAME.test(h.header)) throw fail(`must specify a valid header name as part of "${key}" key.`)
      if (h.values && !h.values.length) throw emptyList(`${key}.values`)
      if (h.excludedValues && !h.excludedValues.length) throw emptyList(`${key}.excludedValues`)
      return {
        name: h.header.toLowerCase(),
        values: h.values ? h.values.map(headerValuePattern) : null,
        excluded: h.excludedValues ? h.excludedValues.map(headerValuePattern) : null
      }
    })
  }
  const headerConds = headerConditions('responseHeaders', responseHeaders)
  const excludedHeaderConds = headerConditions('excludedResponseHeaders', excludedResponseHeaders)
  if (headerConds || excludedHeaderConds) flags |= F_HEADER_STAGE

  const methodsIn = requestMethods ? requestMethods.reduce((m, x) => m | METHOD_BIT[x], 0) : 0
  const methodsOut = excludedRequestMethods ? excludedRequestMethods.reduce((m, x) => m | METHOD_BIT[x], 0) : 0
  const needsExtra =
    methodsIn ||
    methodsOut ||
    domainType ||
    tabIds ||
    excludedTabIds?.length ||
    excludedRequests?.length ||
    tops ||
    excludedTops?.length ||
    headerConds ||
    excludedHeaderConds ||
    redirectSpec ||
    requestMods ||
    responseMods
  const extra: RuleExtra | null = needsExtra
    ? {
        methodsIn,
        methodsOut,
        domainType: domainType === 'firstParty' ? 1 : domainType === 'thirdParty' ? 2 : 0,
        tabIds: tabIds ? new Set(tabIds) : null,
        excludedTabIds: excludedTabIds?.length ? new Set(excludedTabIds) : null,
        excludedRequestDomains: excludedRequests?.length ? new Set(excludedRequests) : null,
        topDomains: tops ? new Set(tops) : null,
        excludedTopDomains: excludedTops?.length ? new Set(excludedTops) : null,
        responseHeaders: headerConds,
        excludedResponseHeaders: excludedHeaderConds,
        redirect: redirectSpec,
        requestHeaderMods: requestMods,
        responseHeaderMods: responseMods
      }
    : null

  if (pattern !== null && !(flags & F_REGEX)) {
    const host = impliedHost(pattern)
    if (host !== null && !requests) flags |= F_URL_IMPLIED
  }

  return new CompiledRule({
    id,
    priority,
    action: act,
    types,
    flags,
    pattern,
    initiatorDomains: initiators ? new Set(initiators) : null,
    excludedInitiatorDomains: excludedInitiators?.length ? new Set(excludedInitiators) : null,
    requestDomains: requests ?? null,
    extra,
    rulesetId: options.rulesetId
  })
}

interface HeaderInfoShape {
  header: string
  values?: string[]
  excludedValues?: string[]
}

function headerInfoShape(v: unknown, p: Path): HeaderInfoShape {
  if (!isObject(v)) throw invalidType(p, 'declarativeNetRequest.HeaderInfo', v)
  if (v.header === undefined) throw p.error("Missing required property 'header'.")
  return {
    header: optString(p, v, 'header')!,
    values: optArray(p, v, 'values', stringItem),
    excludedValues: optArray(p, v, 'excludedValues', stringItem)
  }
}

interface ModifyHeaderShape {
  header: string
  operation: HeaderOp
  value?: string
}

function modifyHeaderShape(v: unknown, p: Path): ModifyHeaderShape {
  if (!isObject(v)) throw invalidType(p, 'declarativeNetRequest.ModifyHeaderInfo', v)
  if (v.header === undefined) throw p.error("Missing required property 'header'.")
  if (v.operation === undefined) throw p.error("Missing required property 'operation'.")
  return {
    header: optString(p, v, 'header')!,
    operation: enumOf(['append', 'set', 'remove'] as const)(v.operation, p.prop('operation')),
    value: optString(p, v, 'value')
  }
}

function validateHeaderMod(h: ModifyHeaderShape, fail: (m: string) => RuleError, isRequest: boolean): HeaderMod {
  if (!h.header || !HEADER_NAME.test(h.header)) throw fail('must specify a valid header name to be modified.')
  const name = h.header.toLowerCase()
  if (h.operation === 'remove') {
    if (h.value !== undefined) throw fail('must not provide a header value for a header to be removed.')
  } else {
    if (h.value === undefined) throw fail('must provide a value for a header to be appended/set.')
    if (HEADER_VALUE_BAD.test(h.value)) throw fail('must provide a valid header value to be appended/set.')
  }
  if (isRequest && h.operation === 'append' && !APPENDABLE_REQUEST_HEADERS.has(name)) {
    throw fail(
      'specifies an invalid request header to be appended. Only standard HTTP request headers that can specify multiple values for a single entry are supported.'
    )
  }
  return { name, display: h.header, op: h.operation, value: h.value }
}

interface RedirectShape {
  extensionPath?: string
  transform?: UrlTransform
  url?: string
  regexSubstitution?: string
}

function redirectShape(v: unknown, p: Path): RedirectShape {
  if (!isObject(v)) throw invalidType(p, 'declarativeNetRequest.Redirect', v)
  let transform: UrlTransform | undefined
  if (v.transform !== undefined) {
    const t = v.transform
    const tp = p.prop('transform')
    if (!isObject(t)) throw invalidType(tp, 'declarativeNetRequest.URLTransform', t)
    transform = {}
    for (const key of ['scheme', 'host', 'port', 'path', 'query', 'fragment', 'username', 'password'] as const) {
      const s = optString(tp, t, key)
      if (s !== undefined) transform[key] = s
    }
    if (t.queryTransform !== undefined) {
      const q = t.queryTransform
      const qp = tp.prop('queryTransform')
      if (!isObject(q)) throw invalidType(qp, 'declarativeNetRequest.QueryTransform', q)
      transform.queryTransform = {
        removeParams: optArray(qp, q, 'removeParams', stringItem),
        addOrReplaceParams: optArray(qp, q, 'addOrReplaceParams', (x, xp) => {
          if (!isObject(x)) throw invalidType(xp, 'declarativeNetRequest.QueryKeyValue', x)
          if (x.key === undefined) throw xp.error("Missing required property 'key'.")
          if (x.value === undefined) throw xp.error("Missing required property 'value'.")
          return { key: optString(xp, x, 'key')!, value: optString(xp, x, 'value')!, replaceOnly: optBoolean(xp, x, 'replaceOnly') }
        })
      }
    }
  }
  return {
    extensionPath: optString(p, v, 'extensionPath'),
    transform,
    url: optString(p, v, 'url'),
    regexSubstitution: optString(p, v, 'regexSubstitution')
  }
}

function validateRedirect(r: RedirectShape, fail: (m: string) => RuleError, regexFilter: string | undefined): Redirect {
  // Chrome takes the first of these that's set.
  if (r.extensionPath !== undefined) {
    if (!r.extensionPath.startsWith('/')) throw fail('does not specify a valid extension path for "action.redirect.extensionPath" key.')
    return { kind: 'extensionPath', value: r.extensionPath }
  }
  if (r.transform) {
    const t = r.transform
    const key = (k: string): string => `"action.redirect.transform.${k}"`
    if (t.scheme !== undefined && !TRANSFORM_SCHEMES.includes(t.scheme)) {
      throw fail(`specifies an invalid value for ${key('scheme')} key. Allowed schemes are: ${TRANSFORM_SCHEMES.join(', ')}.`)
    }
    if (t.port !== undefined && t.port !== '' && !(/^\d+$/.test(t.port) && Number(t.port) <= 65535)) throw fail(`specifies an invalid value for ${key('port')} key.`)
    if (t.query !== undefined && t.query !== '' && !t.query.startsWith('?')) throw fail(`specifies an invalid value for ${key('query')} key.`)
    if (t.fragment !== undefined && t.fragment !== '' && !t.fragment.startsWith('#')) throw fail(`specifies an invalid value for ${key('fragment')} key.`)
    if (t.host !== undefined && (!t.host || /[\s/?#@\\]/.test(t.host))) throw fail(`specifies an invalid value for ${key('host')} key.`)
    if (t.query !== undefined && t.queryTransform) throw fail('cannot specify both "query" and "queryTransform" keys.')
    return { kind: 'transform', value: t }
  }
  if (r.url !== undefined) {
    if (/^\s*javascript:/i.test(r.url)) throw fail('specifies a JavaScript URL for "action.redirect.url" key. JavaScript URLs are not allowed.')
    let ok = false
    try {
      ok = !!new URL(r.url).protocol
    } catch {
      ok = false
    }
    if (!ok) throw fail('does not provide a valid URL for "action.redirect.url" key.')
    return { kind: 'url', value: r.url }
  }
  if (r.regexSubstitution !== undefined) {
    if (regexFilter === undefined) throw fail('can\'t specify the "action.redirect.regexSubstitution" key without specifying the "condition.regexFilter" key.')
    if (!validSubstitution(r.regexSubstitution, regexFilter)) throw fail('specifies an invalid value for the "action.redirect.regexSubstitution" key.')
    return { kind: 'regexSubstitution', value: r.regexSubstitution }
  }
  throw fail('does not specify the value for "action.redirect" key. This is required for "redirect" rules.')
}

/** RE2's rewrite rules: `\\` and `\0`–`\9` (up to the number of groups) are the only escapes. */
function validSubstitution(sub: string, regex: string): boolean {
  const groups = captureGroupCount(regex)
  for (let i = 0; i < sub.length; i++) {
    if (sub[i] !== '\\') continue
    const next = sub[++i]
    if (next === '\\') continue
    if (next === undefined || !/\d/.test(next) || Number(next) > groups) return false
  }
  return true
}

function captureGroupCount(regex: string): number {
  const check = convertRegex(regex, true)
  if (!check.ok) return 0
  try {
    return new RegExp(`${check.source}|`).exec('')!.length - 1
  } catch {
    return 0
  }
}

// ---- URL filters ----

const K_SUBSTRING = 0
const K_PREFIX = 1
const K_SUFFIX = 2
const K_EXACT = 3
const K_HOST = 4
const K_REGEX = 5

/** Characters `^` doesn't match (besides the end of the URL). */
const SEPARATOR = '(?:[^a-z0-9_.%\\-]|$)'
const SEPARATOR_CS = '(?:[^A-Za-z0-9_.%\\-]|$)'
/** `||`: the pattern starts at the beginning of the host or of one of its labels. */
const DOMAIN_ANCHOR = '^[a-z][a-z0-9+.\\-]*:\\/\\/(?:[^\\/?#@]*@)?(?:[^\\/?#@:.]+\\.)*'

interface ParsedFilter {
  anchor: 0 | 1 | 2
  body: string
  end: boolean
}

function parseFilter(pattern: string): ParsedFilter {
  let body = pattern
  let anchor: 0 | 1 | 2 = 0
  if (body.startsWith('||')) {
    anchor = 2
    body = body.slice(2)
  } else if (body.startsWith('|')) {
    anchor = 1
    body = body.slice(1)
  }
  let end = false
  if (body.endsWith('|')) {
    end = true
    body = body.slice(0, -1)
  }
  return { anchor, body, end }
}

/** The host of a `||host^` filter, or null for anything more elaborate. */
export function impliedHost(pattern: string): string | null {
  const m = /^\|\|([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\^$/.exec(pattern)
  return m ? m[1] : null
}

/** For `||host^…`, `||host/…` and `||host:…` filters, the host whose subdomains they can match. */
export function anchoredHost(pattern: string): string | null {
  const m = /^\|\|([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?=[\^/:]|\|$)/.exec(pattern)
  return m ? m[1] : null
}

export function compileUrlFilter(pattern: string, caseSensitive: boolean): UrlMatcher {
  const { anchor, body, end } = parseFilter(pattern)
  const plain = !/[*^]/.test(body)
  if (plain && anchor === 0 && !end) return { kind: K_SUBSTRING, text: body, re: null }
  if (plain && anchor === 1) return { kind: end ? K_EXACT : K_PREFIX, text: body, re: null }
  if (plain && anchor === 0 && end) return { kind: K_SUFFIX, text: body, re: null }
  const host = impliedHost(pattern)
  if (host !== null) return { kind: K_HOST, text: host, re: null }
  let source = anchor === 1 ? '^' : anchor === 2 ? DOMAIN_ANCHOR : ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '*') {
      if (body[i - 1] !== '*') source += '[^]*'
    } else if (ch === '^') source += caseSensitive ? SEPARATOR_CS : SEPARATOR
    else source += escapeRegExp(ch)
  }
  if (end) source += '$'
  return { kind: K_REGEX, text: body, re: new RegExp(source) }
}

/** Whether a URL (already lowercased for case-insensitive filters) matches a compiled filter. */
export function urlFilterMatches(m: UrlMatcher, url: string, host: string): boolean {
  switch (m.kind) {
    case K_SUBSTRING:
      return url.includes(m.text)
    case K_PREFIX:
      return url.startsWith(m.text)
    case K_SUFFIX:
      return url.endsWith(m.text)
    case K_EXACT:
      return url === m.text
    case K_HOST:
      return host === m.text || (host.length > m.text.length && host.endsWith(m.text) && host.charCodeAt(host.length - m.text.length - 1) === 46)
    default:
      return m.re!.test(url)
  }
}

const isTokenChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 37 || (c >= 65 && c <= 90)

/**
 * Tokens a matching URL is sure to contain as whole tokens (runs of letters, digits and `%`):
 * those bounded on both sides by literal separators or anchors in the filter.
 */
export function urlFilterTokens(pattern: string): string[] {
  const { anchor, body, end } = parseFilter(pattern.toLowerCase())
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    if (!isTokenChar(body.charCodeAt(i))) {
      i++
      continue
    }
    let j = i
    while (j < body.length && isTokenChar(body.charCodeAt(j))) j++
    const leftOk = i > 0 ? body[i - 1] !== '*' : anchor !== 0
    const rightOk = j < body.length ? body[j] !== '*' : end
    if (leftOk && rightOk) out.push(body.slice(i, j))
    i = j
  }
  return out
}

/** Splits a URL (lowercased) into its tokens, without duplicates. */
export function urlTokens(url: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let i = 0
  const n = url.length
  while (i < n) {
    if (!isTokenChar(url.charCodeAt(i))) {
      i++
      continue
    }
    let j = i + 1
    while (j < n && isTokenChar(url.charCodeAt(j))) j++
    const token = url.slice(i, j)
    if (!seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
    i = j
  }
  return out
}

// ---- regular expressions ----

export interface RegexCheck {
  ok: boolean
  source?: string
  flags?: string
  reason?: 'syntaxError' | 'memoryLimitExceeded'
  /** Literal text any match must contain (for cheap rejection), and whole tokens in it. */
  literal?: string
  tokens?: string[]
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\t\\n\\v\\f\\r ',
  blank: '\\t ',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  word: '0-9A-Za-z_',
  cntrl: '\\x00-\\x1f\\x7f',
  print: ' -~',
  graph: '!-~',
  ascii: '\\x00-\\x7f'
}

/** RE2 limits a counted repetition to 1000; Chrome also caps each rule's compiled program size. */
const MAX_REPEAT = 1000
const MAX_PROGRAM = 1500

/**
 * Translates an RE2 regular expression (what Chrome's regexFilter uses) to JavaScript, or says
 * why Chrome wouldn't accept it. Lookarounds and backreferences aren't RE2 and are rejected.
 */
export function convertRegex(regex: string, caseSensitive: boolean): RegexCheck {
  let flags = caseSensitive ? '' : 'i'
  let src = regex
  const lead = /^\(\?([imsU]+)\)/.exec(src)
  if (lead) {
    if (lead[1].includes('U')) return { ok: false, reason: 'syntaxError' }
    for (const f of lead[1]) if (!flags.includes(f)) flags += f
    src = src.slice(lead[0].length)
  }
  let out = ''
  // Rough RE2 program size: one instruction per atom, repetitions multiply their operand.
  const sizes: number[] = [0]
  let lastAtom = 0
  let literal = ''
  let bestLiteral = ''
  const literals: string[] = []
  let depth = 0
  let topAlternation = false
  const endLiteral = (): void => {
    if (depth === 0 && literal) literals.push(literal)
    if (depth === 0 && literal.length > bestLiteral.length) bestLiteral = literal
    literal = ''
  }
  const atom = (text: string, size: number, lit: string | null): void => {
    out += text
    sizes[sizes.length - 1] += size
    lastAtom = size
    if (lit !== null && depth === 0) literal += lit
    else endLiteral()
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[i + 1]
      if (next === undefined) return { ok: false, reason: 'syntaxError' }
      i++
      if (/[1-9]/.test(next) || next === 'k') return { ok: false, reason: 'syntaxError' }
      if (next === 'A') atom('^', 1, null)
      else if (next === 'z') atom('(?![^])', 1, null)
      else if (next === 'C') atom('[^]', 1, null)
      else if (next === 'Q') {
        const endQ = src.indexOf('\\E', i + 1)
        const text = endQ < 0 ? src.slice(i + 1) : src.slice(i + 1, endQ)
        for (const c of text) atom(escapeRegExp(c), 1, c)
        i = endQ < 0 ? src.length : endQ + 1
      } else if (next === 'p' || next === 'P') return { ok: false, reason: 'syntaxError' }
      else if (next === 'x' && src[i + 1] === '{') {
        const close = src.indexOf('}', i)
        const hex = src.slice(i + 2, close)
        if (close < 0 || !/^[0-9a-fA-F]{1,2}$/.test(hex)) return { ok: false, reason: 'syntaxError' }
        atom(`\\x${hex.padStart(2, '0')}`, 1, String.fromCharCode(parseInt(hex, 16)))
        i = close
      } else if (/[.*+?()[\]{}|^$\\/-]/.test(next)) atom(`\\${next}`, 1, next)
      else atom(`\\${next}`, 1, null)
      continue
    }
    if (ch === '[') {
      endLiteral()
      let j = i + 1
      let cls = '['
      if (src[j] === '^') {
        cls += '^'
        j++
      }
      if (src[j] === ']') {
        cls += '\\]'
        j++
      }
      let closed = false
      for (; j < src.length; j++) {
        const c = src[j]
        if (c === ']') {
          closed = true
          break
        }
        if (c === '\\') {
          const n = src[j + 1]
          if (n === 'p' || n === 'P') return { ok: false, reason: 'syntaxError' }
          cls += c + (n ?? '')
          j++
          continue
        }
        if (c === '[' && src[j + 1] === ':') {
          const close = src.indexOf(':]', j + 2)
          const name = close < 0 ? '' : src.slice(j + 2, close)
          const negated = name.startsWith('^')
          const mapped = POSIX_CLASSES[negated ? name.slice(1) : name]
          if (!mapped || negated) return { ok: false, reason: 'syntaxError' }
          cls += mapped
          j = close + 1
          continue
        }
        if (c === '[') cls += '\\['
        else cls += c
      }
      if (!closed) return { ok: false, reason: 'syntaxError' }
      atom(cls + ']', 1, null)
      i = j
      continue
    }
    if (ch === '(') {
      endLiteral()
      depth++
      sizes.push(0)
      if (src[i + 1] === '?') {
        const rest = src.slice(i + 2, i + 5)
        if (rest.startsWith('=') || rest.startsWith('!') || rest.startsWith('<=') || rest.startsWith('<!')) return { ok: false, reason: 'syntaxError' }
        if (rest.startsWith('P<')) {
          out += '(?<'
          i += 3
          continue
        }
      }
      out += '('
      continue
    }
    if (ch === ')') {
      endLiteral()
      if (depth === 0) return { ok: false, reason: 'syntaxError' }
      depth--
      const inner = sizes.pop()!
      sizes[sizes.length - 1] += inner + 1
      lastAtom = inner + 1
      out += ')'
      continue
    }
    if (ch === '|') {
      if (depth === 0) topAlternation = true
      endLiteral()
      sizes[sizes.length - 1] += 1
      out += '|'
      continue
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      // The atom before becomes optional (or repeated): it's no longer a sure literal.
      if (literal) literal = literal.slice(0, -1)
      endLiteral()
      sizes[sizes.length - 1] += 1
      out += ch
      if (src[i + 1] === '?') {
        out += '?'
        i++
      }
      continue
    }
    if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i))
      if (!m) {
        atom('\\{', 1, '{')
        continue
      }
      const min = Number(m[1])
      const max = m[2] ? (m[3] ? Number(m[3]) : min + 1) : min
      if (min > MAX_REPEAT || max > MAX_REPEAT || (m[3] && max < min)) return { ok: false, reason: 'syntaxError' }
      if (literal) literal = literal.slice(0, -1)
      endLiteral()
      sizes[sizes.length - 1] += lastAtom * Math.max(0, max - 1)
      out += m[0]
      i += m[0].length - 1
      if (src[i + 1] === '?') {
        out += '?'
        i++
      }
      continue
    }
    if (ch === '.') {
      atom('.', 1, null)
      continue
    }
    if (ch === '^' || ch === '$') {
      atom(ch, 1, null)
      continue
    }
    atom(escapeRegExp(ch), 1, ch)
  }
  endLiteral()
  if (depth !== 0) return { ok: false, reason: 'syntaxError' }
  try {
    new RegExp(out, flags)
  } catch {
    return { ok: false, reason: 'syntaxError' }
  }
  const size = sizes[0] * (flags.includes('i') ? 1.5 : 1)
  if (size > MAX_PROGRAM) return { ok: false, reason: 'memoryLimitExceeded' }
  if (topAlternation) return { ok: true, source: out, flags }
  // Whole tokens inside the literals: bounded by literal non-token characters.
  const tokens: string[] = []
  for (const lit of literals) {
    const lower = lit.toLowerCase()
    let i = 0
    while (i < lower.length) {
      if (!isTokenChar(lower.charCodeAt(i))) {
        i++
        continue
      }
      let j = i
      while (j < lower.length && isTokenChar(lower.charCodeAt(j))) j++
      if (i > 0 && j < lower.length) tokens.push(lower.slice(i, j))
      i = j
    }
  }
  return { ok: true, source: out, flags, literal: flags.includes('i') ? bestLiteral.toLowerCase() : bestLiteral, tokens }
}

/** The compiled regexFilter of a rule. */
export function ruleRegex(rule: CompiledRule): RegExp {
  if (rule.matcher instanceof RegExp) return rule.matcher
  const check = convertRegex(rule.pattern!, (rule.flags & F_CASE_SENSITIVE) !== 0)
  const re = new RegExp(check.source ?? '(?!)', check.flags)
  rule.matcher = re
  return re
}

// ---- response header conditions ----

/** Header value patterns: `*` any run, `?` zero or one character, `\*` and `\?` literal; case-insensitive, whole value. */
export function headerValuePattern(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && (pattern[i + 1] === '*' || pattern[i + 1] === '?')) source += `\\${pattern[++i]}`
    else if (ch === '*') source += '[^]*'
    else if (ch === '?') source += '[^]?'
    else source += escapeRegExp(ch)
  }
  return new RegExp(`^${source}$`, 'i')
}

/** Whether response headers (lowercase names) satisfy a rule's header conditions. */
export function headerConditionsMatch(extra: RuleExtra, headers: Map<string, string[]>): boolean {
  const test = (c: HeaderCondition): boolean => {
    const values = headers.get(c.name)
    if (!values) return false
    if (c.excluded && values.some((v) => c.excluded!.some((re) => re.test(v)))) return false
    if (c.values) return values.some((v) => c.values!.some((re) => re.test(v)))
    return true
  }
  if (extra.excludedResponseHeaders?.some(test)) return false
  if (extra.responseHeaders && !extra.responseHeaders.some(test)) return false
  return true
}

// ---- redirects ----

/** Where a redirect rule sends the request, or null if it can't (bad result, or the same URL). */
export function redirectUrl(rule: CompiledRule, url: string, extensionId: string): string | null {
  const r = rule.extra?.redirect
  if (!r) return null
  let target: string | null
  switch (r.kind) {
    case 'extensionPath':
      target = `chrome-extension://${extensionId}${r.value}`
      break
    case 'url':
      target = r.value
      break
    case 'transform':
      target = applyTransform(url, r.value)
      break
    case 'regexSubstitution':
      target = substitute(ruleRegex(rule), url, r.value)
      break
  }
  if (!target) return null
  try {
    target = new URL(target).href
  } catch {
    return null
  }
  if (/^javascript:/i.test(target) || target === url) return null
  return target
}

function substitute(re: RegExp, url: string, sub: string): string | null {
  const m = re.exec(url)
  if (!m) return null
  let replaced = ''
  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i]
    if (ch !== '\\') {
      replaced += ch
      continue
    }
    const next = sub[++i]
    if (next === '\\') replaced += '\\'
    else replaced += m[Number(next)] ?? ''
  }
  return url.slice(0, m.index) + replaced + url.slice(m.index + m[0].length)
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ftp: '21', ws: '80', wss: '443' }

export function applyTransform(url: string, t: UrlTransform): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const scheme = t.scheme ?? u.protocol.slice(0, -1)
  const host = t.host ?? u.hostname
  let port = t.port ?? u.port
  if (DEFAULT_PORTS[scheme] === port) port = ''
  const path = t.path ?? u.pathname
  let query = t.query ?? u.search
  if (t.queryTransform) query = transformQuery(u.search, t.queryTransform)
  const fragment = t.fragment ?? u.hash
  const username = t.username ?? u.username
  const password = t.password ?? u.password
  const userinfo = username || password ? `${username}${password ? `:${password}` : ''}@` : ''
  const assembled = `${scheme}://${userinfo}${host}${port ? `:${port}` : ''}${path === '' ? '/' : path}${query}${fragment}`
  try {
    return new URL(assembled).href
  } catch {
    return null
  }
}

/** Removes and adds or replaces query parameters, leaving the others exactly as they were written. */
export function transformQuery(search: string, qt: NonNullable<UrlTransform['queryTransform']>): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  let pairs: [string, string | null][] = raw
    ? raw.split('&').map((p) => {
        const i = p.indexOf('=')
        return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)]
      })
    : []
  const escape = (s: string): string => encodeURIComponent(s)
  if (qt.removeParams?.length) {
    const remove = new Set(qt.removeParams.flatMap((k) => [k, escape(k)]))
    pairs = pairs.filter(([k]) => !remove.has(k))
  }
  if (qt.addOrReplaceParams?.length) {
    const replaced = new Set<number>()
    for (const { key, value, replaceOnly } of qt.addOrReplaceParams) {
      const k = escape(key)
      const index = pairs.findIndex(([name], i) => !replaced.has(i) && (name === k || name === key))
      if (index >= 0) {
        pairs[index] = [pairs[index][0], escape(value)]
        replaced.add(index)
      } else if (!replaceOnly) {
        pairs.push([k, escape(value)])
        replaced.add(pairs.length - 1)
      }
    }
  }
  const out = pairs.filter(([k, v]) => k || v !== null).map(([k, v]) => (v === null ? k : `${k}=${v}`)).join('&')
  return out ? `?${out}` : ''
}

/** http/ftp to https and ws to wss, for upgradeScheme rules; null when there's nothing to upgrade. */
export function upgradedUrl(url: string): string | null {
  if (url.startsWith('http:')) return `https:${url.slice(5)}`
  if (url.startsWith('ftp:')) return `https:${url.slice(4)}`
  if (url.startsWith('ws:')) return `wss:${url.slice(3)}`
  return null
}
