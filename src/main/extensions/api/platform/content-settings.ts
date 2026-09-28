import type { Session, WebContents, WebFrameMain } from 'electron'
import type { SitePermission } from '@shared/types'
import { store } from '../../../store'
import { addBlockingHandler, removeHandler } from '../../../web-request-hub'
import { hasApiPermission, loadedExtension } from '../../access'
import { lifecycle } from '../../lifecycle'
import { defineApi, ExtensionError, type CallContext } from '../../router'
import { getGlobalState, setGlobalState } from '../../state'
import { checkScope, extensionPrecedence } from './chrome-setting'
import { asObject, isCrossSite } from './util'

/**
 * chrome.contentSettings: per-site rules extensions set for cookies, images, JavaScript, popups
 * and permission prompts. Rules are stored and resolved like Chrome (the most specific pattern
 * wins, then the most recently installed extension). What the browser can enforce by itself is
 * applied here through the web request hub: blocked images, blocked JavaScript (a CSP header)
 * and blocked cookies. Popups, downloads and permission prompts are decided elsewhere and ask
 * `contentSettingFor`.
 */

export type ContentSettingValue = 'allow' | 'block' | 'ask' | 'session_only' | 'detect_important_content'

interface TypeInfo {
  allowed: ContentSettingValue[]
  default: ContentSettingValue
  /** The site permission (src/main/permissions.ts) the user's own choice is stored under. */
  sitePermission?: SitePermission
  /** Deprecated in Chrome: always reports the default, ignores set and clear. */
  fixed?: boolean
}

const TYPES: Record<string, TypeInfo> = {
  cookies: { allowed: ['allow', 'block', 'session_only'], default: 'allow' },
  images: { allowed: ['allow', 'block'], default: 'allow' },
  javascript: { allowed: ['allow', 'block'], default: 'allow' },
  location: { allowed: ['allow', 'block', 'ask'], default: 'ask', sitePermission: 'geolocation' },
  plugins: { allowed: ['block'], default: 'block', fixed: true },
  // Tabs doesn't block popups.
  popups: { allowed: ['allow', 'block'], default: 'allow' },
  notifications: { allowed: ['allow', 'block', 'ask'], default: 'ask', sitePermission: 'notifications' },
  microphone: { allowed: ['allow', 'block', 'ask'], default: 'ask', sitePermission: 'microphone' },
  camera: { allowed: ['allow', 'block', 'ask'], default: 'ask', sitePermission: 'camera' },
  unsandboxedPlugins: { allowed: ['allow', 'block', 'ask'], default: 'block' },
  automaticDownloads: { allowed: ['allow', 'block', 'ask'], default: 'ask' },
  autoVerify: { allowed: ['allow', 'block'], default: 'allow' },
  clipboard: { allowed: ['allow', 'block', 'ask'], default: 'ask', sitePermission: 'clipboard-read' }
}

// ---- patterns ----

