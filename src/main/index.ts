import { app, BrowserWindow, components, type WebContents } from 'electron'
import { setAdblockEnabled } from './adblock'
import { broadcast } from './broadcast'
import { setupDownloads } from './downloads'
import { profile, registerInternalProtocol, registerSchemes, webSession } from './env'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { startMemorySaver } from './memory'
import { setupPermissions } from './permissions'
import { setupPredictor } from './predictor'
import { store } from './store'
import { BrowserWindowController, controllerFor, focusedController, freezeSession } from './window'
import { IPC } from '@shared/api'
import { join } from 'node:path'

if (profile) app.setPath('userData', join(app.getPath('appData'), `${app.getName()} (${profile})`))

registerSchemes()

// Lets tooling drive the app over the DevTools protocol during development.
if (!app.isPackaged && process.env.BROWSERR_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.BROWSERR_DEBUG_PORT)
}

// If the terminal that launched us goes away, logging must not crash the app (EIO/EPIPE).
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})

// The ad blocker injects scriptlets without awaiting them; a page that rejects one isn't an app error.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message.startsWith('Script failed to execute')) return
  console.error('Unhandled rejection:', reason)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

/** A plain Chrome user agent. Google sign-in and some sites reject anything mentioning Electron. */
function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0]
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function urlsFromArgv(argv: string[]): string[] {
  return argv.filter((a) => /^https?:\/\//i.test(a))
}

// Links opened from other apps (when Browserr is the default browser).
const pendingUrls: string[] = urlsFromArgv(process.argv)
let ready = false

function openExternalUrl(url: string): void {
  if (!ready) {
    pendingUrls.push(url)
    return
  }
  const c = focusedController()
  if (c) {
    c.createTab(url)
    c.focus()
  } else {
    new BrowserWindowController({ urls: [url] })
  }
}

app.on('open-url', (e, url) => {
  e.preventDefault()
  openExternalUrl(url)
})

app.on('second-instance', (_e, argv) => {
  const urls = urlsFromArgv(argv)
  if (urls.length) urls.forEach(openExternalUrl)
  else if (ready) (focusedController() ?? new BrowserWindowController()).focus()
})

function windowFor(wc: WebContents): BrowserWindow | null {
  return controllerFor(wc)?.win ?? BrowserWindow.fromWebContents(wc)
}

function openInitialWindows(): void {
  const saved = store.settings.restoreSession ? store.savedWindows.filter((w) => w.tabs.length) : []
  const urls = pendingUrls.splice(0)
  if (saved.length) {
    saved.forEach((w) => new BrowserWindowController({ restore: w }))
    const c = focusedController()
    urls.forEach((url) => c?.createTab(url))
  } else {
    new BrowserWindowController({ urls })
  }
}

/**
 * Widevine (DRM for Netflix, Spotify, Disney+ and so on) comes from castLabs' Electron
 * build and is downloaded by the component updater on first launch. Give it a moment
 * so DRM sites work immediately, but never hold up the window for long.
 */
async function waitForWidevine(): Promise<void> {
  const ready = components.whenReady().catch((err) => console.error('[widevine] unavailable', err))
  await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1500))])
}

app.whenReady().then(async () => {
  await waitForWidevine()
  store.init()

  const userAgent = chromeUserAgent()
  app.userAgentFallback = userAgent
  const ses = webSession()
  ses.setUserAgent(userAgent)

  registerInternalProtocol()
  setupPermissions(ses, windowFor)
  setupDownloads(ses, (list) => broadcast(IPC.downloadsChanged, list))
  void setAdblockEnabled(ses, store.settings.adblock)
  setupPredictor(ses)
  startMemorySaver()

  registerIpc()
  buildAppMenu()

  ready = true
  openInitialWindows()

  app.on('activate', () => {
    if (!BrowserWindowController.all.size) new BrowserWindowController()
  })
})

app.on('before-quit', () => {
  freezeSession()
  store.flushAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
