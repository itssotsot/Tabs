// Spotify plays through a video element it never adds to the page, which the tab list finds all the same
// (see media-controls.ts). But its player only loads the part of a song it asked for, so setting that element's
// time leaves it stuck. Seeking goes through Spotify's own progress bar instead.
import type { PageSite } from './index'

function seek(time: number): void {
  const bar = document.querySelector<HTMLInputElement>('[data-testid="playback-progressbar"] input[type="range"]')
  if (!bar) return
  // The bar counts milliseconds, in steps of 5 seconds. Setting it the way dragging it does makes Spotify seek.
  bar.value = String(Math.round(time * 1000))
  bar.dispatchEvent(new Event('input', { bubbles: true }))
  bar.dispatchEvent(new Event('change', { bubbles: true }))
}

export const spotify: PageSite = {
  domains: ['open.spotify.com'],
  seek
}
