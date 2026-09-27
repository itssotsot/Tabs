import { WebContentsView } from 'electron'
import type { Rect } from '@shared/types'
import { browserEvents } from '../../browser-events'
import { webSession } from '../../env'
import type { BrowserWindowController } from '../../window'
import { loadedExtension, manifestOf } from '../access'
import { lifecycle } from '../lifecycle'
import { extensionDisplay } from '../manager'
import { defineApi, defineEvent, emit, ExtensionError, registerSurface, type CallContext } from '../router'
import { getState, setState } from '../state'
import { chromeTabId, currentWindow, findTab, resolveWindow } from '../tabs-model'

/**
 * chrome.sidePanel: an extension page shown in the browser's sidebar. The browser UI draws the
 * sidebar and its header and reports where the page goes; this module owns the page itself.
 */

interface PanelOptions {
  path?: string
  enabled?: boolean
}

interface OpenPanel {
  extensionId: string
  view: WebContentsView
  url: string
  attached: boolean
}

const globalOptions = new Map<string, PanelOptions>()
const tabOptions = new Map<string, Map<number, PanelOptions>>()
const openPanels = new Map<BrowserWindowController, OpenPanel>()

function defaultPath(id: string): string | undefined {
  return (manifestOf(id)?.side_panel as { default_path?: string } | undefined)?.default_path
}

function optionsFor(id: string, tabId?: number): { path?: string; enabled: boolean } {
  const g = globalOptions.get(id) ?? {}
  const t = tabId !== undefined ? tabOptions.get(id)?.get(tabId) : undefined
  return {
    path: t?.path ?? g.path ?? defaultPath(id),
    enabled: t?.enabled ?? g.enabled ?? true
  }
}

function panelUrl(id: string, tabId?: number): string | null {
  const extension = loadedExtension(id)
  const { path, enabled } = optionsFor(id, tabId)
  if (!extension || !path || !enabled) return null
  return new URL(path, extension.url).href
}

export function panelOpensOnActionClick(id: string): boolean {
  return getState<boolean>(id, 'openPanelOnActionClick', false) && !!panelUrl(id)
}

function destroy(c: BrowserWindowController, notify: boolean): void {
  const panel = openPanels.get(c)
  if (!panel) return
  openPanels.delete(c)
  if (panel.attached && !c.win.isDestroyed()) c.win.contentView.removeChildView(panel.view)
  if (!panel.view.webContents.isDestroyed()) panel.view.webContents.close()
  if (notify) c.sendCommand({ type: 'close-extension-panel' })
  emit('sidePanel.onClosed', [{ windowId: c.win.id, path: new URL(panel.url).pathname.slice(1) }], { extensionId: panel.extensionId, wake: false })
}

/** Opens (or switches to) the extension's side panel in a window. */
export function openSidePanel(c: BrowserWindowController, extensionId: string): void {
  const tab = c.activeTab
  const tabId = tab ? chromeTabId(tab) : undefined
  const url = panelUrl(extensionId, tabId)
  if (!url) throw new ExtensionError('No active side panel for this tab.')
  const existing = openPanels.get(c)
  if (existing?.extensionId === extensionId) {
    if (existing.url !== url) {
      existing.url = url
      void existing.view.webContents.loadURL(url).catch(() => {})
    }
  } else {
    if (existing) destroy(c, false)
    const view = new WebContentsView({
      webPreferences: { session: webSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.setBackgroundColor('#ffffff')
    registerSurface(view.webContents, { type: 'SIDE_PANEL', windowId: c.win.id })
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      c.createTab(target)
      return { action: 'deny' }
    })
    openPanels.set(c, { extensionId, view, url, attached: false })
    void view.webContents.loadURL(url).catch(() => {})
  }
  const display = extensionDisplay(extensionId)
  c.sendCommand({ type: 'open-extension-panel', panel: { id: extensionId, name: display?.name ?? extensionId, icon: display?.icon ?? null } })
  emit('sidePanel.onOpened', [{ windowId: c.win.id, tabId, path: new URL(url).pathname.slice(1) }], { extensionId, wake: false })
}

/** Where the browser UI's sidebar wants the panel's page, or null when the panel isn't showing. */
export function setSidePanelBounds(c: BrowserWindowController, rect: Rect | null): void {
  const panel = openPanels.get(c)
  if (!panel) return
  if (!rect) return destroy(c, false)
  panel.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })
  if (!panel.attached) {
    c.win.contentView.addChildView(panel.view)
    panel.attached = true
  }
}

