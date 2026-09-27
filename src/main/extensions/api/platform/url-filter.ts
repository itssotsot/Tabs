/**
 * events.UrlFilter matching, as used by webNavigation's `{ url: UrlFilter[] }` listener filters
 * (https://developer.chrome.com/docs/extensions/reference/api/events#type-UrlFilter).
 *
 * Every condition given in one UrlFilter must match; a listener filter matches when any of its
 * UrlFilters does. Hosts are compared with an implicit leading dot, like Chrome, so
 * `hostContains: '.foo'` matches both `foo.com` and `www.foobar.com`, and `hostSuffix: '.example.com'`
 * also matches `example.com`. URLs are compared without the fragment and credentials, and without
 * the port when it's the scheme's default.
 */

export interface UrlFilter {
  hostContains?: string
  hostEquals?: string
  hostPrefix?: string
  hostSuffix?: string
  pathContains?: string
  pathEquals?: string
  pathPrefix?: string
  pathSuffix?: string
  queryContains?: string
  queryEquals?: string
  queryPrefix?: string
  querySuffix?: string
  urlContains?: string
  urlEquals?: string
  urlMatches?: string
  originAndPathMatches?: string
  urlPrefix?: string
  urlSuffix?: string
  schemes?: string[]
  ports?: (number | number[])[]
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21 }

interface Parts {
  scheme: string
  host: string
  path: string
  query: string
  port: number | null
  /** Without fragment and credentials. */
  url: string
  /** Without query and fragment. */
  originAndPath: string
}

function partsOf(input: string): Parts | null {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return null
  }
  u.hash = ''
  if (u.username || u.password) {
    u.username = ''
    u.password = ''
  }
  const scheme = u.protocol.replace(/:$/, '')
  const port = u.port ? Number(u.port) : (DEFAULT_PORTS[scheme] ?? null)
  // `new URL` keeps a lone trailing '#' after clearing the hash on some schemes.
  const url = u.href.replace(/#$/, '')
  const query = u.search.replace(/^\?/, '')
  const originAndPath = u.search ? url.slice(0, url.length - u.search.length) : url
  return { scheme, host: u.hostname.toLowerCase(), path: u.pathname, query, port, url, originAndPath }
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f'
}

const regexCache = new Map<string, RegExp | null>()

/** Translates the RE2 syntax Chrome accepts into a JavaScript RegExp (null when it can't be compiled). */
export function re2ToRegExp(source: string): RegExp | null {
  const cached = regexCache.get(source)
  if (cached !== undefined) return cached
  let flags = ''
  let src = source
  // Leading flag groups: (?i), (?s), (?m), (?U is unsupported and dropped).
  const lead = /^\(\?([imsU]+)\)/.exec(src)
  if (lead) {
    for (const f of lead[1]) if (f !== 'U' && !flags.includes(f)) flags += f
    src = src.slice(lead[0].length)
  }
  src = src
    .replace(/\(\?P</g, '(?<')
    .replace(/\[:(\^?)([a-z]+):\]/g, (all, neg: string, name: string) => (POSIX_CLASSES[name] && !neg ? POSIX_CLASSES[name] : all))
    .replace(/(^|[^\\])\\A/g, '$1^')
    .replace(/(^|[^\\])\\z/g, '$1$')
    .replace(/(^|[^\\])\\C/g, '$1.')
  let re: RegExp | null = null
  for (const f of /\\[pP]\{/.test(src) ? [flags + 'u', flags] : [flags, flags + 'u']) {
    try {
      re = new RegExp(src, f)
      break
    } catch {
      // Try the other mode.
    }
  }
  if (regexCache.size > 500) regexCache.clear()
  regexCache.set(source, re)
  return re
}

const canonHost = (value: string): string => (value.startsWith('.') ? value : `.${value}`).toLowerCase()

function portMatches(port: number | null, ports: (number | number[])[]): boolean {
  if (port === null) return false
  return ports.some((p) => (Array.isArray(p) ? p.length === 2 && port >= p[0] && port <= p[1] : p === port))
}

function matchesParts(p: Parts, f: UrlFilter): boolean {
  const host = `.${p.host}`
  if (f.hostContains !== undefined && !host.includes(f.hostContains.toLowerCase())) return false
  if (f.hostEquals !== undefined && host !== canonHost(f.hostEquals)) return false
  if (f.hostPrefix !== undefined && !host.startsWith(canonHost(f.hostPrefix))) return false
  if (f.hostSuffix !== undefined && !host.endsWith(f.hostSuffix.toLowerCase())) return false
  if (f.pathContains !== undefined && !p.path.includes(f.pathContains)) return false
  if (f.pathEquals !== undefined && p.path !== f.pathEquals) return false
  if (f.pathPrefix !== undefined && !p.path.startsWith(f.pathPrefix)) return false
  if (f.pathSuffix !== undefined && !p.path.endsWith(f.pathSuffix)) return false
  if (f.queryContains !== undefined && !p.query.includes(f.queryContains)) return false
  if (f.queryEquals !== undefined && p.query !== f.queryEquals) return false
  if (f.queryPrefix !== undefined && !p.query.startsWith(f.queryPrefix)) return false
  if (f.querySuffix !== undefined && !p.query.endsWith(f.querySuffix)) return false
  if (f.urlContains !== undefined && !p.url.includes(f.urlContains)) return false
  if (f.urlEquals !== undefined && p.url !== f.urlEquals) return false
  if (f.urlPrefix !== undefined && !p.url.startsWith(f.urlPrefix)) return false
  if (f.urlSuffix !== undefined && !p.url.endsWith(f.urlSuffix)) return false
  if (f.urlMatches !== undefined && !re2ToRegExp(f.urlMatches)?.test(p.url)) return false
  if (f.originAndPathMatches !== undefined && !re2ToRegExp(f.originAndPathMatches)?.test(p.originAndPath)) return false
  if (f.schemes?.length && !f.schemes.map((s) => s.toLowerCase()).includes(p.scheme)) return false
  if (f.ports?.length && !portMatches(p.port, f.ports)) return false
  return true
}

/** Whether a URL matches one UrlFilter. */
export function matchesUrlFilter(url: string, filter: UrlFilter): boolean {
  const parts = partsOf(url)
  return !!parts && !!filter && typeof filter === 'object' && matchesParts(parts, filter)
}

/** A listener filter `{ url: UrlFilter[] }`: no list (or no filter) matches everything. */
export function matchesUrlFilters(url: string, filters: UrlFilter[] | undefined): boolean {
  if (!Array.isArray(filters)) return true
  const parts = partsOf(url)
  if (!parts) return false
  return filters.some((f) => !!f && typeof f === 'object' && matchesParts(parts, f))
}
