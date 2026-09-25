import { MAX_SUGGESTIONS } from '@shared/constants'
import type { SearchEngine, Suggestion } from '@shared/types'
import { looksLikeUrl, searchUrl, toNavigableUrl } from '@shared/url'
import { webSession } from './env'
import { store } from './store'

const SUGGEST_ENDPOINTS: Record<SearchEngine, (q: string) => string> = {
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?type=list&q=${q}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  brave: (q) => `https://search.brave.com/api/suggest?q=${q}`
}

async function remoteSuggestions(query: string, engine: SearchEngine): Promise<string[]> {
  try {
    const res = await webSession().fetch(SUGGEST_ENDPOINTS[engine](encodeURIComponent(query)), {
      signal: AbortSignal.timeout(600)
    })
    const data = (await res.json()) as [string, string[]]
    return Array.isArray(data?.[1]) ? data[1].filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

export async function omniboxSuggestions(text: string): Promise<Suggestion[]> {
  const input = text.trim()
  if (!input) return []
  const engine = store.settings.searchEngine
  const lower = input.toLowerCase()

  const primary: Suggestion = looksLikeUrl(input)
    ? { type: 'url', url: toNavigableUrl(input, engine), title: input }
    : { type: 'search', url: searchUrl(input, engine), title: input }

  const bookmarks: Suggestion[] = store.bookmarks
    .filter((b) => b.url.toLowerCase().includes(lower) || b.title.toLowerCase().includes(lower))
    .slice(0, 3)
    .map((b) => ({ type: 'bookmark', url: b.url, title: b.title }))

  const history: Suggestion[] = store
    .matchHistory(input, 6)
    .map((h) => ({ type: 'history', url: h.url, title: h.title }))

  const remote: Suggestion[] = (await remoteSuggestions(input, engine))
    .filter((s) => s.toLowerCase() !== lower)
    .slice(0, 4)
    .map((q) => ({ type: 'suggest', url: searchUrl(q, engine), title: q }))

  const seen = new Set<string>()
  const merged: Suggestion[] = []
  for (const s of [primary, ...bookmarks, ...history.slice(0, 4), ...remote, ...history.slice(4)]) {
    if (seen.has(s.url)) continue
    seen.add(s.url)
    merged.push(s)
  }
  return merged.slice(0, MAX_SUGGESTIONS)
}
