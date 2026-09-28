// What Tabs does differently on some sites' pages. Everything works on any site from what pages
// have in common (the filter lists, the page's own videos); a site gets a file here, listed in SITES,
// only for what that can't do.
import { onDomain } from '@shared/links'
import type { CallDevice, CallState } from '@shared/types'
import { meet } from './meet'
import { spotify } from './spotify'
import { youtube } from './youtube'

export interface PageSite {
  /** The site's domains, subdomains included. */
  domains: readonly string[]
  /**
   * Which of its videos and audio are the site's player (not, say, previews that play on hover), for the
   * tab list's controls. Without it, whatever plays with sound.
   */
  player?: string
  /** Moves the site's player to `time` its own way, for players that get stuck when their time is just set (Spotify's). */
  seek?(time: number): void
  /**
   * The site's calls, for the tab list's mic and camera buttons, when the site doesn't tell the browser itself
   * (Media Session's call actions, see call-controls.ts).
   */
  call?: {
    /** Whether the page's call is sending your mic and camera, or null when it's not in one. */
    read(): CallState | null
    /** Turns the mic or camera on or off, with the page's own button so the call shows it. */
    toggle(device: CallDevice): void
    /** The attributes whose changes can change what `read` says (besides elements coming and going). */
    attributes: string[]
  }
  /** Hidden while blocking ads, on top of the filter lists. */
  adStyles?: string
  /** Runs on the site's pages while blocking ads, for what the filter lists can't do. */
  blockAds?(): void
}

const SITES: readonly PageSite[] = [meet, spotify, youtube]

export function pageSite(hostname: string): PageSite | undefined {
  return SITES.find((site) => onDomain(hostname, site.domains))
}
