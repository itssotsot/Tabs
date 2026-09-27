import type { Cookie, CookiesGetFilter, CookiesSetDetails, Session, WebContents } from 'electron'
import { hasHostAccess } from '../../access'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, listeningExtensions, webContentsById, type CallContext } from '../../router'
import { allExtraWindows, allTabs, chromeTabId, findTab } from '../../tabs-model'
import { asObject, isCrossSite, siteOf } from './util'

/**
 * chrome.cookies over the web session's cookie store. Tabs has one store ("0") for every tab.
 * Extensions only see and change cookies of hosts they have permission for. Electron doesn't
 * expose partitioned (CHIPS) cookies, so only unpartitioned ones are listed.
 */

const STORE_ID = '0'
const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified'])
let ses: Session | null = null

function session(): Session {
  if (!ses) throw new ExtensionError('Cookies are not available yet.')
  return ses
}

/** The URL Chrome checks host permissions against for a cookie. */
function cookieUrl(c: Cookie): string {
  const host = (c.domain ?? '').replace(/^\./, '')
  return `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`
}

function toChromeCookie(c: Cookie): chrome.cookies.Cookie {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    hostOnly: c.hostOnly ?? !(c.domain ?? '').startsWith('.'),
    path: c.path ?? '/',
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite,
    session: c.session ?? c.expirationDate === undefined,
    storeId: STORE_ID
  } as chrome.cookies.Cookie
  if (!out.session && c.expirationDate !== undefined) out.expirationDate = c.expirationDate
  return out
}

function checkStore(storeId: unknown): void {
  if (storeId !== undefined && storeId !== STORE_ID) throw new ExtensionError(`Invalid cookie store id: "${String(storeId)}".`)
}

function requireUrl(call: CallContext, url: unknown): string {
  if (typeof url !== 'string') throw new ExtensionError("Missing required property 'url'.")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ExtensionError(`Invalid url: "${url}".`)
  }
  if (!hasHostAccess(call.extensionId, parsed.href)) throw new ExtensionError(`No host permissions for cookies at url: "${url}".`)
  return parsed.href
}

/** Chrome ignores partitioned lookups for cookies it can't see; an explicit partition matches nothing here. */
function wantsPartition(partitionKey: unknown): boolean {
  return !!asObject(partitionKey).topLevelSite
}

async function get(call: CallContext, details: unknown): Promise<chrome.cookies.Cookie | null> {
  const d = asObject(details)
  checkStore(d.storeId)
  const url = requireUrl(call, d.url)
  if (typeof d.name !== 'string') throw new ExtensionError("Missing required property 'name'.")
  if (wantsPartition(d.partitionKey)) return null
  const cookies = await session().cookies.get({ url, name: d.name })
  // The most specific path wins, like the Cookie header order.
  const best = cookies.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0]
  return best ? toChromeCookie(best) : null
}

async function getAll(call: CallContext, details: unknown): Promise<chrome.cookies.Cookie[]> {
  const d = asObject(details)
  checkStore(d.storeId)
  if (wantsPartition(d.partitionKey)) return []
  const filter: CookiesGetFilter = {}
  if (d.url !== undefined) filter.url = requireUrl(call, d.url)
  for (const key of ['name', 'domain', 'path'] as const) {
    if (d[key] !== undefined) {
      if (typeof d[key] !== 'string') throw new ExtensionError(`Invalid '${key}'.`)
      filter[key] = d[key] as string
    }
  }
  for (const key of ['secure', 'session'] as const) {
    if (d[key] !== undefined) {
      if (typeof d[key] !== 'boolean') throw new ExtensionError(`Invalid '${key}'.`)
      filter[key] = d[key] as boolean
    }
  }
  const cookies = await session().cookies.get(filter)
  return cookies.filter((c) => hasHostAccess(call.extensionId, cookieUrl(c))).map(toChromeCookie)
}

