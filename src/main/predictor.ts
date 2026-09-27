// A small version of Chrome's loading predictor.
//
// We learn which other servers each site's pages load from (CDNs, APIs, video hosts),
// then open connections to them as soon as you start going to that site, or even
// while you're still choosing it in the address bar. The DNS + TCP + TLS handshakes
// then happen in parallel instead of one by one as the page discovers them.
import type { Session } from 'electron'
import { extensionHooks } from './extension-hooks'
import { store } from './store'

const MAX_HOSTS = 500
const MAX_ORIGINS_PER_HOST = 12
/** Origins preconnected per navigation. */
const PRECONNECT_ORIGINS = 6
const MAX_SCORE = 40
/** Don't re-preconnect the same origin more often than this. */
const PRECONNECT_COOLDOWN_MS = 10_000

const recentlyPreconnected = new Map<string, number>()
let saveTimer: NodeJS.Timeout | null = null

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null
  } catch {
    return null
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

function preconnect(ses: Session, origin: string, numSockets = 1): void {
  const now = Date.now()
  if ((recentlyPreconnected.get(origin) ?? 0) > now - PRECONNECT_COOLDOWN_MS) return
  recentlyPreconnected.set(origin, now)
  if (recentlyPreconnected.size > 1000) recentlyPreconnected.clear()
  ses.preconnect({ url: origin, numSockets })
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    store.savePredictor()
  }, 30_000)
}

function learn(pageUrl: string, requestUrl: string): void {
  const host = hostOf(pageUrl)
  const origin = originOf(requestUrl)
  if (!host || !origin || originOf(pageUrl) === origin) return

  const hosts = store.predictor
  const entry = (hosts[host] ??= { seen: 0, origins: {} })
  entry.seen = Date.now()
  entry.origins[origin] = Math.min(MAX_SCORE, (entry.origins[origin] ?? 0) + 1)

  const origins = Object.entries(entry.origins)
  if (origins.length > MAX_ORIGINS_PER_HOST) {
    entry.origins = Object.fromEntries(origins.sort((a, b) => b[1] - a[1]).slice(0, MAX_ORIGINS_PER_HOST))
  }

  const keys = Object.keys(hosts)
  if (keys.length > MAX_HOSTS) {
    keys
      .sort((a, b) => hosts[a].seen - hosts[b].seen)
      .slice(0, keys.length - MAX_HOSTS)
      .forEach((k) => delete hosts[k])
  }
  scheduleSave()
}

export function setupPredictor(ses: Session): void {
  // Only onCompleted: the ad blocker owns onBeforeRequest/onHeadersReceived, identity.ts owns
  // onBeforeSendHeaders, and Electron allows one listener per event.
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    if (details.resourceType === 'mainFrame' || details.fromCache || details.statusCode >= 400) return
    const wc = details.webContents
    if (!wc || wc.isDestroyed()) return
    learn(wc.getURL(), details.url)
  })
}

/** Connect to a site and the servers its pages usually need. */
/** An extension turned off network prediction (chrome.privacy.network.networkPredictionEnabled). */
const predictionOff = (): boolean => extensionHooks.privacySetting('network.networkPredictionEnabled') === false

export function warmUp(ses: Session, url: string, numSockets = 1): void {
  if (predictionOff()) return
  const origin = originOf(url)
  const host = hostOf(url)
  if (!origin || !host) return
  preconnect(ses, origin, numSockets)
  const learned = store.predictor[host]?.origins
  if (!learned) return
  Object.entries(learned)
    .sort((a, b) => b[1] - a[1])
    .slice(0, PRECONNECT_ORIGINS)
    .forEach(([o]) => preconnect(ses, o))
}

/** A page started loading: open its usual connections right away. */
export function onNavigationStart(ses: Session, url: string): void {
  if (predictionOff()) return
  warmUp(ses, url)
}
