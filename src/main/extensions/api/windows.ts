import { BrowserWindow, screen } from 'electron'
import { NEW_TAB_URL } from '@shared/url'
import { tabPreload, webSession } from '../../env'
import { BrowserWindowController } from '../../window'
import { defineApi, defineEvent, ExtensionError, type CallContext } from '../router'
import {
  addExtraWindow,
  allExtraWindows,
  currentWindow,
  extraToChromeWindow,
  findExtraWindow,
  findTab,
  findWindow,
  lastFocusedWindow,
  toChromeWindow,
  WINDOW_ID_CURRENT
} from '../tabs-model'
import { resolveExtensionUrl } from './tabs'

/** chrome.windows: browser windows, plus the popup windows extensions open. */

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

interface QueryOptions {
  populate?: boolean
  windowTypes?: string[]
}

function options(v: unknown): QueryOptions {
  return isObject(v) ? (v as QueryOptions) : {}
}

function allowedType(type: 'normal' | 'popup', o: QueryOptions): boolean {
  return !o.windowTypes?.length || o.windowTypes.includes(type)
}

function describe(call: CallContext, windowId: number, o: QueryOptions): chrome.windows.Window {
  const c = findWindow(windowId)
  if (c && allowedType('normal', o)) return toChromeWindow(c, !!o.populate, call.extensionId)
  const extra = findExtraWindow(windowId)
  if (extra && allowedType('popup', o)) return extraToChromeWindow(extra, !!o.populate, call.extensionId)
  throw new ExtensionError(`No window with id: ${windowId}.`)
}

function applyBounds(win: BrowserWindow, d: Record<string, unknown>): void {
  const b = win.getBounds()
  const next = {
    x: isNumber(d.left) ? Math.round(d.left) : b.x,
    y: isNumber(d.top) ? Math.round(d.top) : b.y,
    width: isNumber(d.width) ? Math.max(100, Math.round(d.width)) : b.width,
    height: isNumber(d.height) ? Math.max(100, Math.round(d.height)) : b.height
  }
  if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) win.setBounds(next)
}

function applyState(win: BrowserWindow, state: unknown): void {
  switch (state) {
    case 'minimized':
      win.minimize()
      break
    case 'maximized':
      win.maximize()
      break
    case 'fullscreen':
    case 'locked-fullscreen':
      win.setFullScreen(true)
      break
    case 'normal':
      if (win.isFullScreen()) win.setFullScreen(false)
      if (win.isMaximized()) win.unmaximize()
      if (win.isMinimized()) win.restore()
      break
  }
}

/** An extension's popup window (a window with just a page and no browser UI). */
function openPopupWindow(call: CallContext, url: string, d: Record<string, unknown>): chrome.windows.Window {
  const display = screen.getPrimaryDisplay().workArea
  const width = isNumber(d.width) ? Math.round(d.width) : 500
  const height = isNumber(d.height) ? Math.round(d.height) : 600
  const win = new BrowserWindow({
    width,
    height,
    x: isNumber(d.left) ? Math.round(d.left) : display.x + Math.round((display.width - width) / 2),
    y: isNumber(d.top) ? Math.round(d.top) : display.y + Math.round((display.height - height) / 2),
    autoHideMenuBar: true,
    show: d.focused !== false,
    backgroundColor: '#ffffff',
    webPreferences: { session: webSession(), preload: tabPreload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(({ url: target }) => {
    const c = lastFocusedWindow() ?? new BrowserWindowController({ urls: [] })
    c.createTab(target)
    c.focus()
    return { action: 'deny' }
  })
  win.on('page-title-updated', (e, title) => {
    e.preventDefault()
    win.setTitle(title)
  })
  const extra = { win, wc, type: 'popup' as const, extensionId: call.extensionId, requestedUrl: url }
  addExtraWindow(extra)
  void wc.loadURL(url).catch(() => {})
  if (d.focused === false) win.showInactive()
  return extraToChromeWindow(extra, true, call.extensionId)
}

function create(call: CallContext, createData: unknown): chrome.windows.Window {
  const d = isObject(createData) ? createData : {}
  const urls = (Array.isArray(d.url) ? d.url : d.url ? [d.url] : [])
    .filter((u): u is string => typeof u === 'string')
    .map((u) => resolveExtensionUrl(call, u))
  if (d.type === 'popup' || d.type === 'panel' || d.type === 'detached_panel') {
    return openPopupWindow(call, urls[0] ?? 'about:blank', d)
  }
  const c = new BrowserWindowController({ urls: urls.length ? urls : isNumber(d.tabId) ? [] : [NEW_TAB_URL] })
  if (isNumber(d.tabId)) {
    // Moves the tab into the new window, history and all.
    const found = findTab(d.tabId)
    if (found) {
      const saved = found.tab.toSaved()
      c.createTab(saved.url, {
        snapshot: { url: saved.url, title: saved.title ?? '', favicon: saved.favicon ?? null, entries: saved.entries, index: saved.index }
      })
      found.controller.closeTab(found.tab)
    }
  }
  applyBounds(c.win, d)
  applyState(c.win, d.state)
  if (d.focused === false) c.win.blur()
  return toChromeWindow(c, true, call.extensionId)
}

function update(call: CallContext, windowId: unknown, updateInfo: unknown): chrome.windows.Window {
  const id = isNumber(windowId) ? (windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : windowId) : undefined
  const win = (id !== undefined && (findWindow(id)?.win ?? findExtraWindow(id)?.win)) || null
  if (!win || id === undefined) throw new ExtensionError(`No window with id: ${String(windowId)}.`)
  const u = isObject(updateInfo) ? updateInfo : {}
  applyBounds(win, u)
  applyState(win, u.state)
  if (u.focused === true) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else if (u.focused === false) win.blur()
  if (u.drawAttention === true) win.flashFrame(true)
  if (u.drawAttention === false) win.flashFrame(false)
  return describe(call, id, {})
}

defineApi('windows', {
  methods: {
    get: (call, windowId, queryOptions) => {
      const o = options(queryOptions)
      const id = windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : windowId
      if (!isNumber(id)) throw new ExtensionError(`No window with id: ${String(windowId)}.`)
      return describe(call, id, o)
    },
    getCurrent: (call, queryOptions) => {
      const c = currentWindow(call)
      if (!c) throw new ExtensionError('No current window.')
      return toChromeWindow(c, !!options(queryOptions).populate, call.extensionId)
    },
    getLastFocused: (call, queryOptions) => {
      const c = lastFocusedWindow()
      if (!c) throw new ExtensionError('No window.')
      return toChromeWindow(c, !!options(queryOptions).populate, call.extensionId)
    },
    getAll: (call, queryOptions) => {
      const o = options(queryOptions)
      const out: chrome.windows.Window[] = []
      if (allowedType('normal', o)) {
        for (const c of BrowserWindowController.all) if (!c.win.isDestroyed()) out.push(toChromeWindow(c, !!o.populate, call.extensionId))
      }
      if (allowedType('popup', o)) for (const w of allExtraWindows()) out.push(extraToChromeWindow(w, !!o.populate, call.extensionId))
      return out
    },
    create,
    update,
    remove: (call, windowId) => {
      const id = windowId === WINDOW_ID_CURRENT ? currentWindow(call)?.win.id : windowId
      const win = isNumber(id) ? (findWindow(id)?.win ?? findExtraWindow(id)?.win) : null
      if (!win) throw new ExtensionError(`No window with id: ${String(windowId)}.`)
      win.close()
    }
  }
})

for (const name of ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']) defineEvent(`windows.${name}`)