interface ContentPattern {
  all: boolean
  /** Null for any of http/https. */
  scheme: string | null
  /** Empty for any host. */
  host: string
  anySubdomain: boolean
  /** Null for any port. */
  port: number | null
  /** Only file: patterns have a path. */
  path: string | null
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/** Parses a content setting pattern (https://developer.chrome.com/docs/extensions/reference/api/contentSettings#patterns). */
export function parseContentPattern(pattern: string): ContentPattern | null {
  if (pattern === '<all_urls>') return { all: true, scheme: null, host: '', anySubdomain: true, port: null, path: null }
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (scheme === 'file') return { all: false, scheme: 'file:', host: '', anySubdomain: false, port: null, path: m[3] ?? '/' }
  const hostPort = /^(\*|(?:\*\.)?[^:*]+|\[[0-9a-f:.]+\])(?::(\*|\d+))?$/i.exec(m[2])
  if (!hostPort) return null
  if (m[3] !== undefined && m[3] !== '/*') throw new ExtensionError('Specific paths are not allowed.')
  let host = hostPort[1].toLowerCase()
  let anySubdomain = false
  if (host === '*') host = ''
  else if (host.startsWith('*.')) {
    anySubdomain = true
    host = host.slice(2)
  }
  const port = hostPort[2] === undefined || hostPort[2] === '*' ? null : Number(hostPort[2])
  return { all: false, scheme: scheme === '*' ? null : `${scheme}:`, host, anySubdomain, port, path: null }
}

function patternMatches(p: ContentPattern, url: URL | null): boolean {
  if (p.all) return true
  if (!url) return false
  if (p.scheme === 'file:') return url.protocol === 'file:' && url.pathname === p.path
  if (p.scheme ? url.protocol !== p.scheme : url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (p.host && !(host === p.host || (p.anySubdomain && host.endsWith(`.${p.host}`)))) return false
  if (p.port !== null) {
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol]
    if (port !== p.port) return false
  }
  return true
}

/** Higher is more specific; compared element by element. */
function specificity(p: ContentPattern): number[] {
  if (p.all) return [0, 0, 0, 0]
  const hostKind = p.path !== null ? 4 : !p.host ? 1 : p.anySubdomain ? 2 : 3
  return [hostKind, p.host ? p.host.split('.').length : 0, p.scheme ? 1 : 0, p.port !== null ? 1 : 0]
}

function compareSpecificity(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// ---- rules ----

interface Rule {
  primaryPattern: string
  secondaryPattern: string
  resourceIdentifier?: string
  setting: ContentSettingValue
  at: number
}

/** Extension id -> content type -> its rules. */
type Stored = Record<string, Record<string, Rule[]>>

const STATE_KEY = 'contentSettings'
const stored = (): Stored => getGlobalState<Stored>(STATE_KEY, {})

function parseUrl(url: string | undefined): URL | null {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * The setting extensions chose for a URL (and the top-level URL it's loaded in, where the type
 * cares), or undefined when no extension rule applies.
 */
export function contentSettingFor(type: string, primaryUrl: string, secondaryUrl?: string, resourceIdentifier?: string): ContentSettingValue | undefined {
  if (!TYPES[type] || TYPES[type].fixed) return undefined
  const primary = parseUrl(primaryUrl)
  const secondary = parseUrl(secondaryUrl ?? primaryUrl)
  let best: { rule: Rule; spec: number[]; secondarySpec: number[]; precedence: number } | null = null
  for (const [extensionId, byType] of Object.entries(stored())) {
    const rules = byType[type]
    if (!rules?.length || !loadedExtension(extensionId) || !hasApiPermission(extensionId, 'contentSettings')) continue
    const precedence = extensionPrecedence(extensionId)
    for (const rule of rules) {
      if (rule.resourceIdentifier && rule.resourceIdentifier !== resourceIdentifier) continue
      const p = safeParse(rule.primaryPattern)
      const s = safeParse(rule.secondaryPattern)
      if (!p || !s || !patternMatches(p, primary) || !patternMatches(s, secondary)) continue
      const candidate = { rule, spec: specificity(p), secondarySpec: specificity(s), precedence }
      if (!best || isBetter(candidate, best)) best = candidate
    }
  }
  return best?.rule.setting
}

function isBetter(
  a: { rule: Rule; spec: number[]; secondarySpec: number[]; precedence: number },
  b: { rule: Rule; spec: number[]; secondarySpec: number[]; precedence: number }
): boolean {
  return (
    compareSpecificity(a.spec, b.spec) ||
    compareSpecificity(a.secondarySpec, b.secondarySpec) ||
    a.precedence - b.precedence ||
    a.rule.at - b.rule.at
  ) > 0
}

function safeParse(pattern: string): ContentPattern | null {
  try {
    return parseContentPattern(pattern)
  } catch {
    return null
  }
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function typeInfo(type: unknown): TypeInfo {
  const info = typeof type === 'string' ? TYPES[type] : undefined
  if (!info) throw new ExtensionError(`Unknown content type: ${String(type)}.`)
  return info
}

function get(_call: CallContext, type: unknown, details: unknown): { setting: ContentSettingValue } {
  const info = typeInfo(type)
  const d = asObject(details)
  checkScope({ incognito: d.incognito })
  if (typeof d.primaryUrl !== 'string' || !parseUrl(d.primaryUrl)) throw new ExtensionError("Invalid or missing 'primaryUrl'.")
  if (d.secondaryUrl !== undefined && (typeof d.secondaryUrl !== 'string' || !parseUrl(d.secondaryUrl))) throw new ExtensionError("Invalid 'secondaryUrl'.")
  if (info.fixed) return { setting: info.default }
  const resourceId = asObject(d.resourceIdentifier).id as string | undefined
  const fromExtensions = contentSettingFor(type as string, d.primaryUrl, d.secondaryUrl as string | undefined, resourceId)
  if (fromExtensions) return { setting: fromExtensions }
  // The user's own choice for the site.
  if (info.sitePermission) {
    const origin = originOf(d.primaryUrl)
    const saved = origin ? store.getPermission(origin, info.sitePermission) : undefined
    if (saved) return { setting: saved === 'allow' ? 'allow' : 'block' }
  }
  return { setting: info.default }
}

function set(call: CallContext, type: unknown, details: unknown): void {
  const info = typeInfo(type)
  const d = asObject(details)
  checkScope(d)
  if (info.fixed) return
  if (typeof d.primaryPattern !== 'string') throw new ExtensionError("Missing required property 'primaryPattern'.")
  const secondaryPattern = d.secondaryPattern === undefined ? '<all_urls>' : d.secondaryPattern
  if (typeof secondaryPattern !== 'string') throw new ExtensionError("Invalid 'secondaryPattern'.")
  for (const pattern of [d.primaryPattern, secondaryPattern]) {
    if (!parseContentPattern(pattern)) throw new ExtensionError(`The pattern "${pattern}" is invalid.`)
  }
  if (typeof d.setting !== 'string' || !(info.allowed as string[]).includes(d.setting)) {
    throw new ExtensionError(`Invalid setting "${String(d.setting)}" for content type ${String(type)}.`)
  }
  const resourceIdentifier = asObject(d.resourceIdentifier).id as string | undefined
  const data = stored()
  const byType = (data[call.extensionId] ??= {})
  const rules = (byType[type as string] ?? []).filter(
    (r) => !(r.primaryPattern === d.primaryPattern && r.secondaryPattern === secondaryPattern && r.resourceIdentifier === resourceIdentifier)
  )
  rules.push({ primaryPattern: d.primaryPattern, secondaryPattern, resourceIdentifier, setting: d.setting as ContentSettingValue, at: Date.now() })
  byType[type as string] = rules
  setGlobalState(STATE_KEY, data)
  updateEnforcement()
}

function clear(call: CallContext, type: unknown, details: unknown): void {
  const info = typeInfo(type)
  checkScope(asObject(details))
  if (info.fixed) return
  const data = stored()
  if (!data[call.extensionId]?.[type as string]) return
  delete data[call.extensionId][type as string]
  if (!Object.keys(data[call.extensionId]).length) delete data[call.extensionId]
  setGlobalState(STATE_KEY, data)
  updateEnforcement()
}

defineApi('contentSettings', {
  permissions: ['contentSettings'],
  methods: {
    get,
    set,
    clear,
    // Only plugins had resource identifiers, and plugins are gone.
    getResourceIdentifiers: (_call, type) => {
      typeInfo(type)
      return undefined
    }
  }
})

// ---- enforcement ----

let ses: Session | null = null
let thirdPartyCookiesBlocked = false

/** chrome.privacy.websites.thirdPartyCookiesAllowed = false. */
export function setThirdPartyCookiesBlocked(blocked: boolean): void {
  thirdPartyCookiesBlocked = blocked
  updateEnforcement()
}

/** Whether any running extension has rules of this type that block something. */
function hasBlockingRules(type: string): boolean {
  return Object.entries(stored()).some(
    ([id, byType]) => !!loadedExtension(id) && hasApiPermission(id, 'contentSettings') && (byType[type] ?? []).some((r) => r.setting === 'block')
  )
}

const isWebUrl = (url: string | undefined): url is string => !!url && /^(https?|file):/i.test(url)

/** The URL of the page a request belongs to. */
function topUrlOf(details: { resourceType?: string; url: string; frame?: WebFrameMain | null; webContents?: WebContents }): string | undefined {
  if (details.resourceType === 'mainFrame') return details.url
  try {
    const top = details.frame?.top
    if (top && !top.isDestroyed() && top.url) return top.url
  } catch {
    // The frame is gone.
  }
  return details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : undefined
}

function headerKey(headers: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === name)
}

function cookiesBlocked(url: string, topUrl: string | undefined): boolean {
  if (!isWebUrl(url)) return false
  if (thirdPartyCookiesBlocked && topUrl && isWebUrl(topUrl) && isCrossSite(url, topUrl)) return true
  return contentSettingFor('cookies', url, topUrl ?? url) === 'block'
}

const HANDLERS = {
  images: 'ext-content-settings-images',
  javascript: 'ext-content-settings-javascript',
  cookiesOut: 'ext-content-settings-cookies-out',
  cookiesIn: 'ext-content-settings-cookies-in'
}

/** Adds the web request handlers the current rules need, and drops the ones they don't. */
function updateEnforcement(): void {
  if (!ses) return
  if (hasBlockingRules('images')) {
    addBlockingHandler(ses, 'onBeforeRequest', {
      id: HANDLERS.images,
      handle: (details) => {
        if (details.resourceType !== 'image') return
        const top = topUrlOf(details)
        if (isWebUrl(top) && contentSettingFor('images', top, top) === 'block') return { cancel: true }
      }
    })
  } else removeHandler(ses, 'onBeforeRequest', HANDLERS.images)

  if (hasBlockingRules('javascript')) {
    addBlockingHandler(ses, 'onHeadersReceived', {
      id: HANDLERS.javascript,
      handle: (details) => {
        if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return
        const top = topUrlOf(details)
        if (!isWebUrl(top) || contentSettingFor('javascript', top, top) !== 'block') return
        const headers = { ...(details.responseHeaders ?? {}) }
        const key = headerKey(headers, 'content-security-policy') ?? 'Content-Security-Policy'
        headers[key] = [...(headers[key] ?? []), "script-src 'none'"]
        return { responseHeaders: headers }
      }
    })
  } else removeHandler(ses, 'onHeadersReceived', HANDLERS.javascript)

  if (thirdPartyCookiesBlocked || hasBlockingRules('cookies')) {
    addBlockingHandler(ses, 'onBeforeSendHeaders', {
      id: HANDLERS.cookiesOut,
      handle: (details) => {
        if (!cookiesBlocked(details.url, topUrlOf(details))) return
        const key = headerKey(details.requestHeaders, 'cookie')
        if (!key) return
        const requestHeaders = { ...details.requestHeaders }
        delete requestHeaders[key]
        return { requestHeaders }
      }
    })
    addBlockingHandler(ses, 'onHeadersReceived', {
      id: HANDLERS.cookiesIn,
      handle: (details) => {
        const headers = details.responseHeaders
        const key = headers && headerKey(headers, 'set-cookie')
        if (!key || !cookiesBlocked(details.url, topUrlOf(details))) return
        const responseHeaders = { ...headers }
        delete responseHeaders[key]
        return { responseHeaders }
      }
    })
  } else {
    removeHandler(ses, 'onBeforeSendHeaders', HANDLERS.cookiesOut)
    removeHandler(ses, 'onHeadersReceived', HANDLERS.cookiesIn)
  }
}

lifecycle.on('ready', (session) => {
  ses = session
})
lifecycle.on('loaded', () => updateEnforcement())
lifecycle.on('unloaded', () => setTimeout(updateEnforcement, 0))
lifecycle.on('uninstalled', (extensionId) => {
  const data = stored()
  if (!data[extensionId]) return
  delete data[extensionId]
  setGlobalState(STATE_KEY, data)
  updateEnforcement()
})
