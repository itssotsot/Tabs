import type { ShareDraft } from '@shared/types'
import { cleanYouTubeTitle, parseYouTube, youTubeStart, youTubeThumbnail, youTubeUrl } from '@shared/youtube'
import { webSession } from './env'
import type { Tab } from './tab'

interface PageMeta {
  title: string
  image: string | null
  time: number | null
}

// Runs in an isolated world so the page can't tamper with it.
const READ_META = `(() => {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null
  const image = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')
  const video = document.querySelector('#movie_player video, video')
  const time = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null
  return {
    title: meta('meta[property="og:title"]') || document.title,
    image: image ? new URL(image, location.href).href : null,
    time
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

export async function draftFromTab(tab: Tab): Promise<ShareDraft | null> {
  const url = tab.url
  if (!/^https?:/.test(url)) return null

  const youtube = parseYouTube(url)
  if (youtube) {
    const meta = await readMeta(tab)
    return {
      url: youTubeUrl(youtube),
      // og:title goes stale while YouTube navigates between videos, so prefer the tab title.
      title: cleanYouTubeTitle(tab.title || meta?.title || 'YouTube video'),
      thumbnail: youTubeThumbnail(youtube),
      timestampSec: youtube.kind === 'video' ? (meta?.time ?? null) : null
    }
  }

  const meta = await readMeta(tab)
  return {
    url,
    title: tab.title || meta?.title || url,
    thumbnail: meta?.image ?? null,
    timestampSec: null
  }
}

export function draftFromLink(url: string, text: string): ShareDraft | null {
  if (!/^https?:/.test(url)) return null
  const youtube = parseYouTube(url)
  return {
    url: youtube ? youTubeUrl(youtube) : url,
    title: text.trim() || url,
    thumbnail: youtube ? youTubeThumbnail(youtube) : null,
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
    image: imageUrl && /^https?:/.test(imageUrl) ? imageUrl : null,
    time: null
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

async function youTubeTitle(url: string): Promise<string | null> {
  try {
    const res = await webSession().fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { title?: unknown }
    return typeof data.title === 'string' ? data.title : null
  } catch {
    return null
  }
}

/**
 * Title and thumbnail for a link typed into a chat, the same things the send picker attaches.
 * Reads them from an open tab showing the page when there is one, otherwise from the page itself.
 * Keeps the URL as typed (including a YouTube start time).
 */
export async function draftFromUrl(url: string, openTab?: Tab): Promise<ShareDraft | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const youtube = parseYouTube(url)
  const start = youtube?.kind === 'video' ? youTubeStart(url) : null

  if (openTab) {
    const fromTab = await draftFromTab(openTab)
    if (fromTab) return { ...fromTab, url, timestampSec: start }
  }

  if (youtube) {
    const title = await youTubeTitle(youTubeUrl(youtube))
    return { url, title: title ? cleanYouTubeTitle(title) : 'YouTube video', thumbnail: youTubeThumbnail(youtube), timestampSec: start }
  }

  const page = await readHead(url)
  if (!page) return null
  const meta = metaFromHtml(page.html, page.finalUrl)
  if (!meta.title && !meta.image) return null
  return { url, title: meta.title || url, thumbnail: meta.image, timestampSec: null }
}
