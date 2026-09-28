import { secondsParam } from '../media'
import type { LinkSite } from './index'

const ID_RE = /^[A-Za-z0-9_-]{11}$/

/** The video a YouTube link is for: youtu.be/…, watch?v=…, /shorts/, /embed/, /live/ and /v/ links. */
function videoOf(u: URL): { id: string; short: boolean } | null {
  let id: string | null = null
  let short = false
  if (u.hostname === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0]
  } else {
    const [, first, second] = u.pathname.split('/')
    if (first === 'watch') id = u.searchParams.get('v')
    else if (first === 'shorts') {
      id = second
      short = true
    } else if (first === 'embed' || first === 'live' || first === 'v') id = second
  }
  return id && ID_RE.test(id) ? { id, short } : null
}

export const youtube: LinkSite = {
  domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  parse(u) {
    const video = videoOf(u)
    if (!video) return null
    const { id, short } = video
    const url = short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`
    return {
      key: `yt:${id}`,
      url,
      fallbackTitle: 'YouTube video',
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      oembed: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      // Shorts always play from the start.
      at: short ? undefined : (sec) => `${url}&t=${Math.floor(sec)}s`,
      start: short ? null : secondsParam(u.searchParams.get('t') ?? u.searchParams.get('start'))
    }
  }
}
