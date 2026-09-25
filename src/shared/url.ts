import type { SearchEngine } from './types'

export const INTERNAL_SCHEME = 'browserr'
export const NEW_TAB_URL = `${INTERNAL_SCHEME}://newtab/`

const SEARCH_URLS: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q='
}

export const SEARCH_ENGINE_NAMES: Record<SearchEngine, string> = {
  google: 'Google',
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  brave: 'Brave Search'
}

export function searchUrl(query: string, engine: SearchEngine): string {
  return SEARCH_URLS[engine] + encodeURIComponent(query)
}

const EXPLICIT_RE = /^([a-z][a-z0-9+.-]*:\/\/|(about|mailto|data):)/i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/
const HOST_RE = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i
const LOCALHOST_RE = /^localhost(:\d+)?([/?#].*)?$/i

export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  return EXPLICIT_RE.test(text) || LOCALHOST_RE.test(text) || IPV4_RE.test(text) || HOST_RE.test(text)
}

/** Turns whatever was typed into the address bar into a URL to load. */
export function toNavigableUrl(input: string, engine: SearchEngine): string {
  const text = input.trim()
  if (!text) return NEW_TAB_URL
  if (EXPLICIT_RE.test(text) && !/\s/.test(text)) return text
  if (looksLikeUrl(text)) {
    const isLocal = LOCALHOST_RE.test(text) || IPV4_RE.test(text)
    return (isLocal ? 'http://' : 'https://') + text
  }
  return searchUrl(text, engine)
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith(`${INTERNAL_SCHEME}:`)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Short, readable form of a URL for the address bar and lists. */
export function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
    const path = u.pathname === '/' ? '' : u.pathname
    return u.host.replace(/^www\./, '') + path + u.search + u.hash
  } catch {
    return url
  }
}
