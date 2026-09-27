import { BrowserWindow } from 'electron'
import { webSession } from '../../../env'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, ExtensionError, type CallContext } from '../../router'
import { lastFocusedWindow } from '../../tabs-model'
import { isNumber, isObject, isString } from './util'

/**
 * chrome.identity. There's no Chrome sign-in here, so the Google account methods answer like a
 * signed-out Chrome. launchWebAuthFlow works: it opens the provider's page in a window on the web
 * session (so existing sign-ins count) and finishes when the page redirects to
 * https://<extension-id>.chromiumapp.org/…, which is never actually loaded.
 */

const NOT_SIGNED_IN = 'The user is not signed in.'
const PAGE_LOAD_FAILED = 'Authorization page could not be loaded.'
const INTERACTION_REQUIRED = 'User interaction required.'
const USER_REJECTED = 'The user did not approve access.'
/** How long a non-interactive flow waits by default when it doesn't abort on load. */
const DEFAULT_NON_INTERACTIVE_TIMEOUT = 60_000
/** How long a page may take to load before an interactive flow gives up. */
const LOAD_TIMEOUT = 120_000

export function redirectUrl(extensionId: string, path?: unknown): string {
  const base = `https://${extensionId}.chromiumapp.org/`
  return isString(path) && path ? new URL(path.replace(/^\/+/, ''), base).href : base
}

/** Open auth windows, per extension, closed when it unloads. */
const flows = new Map<string, Set<BrowserWindow>>()

function launchWebAuthFlow(call: CallContext, details: unknown): Promise<string> {
  const d = isObject(details) ? details : {}
  if (!isString(d.url)) throw new ExtensionError('Invalid URL.')
  let start: URL
  try {
    start = new URL(d.url)
  } catch {
    throw new ExtensionError('Invalid URL.')
  }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new ExtensionError('Invalid URL.')
  const interactive = d.interactive === true
  const abortOnLoad = d.abortOnLoadForNonInteractive !== false
  const nonInteractiveTimeout = isNumber(d.timeoutMsForNonInteractive) ? Math.max(0, d.timeoutMsForNonInteractive) : DEFAULT_NON_INTERACTIVE_TIMEOUT
  const prefix = `https://${call.extensionId}.chromiumapp.org/`
  const isRedirect = (url: string): boolean => url.toLowerCase().startsWith(prefix)
  if (isRedirect(start.href)) return Promise.resolve(start.href)

  return new Promise<string>((resolve, reject) => {
    const parent = lastFocusedWindow()?.win
    const win = new BrowserWindow({
      width: 520,
      height: 680,
      show: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      title: 'Sign in',
      webPreferences: { session: webSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const wc = win.webContents
    let list = flows.get(call.extensionId)
    if (!list) flows.set(call.extensionId, (list = new Set()))
    list.add(win)
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (error: string | null, url?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      flows.get(call.extensionId)?.delete(win)
      if (error) reject(new ExtensionError(error))
      else resolve(url!)
      if (!win.isDestroyed()) win.destroy()
    }
    const setTimer = (ms: number, error: string): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finish(error), ms)
    }

    // Catch the redirect however it happens, before anything tries to load chromiumapp.org.
    const intercept = (event: { preventDefault(): void }, url: string): void => {
      if (!isRedirect(url)) return
      event.preventDefault()
      finish(null, url)
    }
    wc.on('will-redirect', (e) => intercept(e, e.url))
    wc.on('will-navigate', (e) => intercept(e, e.url))
    wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame) intercept(e, e.url)
    })
    wc.on('did-navigate', (_e, url) => {
      if (isRedirect(url)) finish(null, url)
    })
    // Pages that open the redirect in a popup (or target=_blank) count too; anything else stays here.
    wc.setWindowOpenHandler(({ url }) => {
      if (isRedirect(url)) finish(null, url)
      else void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      // -3 is ERR_ABORTED: our own preventDefault, or a page replacing its own navigation.
      if (!isMainFrame || code === -3 || isRedirect(url)) return
      finish(PAGE_LOAD_FAILED)
    })
    wc.on('did-finish-load', () => {
      if (settled) return
      if (interactive) {
        if (timer) clearTimeout(timer)
        timer = null
        if (!win.isVisible()) {
          win.show()
          win.focus()
        }
      } else if (abortOnLoad) {
        finish(INTERACTION_REQUIRED)
      }
    })
    win.on('closed', () => finish(USER_REJECTED))

    setTimer(interactive ? LOAD_TIMEOUT : nonInteractiveTimeout, interactive ? PAGE_LOAD_FAILED : INTERACTION_REQUIRED)
    void wc.loadURL(start.href).catch(() => {
      // did-fail-load (or the redirect) decides.
    })
  })
}

function getAuthToken(call: CallContext, details: unknown): never {
  void details
  const oauth2 = call.extension.manifest as { oauth2?: { client_id?: unknown } }
  if (!isString(oauth2.oauth2?.client_id) || !oauth2.oauth2.client_id) throw new ExtensionError('Invalid OAuth2 Client ID.')
  throw new ExtensionError(NOT_SIGNED_IN)
}

defineApi('identity', {
  permissions: ['identity'],
  methods: {
    getRedirectURL: (call, path) => redirectUrl(call.extensionId, path),
    launchWebAuthFlow,
    getAuthToken,
    getProfileUserInfo: () => ({ email: '', id: '' }),
    getAccounts: () => [],
    removeCachedAuthToken: () => undefined,
    clearAllCachedAuthTokens: () => undefined
  }
})

// Declared so listeners can be added; there's no sign-in to change.
defineEvent('identity.onSignInChanged', { permissions: ['identity'] })

lifecycle.on('unloaded', (extensionId) => {
  for (const win of flows.get(extensionId) ?? []) if (!win.isDestroyed()) win.destroy()
  flows.delete(extensionId)
})
