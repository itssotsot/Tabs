/**
 * Chrome extension match patterns (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns):
 * `<scheme>://<host>/<path>`, where the scheme may be `*` (http or https), the host `*` or `*.example.com`,
 * and the path may contain `*` wildcards. `<all_urls>` matches every URL with a permitted scheme.
 */

const ALL_URLS_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:', 'urn:'])
const STAR_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

export class MatchPattern {
  private constructor(
    readonly pattern: string,
    private readonly all: boolean,
    private readonly scheme: string | null,
    private readonly host: string | null,
    private readonly anySubdomain: boolean,
    private readonly path: RegExp | null
  ) {}

  static parse(pattern: string): MatchPattern | null {
    if (pattern === '<all_urls>') return new MatchPattern(pattern, true, null, null, false, null)
    const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern)
    if (!m) return null
    const scheme = m[1].toLowerCase()
    let host = m[2].toLowerCase()
    const path = m[3] ?? '/'
    if (scheme !== 'file' && !host) return null
    // A port in the host part is ignored, like Chrome does for most schemes.
    host = host.replace(/:(\d+|\*)$/, '')
    let anySubdomain = false
    if (host === '*') host = ''
    else if (host.startsWith('*.')) {
      anySubdomain = true
      host = host.slice(2)
    } else if (host.includes('*')) return null
    return new MatchPattern(pattern, false, scheme === '*' ? null : `${scheme}:`, host || null, anySubdomain, globToRegExp(path))
  }

  matches(input: string | URL): boolean {
    let url: URL
    try {
      url = typeof input === 'string' ? new URL(input) : input
    } catch {
      return false
    }
    if (this.all) return ALL_URLS_SCHEMES.has(url.protocol)
    if (this.scheme ? url.protocol !== this.scheme : !STAR_SCHEMES.has(url.protocol)) return false
    if (!this.matchesHost(url.hostname)) return false
    return !this.path || this.path.test(url.pathname + url.search)
  }

  /** Whether the pattern covers every page on this host (ignoring the path). */
  matchesHost(hostname: string): boolean {
    if (this.all || !this.host) return true
    const host = hostname.toLowerCase().replace(/\.$/, '')
    return host === this.host || (this.anySubdomain && host.endsWith(`.${this.host}`))
  }

  /** True for `<all_urls>` and patterns like `*://*\/*` that cover every site. */
  get coversAllHosts(): boolean {
    return this.all || (!this.host && (this.scheme === null || this.scheme === 'http:' || this.scheme === 'https:'))
  }

  /** A readable host for permission prompts ("example.com", "all sites"). */
  get hostLabel(): string {
    if (this.coversAllHosts) return 'all sites'
    return this.host ? (this.anySubdomain ? `*.${this.host}` : this.host) : this.pattern
  }
}

/** `*` matches any run of characters, everything else is literal. Anchored at both ends. */
export function globToRegExp(glob: string, extraWildcards = false): RegExp {
  let source = ''
  for (const ch of glob) {
    if (ch === '*') source += '.*'
    else if (extraWildcards && ch === '?') source += '.'
    else source += ch.replace(/[\\^$.+?()[\]{}|/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const cache = new Map<string, MatchPattern | null>()

export function matchPattern(pattern: string): MatchPattern | null {
  let parsed = cache.get(pattern)
  if (parsed === undefined) {
    parsed = MatchPattern.parse(pattern)
    if (cache.size > 5000) cache.clear()
    cache.set(pattern, parsed)
  }
  return parsed
}

/** Whether any of the patterns matches the URL. Unparseable patterns never match. */
export function matchesAny(patterns: readonly string[] | undefined, url: string | URL): boolean {
  if (!patterns?.length) return false
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  return patterns.some((p) => matchPattern(p)?.matches(parsed) ?? false)
}

/** Content scripts' include_globs / exclude_globs: `*` any run, `?` one character, over the whole URL. */
export function matchesGlobs(url: string, includeGlobs?: readonly string[], excludeGlobs?: readonly string[]): boolean {
  if (includeGlobs?.length && !includeGlobs.some((g) => globToRegExp(g, true).test(url))) return false
  if (excludeGlobs?.length && excludeGlobs.some((g) => globToRegExp(g, true).test(url))) return false
  return true
}
