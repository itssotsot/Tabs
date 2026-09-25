import type { ShareDraft } from '@shared/types'
import { cleanYouTubeTitle, parseYouTube, youTubeThumbnail, youTubeUrl } from '@shared/youtube'
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
