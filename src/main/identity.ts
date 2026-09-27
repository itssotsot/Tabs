import { app, type Session, type WebContents } from 'electron'
import { addBlockingHandler } from './web-request-hub'

/**
 * Google sign-in (and some other sites) refuse "embedded" browsers. Hiding "Electron" in the
 * user agent isn't enough: Chromium's client hints (Sec-CH-UA headers, navigator.userAgentData)
 * list only "Chromium", and Electron sends no client hints on navigations, which no real Chrome
 * does. So pages get a consistent Google Chrome identity.
 *
 * Google's sign-in page sees through even that (it fingerprints more than the user agent), but
 * it accepts Firefox. There, and only there, pages present as Firefox: Firefox user agent and no
 * client hints, in the request headers and in JavaScript alike.
 */

type Identity = 'chrome' | 'firefox'

const CHROME_VERSION = process.versions.chrome
const CHROME_MAJOR = CHROME_VERSION.split('.')[0]

/** Chromium's placeholder brand for this version; real Chrome sends one too. */
const GREASE_BRAND = { brand: 'Not?A_Brand', version: '24' }

const PLATFORM =
  process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'

/** Hosts that get the Firefox identity. */
const FIREFOX_HOSTS = new Set(['accounts.google.com'])

/** A plain Chrome user agent. */
export function chromeUserAgent(): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`
}

/** A current Firefox user agent. Firefox ships every four weeks; 143 came out on 2025-09-16. */
function firefoxUserAgent(): string {
  const version = 143 + Math.max(0, Math.floor((Date.now() - Date.UTC(2025, 8, 16)) / (28 * 86_400_000)))
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
}

function brands(fullVersion: boolean): { brand: string; version: string }[] {
  const version = fullVersion ? CHROME_VERSION : CHROME_MAJOR
  return [
    { brand: GREASE_BRAND.brand, version: fullVersion ? `${GREASE_BRAND.version}.0.0.0` : GREASE_BRAND.version },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version }
  ]
}

/** Everything navigator.userAgentData and the Sec-CH-UA-* headers report. */
function userAgentMetadata(): Record<string, unknown> {
  return {
    brands: brands(false),
    fullVersionList: brands(true),
    platform: PLATFORM,
    // Chrome on Windows reports a Windows API contract version we can't read; 10.0.0 is a valid one.
    platformVersion: process.platform === 'win32' ? '10.0.0' : process.getSystemVersion(),
    architecture: process.arch.startsWith('arm') ? 'arm' : 'x86',
    bitness: process.arch.endsWith('64') ? '64' : '32',
    model: '',
    mobile: false,
    wow64: false
  }
}

/** The low-entropy client hints Chrome sends with every request to a secure origin. */
const NAVIGATION_HINTS: Record<string, string> = {
  'sec-ch-ua': brands(false)
    .map((b) => `"${b.brand}";v="${b.version}"`)
    .join(', '),
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': `"${PLATFORM}"`
}

function identityFor(url: string): Identity {
  try {
    return FIREFOX_HOSTS.has(new URL(url).hostname) ? 'firefox' : 'chrome'
  } catch {
    return 'chrome'
  }
}

const applied = new WeakMap<WebContents, Identity>()
/** DevTools sessions of each page's out-of-process frames and workers. */
const childSessions = new WeakMap<WebContents, Set<string>>()

// Without userAgentMetadata Chromium reports no client hints at all, like Firefox.
function overrideFor(identity: Identity): Record<string, unknown> {
  return identity === 'firefox'
    ? { userAgent: firefoxUserAgent() }
    : { userAgent: chromeUserAgent(), userAgentMetadata: userAgentMetadata() }
}

/**
 * Frames from other sites (like Google's accounts.youtube.com check inside the sign-in page) run
 * in their own process, which the page's override doesn't reach. Auto-attach pauses each one
 * before its first script so it gets the page's identity too.
 */
function autoAttach(wc: WebContents, sessionId?: string): Promise<unknown> {
  return wc.debugger
    .sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
    .catch(() => {})
}

async function prepareChild(wc: WebContents, sessionId: string, waiting: boolean): Promise<void> {
  try {
    await Promise.all([
      wc.debugger.sendCommand('Network.setUserAgentOverride', overrideFor(applied.get(wc) ?? 'chrome'), sessionId),
      autoAttach(wc, sessionId)
    ])
  } catch {
    // The frame went away, or it's a target without a network stack.
  } finally {
    // Never leave a frame paused, whatever happened above.
    if (waiting) wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
  }
}

/** Tracks a page's child frames and workers; once per WebContents. */
function watchChildren(wc: WebContents): void {
  const sessions = new Set<string>()
  childSessions.set(wc, sessions)
  wc.debugger.on('message', (_e, method, params, parentSession) => {
    if (method === 'Target.attachedToTarget') {
      sessions.add(params.sessionId)
      void prepareChild(wc, params.sessionId, params.waitingForDebugger)
    } else if (method === 'Target.detachedFromTarget') {
      sessions.delete(params.sessionId ?? parentSession)
    }
  })
  wc.debugger.on('detach', () => {
    applied.delete(wc)
    sessions.clear()
  })
}

/**
 * Gives a page, and every frame and worker in it, the identity its URL calls for. Goes through the
 * DevTools protocol, the only way to change the brand list, so the debugger stays attached for the
 * page's lifetime (detaching drops the override).
 */
export function applyIdentity(wc: WebContents, url = wc.getURL()): void {
  if (wc.isDestroyed()) return
  const identity = identityFor(url)
  if (wc.debugger.isAttached() && applied.get(wc) === identity) return
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach('1.3')
    } catch {
      return
    }
    void autoAttach(wc)
  }
  applied.set(wc, identity)
  const override = overrideFor(identity)
  // Forget the identity if it didn't take, so the next navigation tries again.
  const failed = (): void => void (applied.get(wc) === identity && applied.delete(wc))
  wc.debugger.sendCommand('Emulation.setUserAgentOverride', override).catch(failed)
  for (const sessionId of childSessions.get(wc) ?? []) {
    wc.debugger.sendCommand('Network.setUserAgentOverride', override, sessionId).catch(() => {})
  }
}

/** Applies the identity again even if it looks current, e.g. after an extension's debugger session overrode it. */
export function reapplyIdentity(wc: WebContents): void {
  applied.delete(wc)
  applyIdentity(wc)
}

/** Makes every page in the session (tabs and popups) present as Google Chrome, or Firefox where needed. */
export function setupBrowserIdentity(ses: Session): void {
  const userAgent = chromeUserAgent()
  // Covers service workers and anything else the per-page override doesn't reach.
  app.userAgentFallback = userAgent
  ses.setUserAgent(userAgent)

  // Fires before the page's first request, so even a popup's first navigation is covered.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== ses) return
    watchChildren(wc)
    applyIdentity(wc, '')
    // Switches before the new document runs any script. Request headers are handled below.
    const follow = (details: { url: string; isMainFrame: boolean }): void => {
      if (details.isMainFrame) applyIdentity(wc, details.url)
    }
    wc.on('did-start-navigation', follow)
    wc.on('did-redirect-navigation', follow)
  })

  addBlockingHandler(ses, 'onBeforeSendHeaders', {
    id: 'identity',
    urls: ['https://*/*'],
    handle: (details) => {
      const { requestHeaders, webContents } = details
      const names = Object.keys(requestHeaders)
      // A navigation takes the identity of where it's going; everything else, that of its page.
      const identity =
        details.resourceType === 'mainFrame' || !webContents
          ? identityFor(details.url)
          : (applied.get(webContents) ?? 'chrome')
      if (identity === 'firefox') {
        for (const name of names) {
          if (/^sec-ch-ua/i.test(name)) delete requestHeaders[name]
          else if (name.toLowerCase() === 'user-agent') requestHeaders[name] = firefoxUserAgent()
        }
      } else {
        // Leaving Google, a navigation can start before the page's override switches back.
        for (const name of names) if (name.toLowerCase() === 'user-agent') requestHeaders[name] = chromeUserAgent()
        const isFrame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
        if (isFrame && !names.some((name) => name.toLowerCase() === 'sec-ch-ua')) Object.assign(requestHeaders, NAVIGATION_HINTS)
      }
      return { requestHeaders }
    }
  })
}
