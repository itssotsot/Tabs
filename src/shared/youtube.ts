export interface YouTubeRef {
  id: string
  kind: 'video' | 'short'
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/

export function parseYouTube(url: string): YouTubeRef | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '')
  let id: string | null = null
  let kind: YouTubeRef['kind'] = 'video'

  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0]
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = u.pathname.split('/')
    if (first === 'watch') id = u.searchParams.get('v')
    else if (first === 'shorts') {
      id = second
      kind = 'short'
    } else if (first === 'embed' || first === 'live' || first === 'v') id = second
  }
  return id && ID_RE.test(id) ? { id, kind } : null
}

export function youTubeUrl(ref: YouTubeRef, timestampSec?: number | null): string {
  if (ref.kind === 'short') return `https://www.youtube.com/shorts/${ref.id}`
  const t = timestampSec && timestampSec > 0 ? `&t=${Math.floor(timestampSec)}s` : ''
  return `https://www.youtube.com/watch?v=${ref.id}${t}`
}

export function youTubeThumbnail(ref: YouTubeRef): string {
  return `https://i.ytimg.com/vi/${ref.id}/mqdefault.jpg`
}

/** "(3) Some video - YouTube" -> "Some video" */
export function cleanYouTubeTitle(title: string): string {
  return title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim()
}

export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Builds the URL that actually gets sent, optionally starting at the timestamp. */
export function shareUrl(url: string, timestampSec: number | null, includeTimestamp: boolean): string {
  const ref = parseYouTube(url)
  if (!ref) return url
  return youTubeUrl(ref, includeTimestamp ? timestampSec : null)
}

/** The start time in a YouTube link (`t=90`, `t=90s`, `t=1m30s`, `start=90`), in seconds. */
export function youTubeStart(url: string): number | null {
  let value: string | null
  try {
    const u = new URL(url)
    value = u.searchParams.get('t') ?? u.searchParams.get('start')
  } catch {
    return null
  }
  if (!value) return null
  if (/^\d+s?$/.test(value)) return parseInt(value, 10) || null
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!m || !m[0]) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || null
}
