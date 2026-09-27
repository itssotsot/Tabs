/** A color a site's tab group can be given, by name for the menu. */
export interface GroupColor {
  name: string
  hex: string
}

export const GROUP_COLORS: GroupColor[] = [
  { name: 'Red', hex: '#ef4444' },
  { name: 'Crimson', hex: '#b91c1c' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Salmon', hex: '#fa8072' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Blush', hex: '#f9a8d4' },
  { name: 'Fuchsia', hex: '#d946ef' },
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Lavender', hex: '#c4b5fd' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Navy', hex: '#1e40af' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Baby Blue', hex: '#93c5fd' },
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Mint', hex: '#6ee7b7' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Forest', hex: '#15803d' },
  { name: 'Lime', hex: '#84cc16' },
  { name: 'Butter', hex: '#fde047' },
  { name: 'Yellow', hex: '#eab308' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Peach', hex: '#fdba74' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Rust', hex: '#c2410c' },
  { name: 'Brown', hex: '#92400e' },
  { name: 'Tan', hex: '#b08968' },
  { name: 'Slate', hex: '#64748b' },
  { name: 'Stone', hex: '#a8a29e' },
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#ffffff' }
]

/**
 * What groups and letter avatars get when nobody picked a color. Kept to the original eight so existing
 * colors don't change and white letters stay readable on them.
 */
const AUTO_COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#eab308', '#ef4444']

/** The same color for the same seed, every time. */
export function colorFor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return AUTO_COLORS[Math.abs(hash) % AUTO_COLORS.length]
}

/** Popular sites' own colors, by registrable domain, until the user picks another. */
const SITE_COLORS: Record<string, string> = {
  'youtube.com': '#ff0000',
  'x.com': '#000000',
  'twitter.com': '#000000',
  'threads.net': '#000000',
  'facebook.com': '#0866ff',
  'instagram.com': '#e1306c',
  'whatsapp.com': '#25d366',
  'reddit.com': '#ff4500',
  'linkedin.com': '#0a66c2',
  'tiktok.com': '#fe2c55',
  'pinterest.com': '#e60023',
  'discord.com': '#5865f2',
  'twitch.tv': '#9146ff',
  // Streaming
  'netflix.com': '#e50914',
  'disneyplus.com': '#113ccf',
  'primevideo.com': '#00a8e1',
  'max.com': '#002be7',
  'hbomax.com': '#002be7',
  'hulu.com': '#1ce783',
  'paramountplus.com': '#0064ff',
  'peacocktv.com': '#000000',
  'crunchyroll.com': '#f47521',
  'plex.tv': '#e5a00d',
  'vimeo.com': '#1ab7ea',
  'dazn.com': '#f8fc00',
  'mubi.com': '#000000',
  'spotify.com': '#1db954',
  'soundcloud.com': '#ff5500',
  'deezer.com': '#a238ff',
  'tidal.com': '#000000',
  'pandora.com': '#224099',
  'amazon.com': '#ff9900',
  'google.com': '#4285f4',
  'github.com': '#181717',
  'stackoverflow.com': '#f48024',
  'wikipedia.org': '#ffffff',
  'notion.so': '#000000',
  'slack.com': '#4a154b',
  'chatgpt.com': '#10a37f',
  'claude.ai': '#d97757',
  'airbnb.com': '#ff5a5f',
  'paypal.com': '#003087'
}

/** A site group's color when the user hasn't picked one: the site's own, else one from its name. */
export function defaultSiteColor(site: string): string {
  return SITE_COLORS[site] ?? colorFor(site)
}
