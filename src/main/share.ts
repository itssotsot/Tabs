import type { ShareDraft } from '@shared/types'
import { cleanTitle, cleanUrl, knownLink } from '@shared/links'
import { webSession } from './env'
import { siteName, siteOf } from './sites'
import type { Tab } from './tab'

interface PageMeta {
  title: string
  image: string | null
}

// Runs in an isolated world so the page can't tamper with it.
const READ_META = `(() => {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null
  const image = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')
  return {
    title: meta('meta[property="og:title"]') || document.title,
    image: image ? new URL(image, location.href).href : null
  }
})()`

const ISOLATED_WORLD_ID = 1001

async function readMeta(tab: Tab): Promise<PageMeta | null> {
  // A sleeping tab has no page to read; don't wake it just for this.
  if (!tab.loaded) return null
  try {
    return (await tab.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: READ_META }])) as PageMeta
  } catch {
    return null
  }
}

/** The page's title without an unread count or the site's name ("(3) Some video - YouTube" -> "Some video"). */
function titleOf(title: string, url: string): string {
  const site = siteOf(url)
  return cleanTitle(title, site ? [siteName(site)] : [])
}

export async function draftFromTab(tab: Tab): Promise<ShareDraft | null> {
  const url = tab.url
  if (!/^https?:/.test(url)) return null
  const known = knownLink(url)
  const meta = await readMeta(tab)
  return {
    url: known?.url ?? cleanUrl(url),
    // og:title goes stale while single-page sites (YouTube) move between pages, so prefer the tab title.
    title: titleOf(tab.title || meta?.title || known?.fallbackTitle || url, url),
    thumbnail: known?.thumbnail ?? meta?.image ?? null,
    timestampSec: known?.at ? tab.mediaPosition : null
  }
}

export function draftFromLink(url: string, text: string): ShareDraft | null {
  if (!/^https?:/.test(url)) return null
  const known = knownLink(url)
  return {
    url: known?.url ?? cleanUrl(url),
    title: text.trim() || url,
    thumbnail: known?.thumbnail ?? null,
    timestampSec: null
  }
}

// ---- links typed into a chat ----

const FETCH_TIMEOUT_MS = 6000
/** The <head> is all we need; stop reading after this much. */
const MAX_HTML_BYTES = 512 * 1024

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** og:/twitter: tags and the <title>, read from the start of an HTML page. */
function metaFromHtml(html: string, baseUrl: string): PageMeta {
  const tags = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {}
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
    }
    const name = (attrs.property ?? attrs.name ?? '').toLowerCase()
    if (name && attrs.content && !tags.has(name)) tags.set(name, decodeEntities(attrs.content).trim())
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const image = tags.get('og:image') ?? tags.get('og:image:url') ?? tags.get('twitter:image') ?? tags.get('twitter:image:src')
  let imageUrl: string | null = null
  if (image) {
    try {
      imageUrl = new URL(image, baseUrl).href
    } catch {
      imageUrl = null
    }
  }
  return {
    title: tags.get('og:title') ?? tags.get('twitter:title') ?? (titleTag ? decodeEntities(titleTag).replace(/\s+/g, ' ').trim() : ''),
    image: imageUrl && /^https?:/.test(imageUrl) ? imageUrl : null
  }
}

async function readHead(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // The browser's own session, so sites that need you signed in (or past a cookie wall) show real titles.
    const res = await webSession().fetch(url, { signal: controller.signal, headers: { accept: 'text/html,application/xhtml+xml' } })
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '') || !res.body) return null
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let bytes = 0
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      html += decoder.decode(value, { stream: true })
      if (/<\/head>/i.test(html)) break
    }
    void reader.cancel().catch(() => {})
    return { html, finalUrl: res.url || url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** A page's title and thumbnail from its site's oEmbed request, which (unlike the page) needs no signing in or cookie wall. */
async function readOEmbed(request: string): Promise<{ title: string | null; thumbnail: string | null } | null> {
  try {
    const res = await webSession().fetch(request, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json()) as { title?: unknown; thumbnail_url?: unknown }
    return {
      title: typeof data.title === 'string' && data.title.trim() ? data.title : null,
      thumbnail: typeof data.thumbnail_url === 'string' && /^https:/.test(data.thumbnail_url) ? data.thumbnail_url : null
    }
  } catch {
    return null
  }
}

/**
 * Title and thumbnail for a link typed into a chat, the same things the send picker attaches.
 * Reads them from an open tab showing the page when there is one, otherwise from the site's oEmbed or the page itself.
 * Keeps the URL as typed (including a video's start time).
 */
export async function draftFromUrl(url: string, openTab?: Tab): Promise<ShareDraft | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const known = knownLink(url)
  const start = known?.at ? known.start : null

  if (openTab) {
    const fromTab = await draftFromTab(openTab)
    if (fromTab) return { ...fromTab, url, timestampSec: start }
  }

  const fallback = known ? { url, title: known.fallbackTitle, thumbnail: known.thumbnail, timestampSec: start } : null
  if (known?.oembed) {
    const embed = await readOEmbed(known.oembed)
    if (!embed) return fallback
    return { url, title: titleOf(embed.title ?? known.fallbackTitle, url), thumbnail: known.thumbnail ?? embed.thumbnail, timestampSec: start }
  }

  const page = await readHead(url)
  const meta = page && metaFromHtml(page.html, page.finalUrl)
  if (!meta || (!meta.title && !meta.image)) return fallback
  return { url, title: meta.title ? titleOf(meta.title, url) : (known?.fallbackTitle ?? url), thumbnail: known?.thumbnail ?? meta.image, timestampSec: start }
}
