import { app, net, protocol, session, type Session } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INTERNAL_SCHEME } from '@shared/url'

export const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
export const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? ''

export const rendererDir = join(__dirname, '../renderer')
export const chromePreload = join(__dirname, '../preload/chrome.js')
export const tabPreload = join(__dirname, '../preload/tab.js')

/** Host under browserr:// that serves the browser's own UI. Never reachable from tabs. */
const APP_HOST = 'app'
/** Hosts under browserr:// that tabs may load. */
export const INTERNAL_PAGES = ['newtab', 'history', 'bookmarks', 'settings', 'error'] as const

/** URL of a UI page (index.html / overlay.html) for the chrome and overlay views. */
export function uiUrl(page: 'index' | 'overlay'): string {
  return isDev ? `${devServerUrl}/${page}.html` : `${INTERNAL_SCHEME}://${APP_HOST}/${page}.html`
}

export const WEB_PARTITION = 'persist:web'

/** Session used by every web page. The browser UI stays on the default session. */
export function webSession(): Session {
  return session.fromPartition(WEB_PARTITION)
}

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INTERNAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

async function serveRendererFile(pathname: string, search: string): Promise<Response> {
  if (isDev) return net.fetch(`${devServerUrl}${pathname}${search}`)
  const file = normalize(join(rendererDir, pathname))
  if (!file.startsWith(rendererDir + sep)) return new Response('Not found', { status: 404 })
  return net.fetch(pathToFileURL(file).toString())
}

/**
 * browserr://app/...      -> browser UI (default session only)
 * browserr://newtab/ etc. -> internal pages rendered by internal.html (web session)
 */
export function registerInternalProtocol(): void {
  session.defaultSession.protocol.handle(INTERNAL_SCHEME, (req) => {
    const url = new URL(req.url)
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
    return serveRendererFile(url.pathname, url.search)
  })

  webSession().protocol.handle(INTERNAL_SCHEME, (req) => {
    const url = new URL(req.url)
    if (!(INTERNAL_PAGES as readonly string[]).includes(url.host)) {
      return new Response('Not found', { status: 404 })
    }
    // Every internal page shares one HTML entry; its scripts and assets are fetched relative to it.
    const pathname = url.pathname === '/' ? '/internal.html' : url.pathname
    return serveRendererFile(pathname, url.pathname === '/' ? '' : url.search)
  })
}