async function set(call: CallContext, details: unknown): Promise<chrome.cookies.Cookie | null> {
  const d = asObject(details)
  checkStore(d.storeId)
  const url = requireUrl(call, d.url)
  if (wantsPartition(d.partitionKey)) throw new ExtensionError('Partitioned cookies are not supported.')
  const out: CookiesSetDetails = { url }
  for (const key of ['name', 'value', 'domain', 'path'] as const) {
    if (d[key] === undefined) continue
    if (typeof d[key] !== 'string') throw new ExtensionError(`Invalid '${key}'.`)
    out[key] = d[key] as string
  }
  for (const key of ['secure', 'httpOnly'] as const) {
    if (d[key] === undefined) continue
    if (typeof d[key] !== 'boolean') throw new ExtensionError(`Invalid '${key}'.`)
    out[key] = d[key] as boolean
  }
  if (d.expirationDate !== undefined) {
    if (typeof d.expirationDate !== 'number') throw new ExtensionError("Invalid 'expirationDate'.")
    out.expirationDate = d.expirationDate
  }
  if (d.sameSite !== undefined) {
    if (!SAME_SITE.has(d.sameSite as string)) throw new ExtensionError(`Invalid 'sameSite': ${String(d.sameSite)}.`)
    out.sameSite = d.sameSite as CookiesSetDetails['sameSite']
  }
  try {
    await session().cookies.set(out)
  } catch (err) {
    throw new ExtensionError(`Failed to parse or set cookie named "${out.name ?? ''}". ${err instanceof Error ? err.message : ''}`.trim())
  }
  // Read back what the store actually kept.
  const stored = await session().cookies.get({ url, name: out.name ?? '' })
  const bare = (domain: string | undefined): string => (domain ?? '').replace(/^\./, '')
  const match =
    stored.find((c) => (out.path === undefined || c.path === out.path) && (out.domain === undefined || bare(c.domain) === bare(out.domain))) ??
    stored[0]
  return match ? toChromeCookie(match) : null
}

async function remove(call: CallContext, details: unknown): Promise<{ url: string; name: string; storeId: string } | null> {
  const d = asObject(details)
  checkStore(d.storeId)
  const url = requireUrl(call, d.url)
  if (typeof d.name !== 'string') throw new ExtensionError("Missing required property 'name'.")
  if (wantsPartition(d.partitionKey)) return null
  await session().cookies.remove(url, d.name)
  return { url: d.url as string, name: d.name, storeId: STORE_ID }
}

function getAllCookieStores(): chrome.cookies.CookieStore[] {
  const tabIds = [...allTabs().map(({ tab }) => chromeTabId(tab)), ...allExtraWindows().map((w) => w.wc.id)]
  return [{ id: STORE_ID, tabIds }]
}

/** The partition key of a frame's cookies: its top-level site, and whether any ancestor is cross-site. */
function getPartitionKey(_call: CallContext, details: unknown): { partitionKey: { topLevelSite: string; hasCrossSiteAncestor: boolean } } {
  const d = asObject(details)
  let wc: WebContents | null = null
  if (typeof d.tabId === 'number') {
    const found = findTab(d.tabId)
    wc = found?.tab.liveWc ?? webContentsById(d.tabId)
  }
  if (!wc) throw new ExtensionError('No matching frame.')
  const frameId = typeof d.frameId === 'number' ? d.frameId : 0
  const frame = frameId === 0 ? wc.mainFrame : wc.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === frameId)
  if (!frame) throw new ExtensionError(`No frame with id ${frameId} in tab ${String(d.tabId)}.`)
  const topUrl = wc.mainFrame.url
  const topLevelSite = siteOf(topUrl) ?? ''
  let hasCrossSiteAncestor = false
  for (let f: typeof frame | null = frame; f?.parent; f = f.parent) {
    if (isCrossSite(f.url, topUrl)) hasCrossSiteAncestor = true
  }
  return { partitionKey: { topLevelSite, hasCrossSiteAncestor } }
}

defineApi('cookies', {
  permissions: ['cookies'],
  methods: { get, getAll, set, remove, getAllCookieStores, getPartitionKey }
})

defineEvent('cookies.onChanged', { permissions: ['cookies'] })

type Cause = 'inserted' | 'inserted-no-change-overwrite' | 'inserted-no-value-change-overwrite' | 'explicit' | 'overwrite' | 'expired' | 'evicted' | 'expired-overwrite'

/** Chrome's OnChangedCause for Electron's cause, or null for changes Chrome doesn't report. */
function chromeCause(cause: Cause): chrome.cookies.OnChangedCause | null {
  switch (cause) {
    case 'inserted':
    case 'explicit':
    case 'inserted-no-value-change-overwrite':
      return 'explicit' as chrome.cookies.OnChangedCause
    case 'overwrite':
      return 'overwrite' as chrome.cookies.OnChangedCause
    case 'expired':
      return 'expired' as chrome.cookies.OnChangedCause
    case 'evicted':
      return 'evicted' as chrome.cookies.OnChangedCause
    case 'expired-overwrite':
      return 'expired_overwrite' as chrome.cookies.OnChangedCause
    default:
      // Written again without any change.
      return null
  }
}

lifecycle.on('ready', (session) => {
  ses = session
  session.cookies.on('changed', (_e, cookie, cause, removed) => {
    if (!listeningExtensions('cookies.onChanged').length) return
    const mapped = chromeCause(cause)
    if (!mapped) return
    const url = cookieUrl(cookie)
    const info = { removed, cookie: toChromeCookie(cookie), cause: mapped }
    emit('cookies.onChanged', (id) => (hasHostAccess(id, url) ? [info] : null))
  })
})
