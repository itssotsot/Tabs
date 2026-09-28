// What links mean: which ones are the same page, the link to send, and what a site's links say
// about the page (a video's thumbnail, where it starts). Anything works from the page's own tags;
// sites whose links say more get a file here, listed in SITES.
import { youtube } from './youtube'

/** One site's links. */
export interface LinkSite {
  /** The site's domains, subdomains included. */
  domains: readonly string[]
  /** One of the site's pages from its link, or null for links the site has nothing special about. */
  parse(url: URL): KnownLink | null
}

/** A page on a site in SITES, from its link alone. */
export interface KnownLink {
  /** Links with the same key are the same page. */
  key: string
  /** The link to send: the page's usual link, without playlist, tracking or start-time parts. */
  url: string
  /** For when nothing better is known yet, like "YouTube video". */
  fallbackTitle: string
  thumbnail: string | null
  /** The site's oEmbed request for this page, for its title without loading it. */
  oembed?: string
  /** For pages you can start partway into (videos): the link that starts at `sec`. */
  at?(sec: number): string
  /** Where the link starts, in seconds, if it says. */
  start: number | null
}

const SITES: readonly LinkSite[] = [youtube]

/** Query parameters that only say where a link came from. Links to sites in SITES drop all of theirs anyway. */
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok)$/i

export function onDomain(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

function webUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

export function knownLink(url: string): KnownLink | null {
  const u = webUrl(url)
  if (!u) return null
  return SITES.find((site) => onDomain(u.hostname, site.domains))?.parse(u) ?? null
}

/** `u` without tracking parameters. Leaves the query as it was when there are none, since rewriting it can change it. */
function withoutTracking(u: URL): URL {
  const params = new URLSearchParams(u.search)
  const tracking = [...params.keys()].filter((k) => TRACKING_PARAM.test(k))
  if (!tracking.length) return u
  for (const key of tracking) params.delete(key)
  const clean = new URL(u)
  clean.search = params.toString()
  return clean
}

/** The link to send for `url`: a site's usual link for the page, else `url` without tracking parameters. */
export function cleanUrl(url: string): string {
  const known = knownLink(url)
  if (known) return known.url
  const u = webUrl(url)
  return u ? withoutTracking(u).href : url
}

/** The link to send, starting at `startSec` when the page is one you can start partway into. */
export function shareUrl(url: string, startSec: number | null): string {
  const known = knownLink(url)
  if (!known) return url
  return startSec && known.at ? known.at(startSec) : known.url
}

/** Two URLs with the same key are the same page: ignores www, #fragments, trailing slashes, tracking parameters and start times. */
export function pageKey(url: string): string {
  const known = knownLink(url)
  if (known) return known.key
  const u = webUrl(url)
  if (!u) return url
  const { hostname, pathname, search } = withoutTracking(u)
  return `${hostname.replace(/^www\./, '').toLowerCase()}${pathname.replace(/\/+$/, '')}${search}`
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "(3) Some video - YouTube" -> "Some video": without the unread count some sites put first, or the site's name at the end. */
export function cleanTitle(title: string, siteNames: readonly string[]): string {
  let text = title.replace(/^\(\d+\+?\)\s*/, '').trim()
  for (const name of siteNames) {
    const suffix = new RegExp(`\\s+[-–—|·/]\\s+${escapeRegExp(name)}$`, 'i').exec(text)
    if (suffix && suffix.index > 0) {
      text = text.slice(0, suffix.index).trim()
      break
    }
  }
  return text || title.trim()
}
