import type { Session } from 'electron'
import type { ExtensionInfo } from '@shared/types'
import { extensionPreload } from '../env'
import { extensionHooks } from '../extension-hooks'
import { allLoadedExtensions, hasApiPermission, loadedExtension, setAccessSession } from './access'
import './api/index'
import { isPinned } from './api/action'
import { handleExtensionShortcut, shortcutsFor } from './api/commands'
import { extensionPageMenuItems } from './api/context-menus'
import { contentSettingFor, privacySetting } from './api/platform/index'
import { lifecycle } from './lifecycle'
import { listExtensions, setupManager } from './manager'
import { setupRouter } from './router'
import { chromeTabId, extraWindowForWebContents, startTabsModel, tabForWebContents } from './tabs-model'

export { extensionOptionsUrl, listExtensions, removeExtension, setExtensionEnabled, WEB_STORE_URL } from './manager'
export { activateAction, setPinned, toolbarFor } from './api/action'

/** The list for the extensions page, with each one's toolbar and shortcut settings. */
export function extensionsForPage(): ExtensionInfo[] {
  return listExtensions().map((e) => ({ ...e, pinned: isPinned(e.id), shortcuts: shortcutsFor(e.id) }))
}
export { shortcutsFor } from './api/commands'
export { closeSidePanel, setSidePanelBounds } from './api/side-panel'
export { showExtensionContextMenu, showExtensionsMenu } from './menus'

/** Web permissions an extension's own pages get from its manifest, like in Chrome. */
const PAGE_PERMISSIONS: Record<string, string[]> = {
  notifications: ['notifications'],
  'clipboard-read': ['clipboardRead'],
  'clipboard-sanitized-write': ['clipboardWrite'],
  geolocation: ['geolocation'],
  // tabCapture's streams (getUserMedia with chromeMediaSource: 'tab') arrive as media requests.
  media: ['tabCapture', 'desktopCapture'],
  'display-capture': ['desktopCapture']
}

function extensionPagePermission(permission: string, url: string): boolean | undefined {
  const id = /^chrome-extension:\/\/([a-p]{32})/.exec(url)?.[1]
  if (!id || !loadedExtension(id)) return undefined
  return PAGE_PERMISSIONS[permission]?.some((p) => hasApiPermission(id, p)) ? true : undefined
}

/** The page an extension puts in place of the new tab page, if any (the most recently loaded wins). */
function newTabOverride(): string | null {
  for (const extension of allLoadedExtensions().reverse()) {
    const page = (extension.manifest as { chrome_url_overrides?: { newtab?: string } }).chrome_url_overrides?.newtab
    if (page) return new URL(page, extension.url).href
  }
  return null
}

/**
 * Chrome extensions: installing and loading them (manager.ts), and the chrome.* APIs Electron
 * doesn't provide, implemented in api/ and reached from extension pages and workers through
 * the router. Runs before any window opens, so content scripts see every page.
 */
export async function setupExtensions(session: Session): Promise<void> {
  setAccessSession(session)
  session.registerPreloadScript({ id: 'tabs-extension-api-frame', type: 'frame', filePath: extensionPreload })
  session.registerPreloadScript({ id: 'tabs-extension-api-worker', type: 'service-worker', filePath: extensionPreload })
  setupRouter(session, (wc) => {
    const found = tabForWebContents(wc)
    if (found) return { tabId: chromeTabId(found.tab), windowId: found.controller.win.id }
    const extra = extraWindowForWebContents(wc)
    if (extra) return { tabId: wc.id, windowId: extra.win.id }
    return null
  })
  startTabsModel()
  extensionHooks.pageMenuItems = extensionPageMenuItems
  extensionHooks.shortcut = handleExtensionShortcut
  extensionHooks.newTabOverride = newTabOverride
  extensionHooks.contentSetting = contentSettingFor
  extensionHooks.privacySetting = privacySetting
  extensionHooks.extensionPagePermission = extensionPagePermission
  lifecycle.emit('ready', session)
  await setupManager(session)
}
