// The filter lists take YouTube's ads out of what its player loads (see src/preload/adblock.ts). This is
// for what gets through anyway: ad slots they don't hide yet, an ad that starts playing, and the
// "ad blockers aren't allowed" dialog.
import { oncePerFrame } from '../frame'
import type { PageSite } from './index'

const AD_STYLES = `
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

/** If an ad starts anyway, get through it as fast as possible: muted, jumped to its end, skipped. */
function skipAds(): void {
  let mutedByUs = false

  const check = oncePerFrame(() => {
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
  })

  // Observe the document itself: at preload time <html> may not exist yet.
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
  document.addEventListener('loadedmetadata', check, true)
  document.addEventListener('timeupdate', check, true)
}

export const youtube: PageSite = {
  domains: ['youtube.com'],
  player: '#movie_player video, #shorts-player video',
  adStyles: AD_STYLES,
  blockAds: skipAds
}
