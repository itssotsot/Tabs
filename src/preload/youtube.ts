// YouTube video-ad blocking, installed from the tab preload.
//
// The general ad blocker applies YouTube's rules after the page loads, which is too
// late: the player has already read its ad schedule by then. Here we:
//   1. Run a script in the page's own JavaScript world *before* YouTube's scripts,
//      stripping ad instructions from every player response it receives.
//   2. As a fallback, skip any ad that still starts (mute, jump to its end, press Skip).
//   3. Hide ad slots on the page and YouTube's "ad blockers aren't allowed" dialog.
import { contextBridge } from 'electron'

/** Runs in the page's main world. Must be self-contained: it's serialized as a string. */
function stripAdsFromPlayerResponses(): void {
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams']

  const prune = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const obj = value as Record<string, unknown>
    for (const key of AD_KEYS) if (key in obj) delete obj[key]
    // Watch-page and SPA responses nest the player response in a few places.
    if (obj.playerResponse) prune(obj.playerResponse)
    if (Array.isArray(obj)) obj.forEach((item) => prune((item as Record<string, unknown>)?.playerResponse))
  }

  const hasAds = (value: unknown): boolean =>
    !!value &&
    typeof value === 'object' &&
    (AD_KEYS.some((k) => k in (value as object)) || 'playerResponse' in (value as object))

  // The watch page declares `var ytInitialPlayerResponse = {...}`; a setter catches it.
  let initial: unknown
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (v) => {
        prune(v)
        initial = v
      }
    })
  } catch {
    // Already defined; the JSON hooks below still cover navigation.
  }

  // Player responses fetched while browsing (the site is a single-page app).
  const parse = JSON.parse
  JSON.parse = function (this: unknown, ...args: Parameters<typeof JSON.parse>) {
    const result = parse.apply(this, args)
    try {
      if (hasAds(result)) prune(result)
    } catch {
      // Never break the page over this.
    }
    return result
  } as typeof JSON.parse

  const json = Response.prototype.json
  Response.prototype.json = async function (this: Response) {
    const result = await json.call(this)
    try {
      if (/\/youtubei\/v1\/(player|next|reel)/.test(this.url)) prune(result)
    } catch {
      // Ignore.
    }
    return result
  }
}

const AD_CSS = `
  #masthead-ad, #player-ads, #panels > ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
  ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
  ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer, ytd-compact-promoted-video-renderer,
  ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
  ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer), ytd-reel-video-renderer:has(ytd-ad-slot-renderer),
  .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-suggested-action-badge,
  tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model
  { display: none !important; }
`

const SKIP_SELECTORS = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button'

/** Fallback: if an ad starts anyway, get through it as fast as possible. */
function watchForAds(): void {
  let mutedByUs = false

  const handle = (): void => {
    const player = document.querySelector('#movie_player')
    const video = player?.querySelector('video')
    if (!player || !video) return

    if (player.classList.contains('ad-showing')) {
      if (!video.muted) {
        video.muted = true
        mutedByUs = true
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration
      }
      document.querySelectorAll<HTMLElement>(SKIP_SELECTORS).forEach((b) => b.click())
    } else if (mutedByUs) {
      video.muted = false
      mutedByUs = false
    }

    // If the "ad blockers aren't allowed" dialog paused the video, dismiss it and resume.
    const dialog = document.querySelector('ytd-enforcement-message-view-model')
    if (dialog) {
      dialog.closest('tp-yt-paper-dialog')?.remove()
      document.querySelector('tp-yt-iron-overlay-backdrop')?.remove()
      if (video.paused) void video.play().catch(() => {})
    }
  }

  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      handle()
    })
  }

  // Observe the document itself: at preload time <html> may not exist yet.
  new MutationObserver(schedule).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class']
  })
  document.addEventListener('loadedmetadata', schedule, true)
  document.addEventListener('timeupdate', schedule, true)
}

export function installYouTubeAdBlocking(): void {
  try {
    contextBridge.executeInMainWorld({ func: stripAdsFromPlayerResponses })
  } catch (err) {
    console.warn('[browserr] could not install YouTube ad filter', err)
  }

  const addStyle = (): void => {
    const style = document.createElement('style')
    style.textContent = AD_CSS
    ;(document.head ?? document.documentElement).appendChild(style)
  }
  if (document.documentElement) addStyle()
  else document.addEventListener('DOMContentLoaded', addStyle)

  watchForAds()
}