export function closeSidePanel(c: BrowserWindowController): void {
  destroy(c, true)
}

function targetWindow(call: CallContext, options: Record<string, unknown>): BrowserWindowController {
  if (typeof options.tabId === 'number') {
    const found = findTab(options.tabId)
    if (!found) throw new ExtensionError(`No tab with id: ${options.tabId}.`)
    return found.controller
  }
  const c = typeof options.windowId === 'number' ? resolveWindow(options.windowId, call) : currentWindow(call)
  if (!c) throw new ExtensionError('No window.')
  return c
}

defineApi('sidePanel', {
  permissions: ['sidePanel'],
  methods: {
    setOptions: (call, options) => {
      const o = (options ?? {}) as { tabId?: number; path?: string; enabled?: boolean }
      const value: PanelOptions = {}
      if (typeof o.path === 'string') value.path = o.path
      if (typeof o.enabled === 'boolean') value.enabled = o.enabled
      if (typeof o.tabId === 'number') {
        let perExt = tabOptions.get(call.extensionId)
        if (!perExt) tabOptions.set(call.extensionId, (perExt = new Map()))
        perExt.set(o.tabId, { ...perExt.get(o.tabId), ...value })
      } else {
        globalOptions.set(call.extensionId, { ...globalOptions.get(call.extensionId), ...value })
      }
      // An open panel follows its new options.
      for (const [c, panel] of openPanels) {
        if (panel.extensionId !== call.extensionId) continue
        const tab = c.activeTab
        const url = panelUrl(call.extensionId, tab ? chromeTabId(tab) : undefined)
        if (!url) destroy(c, true)
        else if (url !== panel.url) {
          panel.url = url
          void panel.view.webContents.loadURL(url).catch(() => {})
        }
      }
    },
    getOptions: (call, options) => {
      const tabId = (options as { tabId?: unknown } | undefined)?.tabId
      const o = optionsFor(call.extensionId, typeof tabId === 'number' ? tabId : undefined)
      return { path: o.path, enabled: o.enabled, ...(typeof tabId === 'number' ? { tabId } : {}) }
    },
    setPanelBehavior: (call, behavior) => {
      const open = (behavior as { openPanelOnActionClick?: unknown } | undefined)?.openPanelOnActionClick
      if (typeof open === 'boolean') setState(call.extensionId, 'openPanelOnActionClick', open)
    },
    getPanelBehavior: (call) => ({ openPanelOnActionClick: getState<boolean>(call.extensionId, 'openPanelOnActionClick', false) }),
    open: (call, options) => openSidePanel(targetWindow(call, (options ?? {}) as Record<string, unknown>), call.extensionId),
    close: (call, options) => {
      const c = targetWindow(call, (options ?? {}) as Record<string, unknown>)
      if (openPanels.get(c)?.extensionId === call.extensionId) destroy(c, true)
    },
    getLayout: () => ({ side: 'right' })
  }
})

defineEvent('sidePanel.onOpened')
defineEvent('sidePanel.onClosed')

// Switching tabs: the panel shows that tab's page, or closes if the extension turned it off there.
browserEvents.on('window-state', (c) => {
  const panel = openPanels.get(c)
  if (!panel) return
  const tab = c.activeTab
  const url = panelUrl(panel.extensionId, tab ? chromeTabId(tab) : undefined)
  if (!url) destroy(c, true)
  else if (url !== panel.url) {
    panel.url = url
    void panel.view.webContents.loadURL(url).catch(() => {})
  }
})
browserEvents.on('window-closed', (c) => openPanels.delete(c))
browserEvents.on('tab-closed', (tab) => {
  const tabId = chromeTabId(tab)
  for (const perExt of tabOptions.values()) perExt.delete(tabId)
})
lifecycle.on('unloaded', (id) => {
  globalOptions.delete(id)
  tabOptions.delete(id)
  for (const [c, panel] of openPanels) if (panel.extensionId === id) destroy(c, true)
})
