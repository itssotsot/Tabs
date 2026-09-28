// Ad blocking in the page, when it's on: the filter lists' scriptlets before the page's own scripts,
// their element hiding (src/preload/cosmetics.ts), and the site's own rules (src/preload/sites).
import { ipcRenderer, webFrame } from 'electron'
import { IPC, type PageAdblock } from '@shared/api'
import { installCosmeticFiltering } from './cosmetics'
import type { PageSite } from './sites'

export function installAdBlocking(site: PageSite | undefined): void {
  // Synchronous on purpose: scriptlets have to be in place before the page's scripts run.
  const adblock = ipcRenderer.sendSync(IPC.pageAdblock, location.href) as PageAdblock | null
  if (!adblock) return
  // Runs in the page's world right away, past its CSP and Trusted Types.
  if (adblock.scriptlets) void webFrame.executeJavaScript(adblock.scriptlets).catch(() => {})
  // A user style sheet: it applies before the page draws, and the page can't see it.
  if (site?.adStyles) webFrame.insertCSS(site.adStyles, { cssOrigin: 'user' })
  installCosmeticFiltering()
  site?.blockAds?.()
}
