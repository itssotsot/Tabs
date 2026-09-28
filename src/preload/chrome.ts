import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type BrowserrAPI, type Unsubscribe } from '@shared/api'
import type { PageEdge, WindowState } from '@shared/types'
import { followTheme } from './theme'

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Like `on`, for state the main process sends as it changes: a new subscriber gets the latest right away. The
 * first is sent when the UI has loaded, which can be before React has subscribed; without this, the tab list
 * stayed empty until something changed.
 */
function latest<T>(channel: string): (cb: (payload: T) => void) => Unsubscribe {
  let last: { payload: T } | null = null
  ipcRenderer.on(channel, (_e, payload: T) => (last = { payload }))
  return (cb) => {
    if (last) cb(last.payload)
    return on(channel, cb)
  }
}

const windowState = latest<WindowState>(IPC.windowState)
const pageEdge = latest<PageEdge>(IPC.pageEdge)

const api: BrowserrAPI = {
  platform: process.platform,
  tabs: {
    create: (url) => ipcRenderer.send(IPC.tabCreate, url),
    close: (id) => ipcRenderer.send(IPC.tabClose, id),
    activate: (id) => ipcRenderer.send(IPC.tabActivate, id),
    move: (id, toIndex, into) => ipcRenderer.send(IPC.tabMove, id, toIndex, into),
    moveGroup: (group, toIndex, place) => ipcRenderer.send(IPC.tabMoveGroup, group, toIndex, place),
    peekGroup: (group, anchor) => ipcRenderer.send(IPC.tabPeekGroup, group, anchor),
    unpeekGroup: (now) => ipcRenderer.send(IPC.tabUnpeekGroup, now),
    groupMenu: (group) => ipcRenderer.send(IPC.tabGroupMenu, group),
    contextMenu: (id) => ipcRenderer.send(IPC.tabContextMenu, id),
    toggleMute: (id) => ipcRenderer.send(IPC.tabToggleMute, id),
    media: (id, command) => ipcRenderer.send(IPC.tabMedia, id, command),
    call: (id, device) => ipcRenderer.send(IPC.tabCall, id, device),
    stopCapture: (id, device) => ipcRenderer.send(IPC.tabStopCapture, id, device)
  },
  split: {
    dragStart: (tabId) => ipcRenderer.invoke(IPC.splitDragStart, tabId),
    hold: (held) => ipcRenderer.send(IPC.splitHold, held),
    finish: (tabId, side) => ipcRenderer.invoke(IPC.splitFinish, tabId, side),
    resize: (ratio) => ipcRenderer.send(IPC.splitResize, ratio),
    close: () => ipcRenderer.send(IPC.splitClose),
    swap: () => ipcRenderer.send(IPC.splitSwap)
  },
  nav: {
    go: (input) => ipcRenderer.send(IPC.navigate, input),
    back: () => ipcRenderer.send(IPC.navBack),
    forward: () => ipcRenderer.send(IPC.navForward),
    reload: () => ipcRenderer.send(IPC.navReload),
    stop: () => ipcRenderer.send(IPC.navStop),
    resetZoom: () => ipcRenderer.send(IPC.zoomReset),
    pasteAndGo: () => ipcRenderer.send(IPC.pasteAndGo)
  },
  onWindowState: windowState,
  onPageEdge: pageEdge,
  onCommand: (cb) => on(IPC.command, cb),
  setInsets: (insets) => ipcRenderer.send(IPC.setInsets, insets),
  siteInfoMenu: () => ipcRenderer.send(IPC.siteInfoMenu),
  captureMenu: () => ipcRenderer.send(IPC.captureMenu),
  appMenu: (x, y) => ipcRenderer.send(IPC.appMenu, x, y),
  showMenu: (items) => ipcRenderer.invoke(IPC.showMenu, items),
  omnibox: {
    query: (text) => ipcRenderer.invoke(IPC.omniboxQuery, text),
    show: (items, selected, rect) => ipcRenderer.send(IPC.omniboxShow, items, selected, rect),
    hide: () => ipcRenderer.send(IPC.omniboxHide),
    onPick: (cb) => on(IPC.omniboxPick, cb),
    setAnchor: (anchor) => ipcRenderer.send(IPC.omniboxAnchor, anchor)
  },
  find: {
    start: (text, forward, findNext) => ipcRenderer.send(IPC.findStart, text, forward, findNext),
    stop: () => ipcRenderer.send(IPC.findStop),
    onState: (cb) => on(IPC.findState, cb)
  },
  bookmarks: {
    toggleCurrent: () => ipcRenderer.send(IPC.bookmarkToggle),
    toggle: (url, title) => ipcRenderer.send(IPC.bookmarkToggleUrl, url, title),
    list: () => ipcRenderer.invoke(IPC.bookmarksList),
    open: (url, newTab) => ipcRenderer.send(IPC.bookmarkOpen, url, newTab),
    contextMenu: (id) => ipcRenderer.send(IPC.bookmarkContextMenu, id),
    onChanged: (cb) => on(IPC.bookmarksChanged, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    onChanged: (cb) => on(IPC.settingsChanged, cb)
  },
  downloads: {
    list: () => ipcRenderer.invoke(IPC.downloadsList),
    action: (action, id) => ipcRenderer.send(IPC.downloadAction, action, id),
    onChanged: (cb) => on(IPC.downloadsChanged, cb)
  },
  share: {
    openPicker: () => ipcRenderer.send(IPC.shareOpenPicker),
    preview: (url) => ipcRenderer.invoke(IPC.sharePreview, url),
    openPickerForLink: (url, title) => ipcRenderer.send(IPC.shareOpenPickerForLink, url, title)
  },
  auth: {
    signInWithGoogle: () => ipcRenderer.invoke(IPC.signInWithGoogle)
  },
  updates: {
    get: () => ipcRenderer.invoke(IPC.updateGet),
    install: () => ipcRenderer.send(IPC.updateInstall),
    onChanged: (cb) => on(IPC.updateChanged, cb)
  },
  extensions: {
    get: () => ipcRenderer.invoke(IPC.extensionsGet),
    onToolbar: (cb) => on(IPC.extensionsToolbar, cb),
    activate: (id, anchor) => ipcRenderer.send(IPC.extensionActivate, id, anchor),
    contextMenu: (id) => ipcRenderer.send(IPC.extensionContextMenu, id),
    menu: (anchor) => ipcRenderer.send(IPC.extensionsMenu, anchor),
    panelBounds: (rect) => ipcRenderer.send(IPC.extensionPanelBounds, rect),
    closePanel: () => ipcRenderer.send(IPC.extensionPanelClose)
  },
  intro: {
    pending: () => ipcRenderer.sendSync(IPC.introPending) === true,
    finish: () => ipcRenderer.send(IPC.introFinish)
  },
  importer: {
    sources: () => ipcRenderer.invoke(IPC.importSources),
    preview: (id) => ipcRenderer.invoke(IPC.importPreview, id),
    run: (id, choice) => ipcRenderer.invoke(IPC.importRun, id, choice),
    openAccessSettings: () => ipcRenderer.send(IPC.importOpenAccess)
  },
  notify: (n) => ipcRenderer.send(IPC.notify, n),
  setBadge: (count) => ipcRenderer.send(IPC.setBadge, count),
  openUrl: (url, background, fromLink) => ipcRenderer.send(IPC.openUrl, url, background, fromLink),
  overlay: {
    onState: (cb) => on(IPC.overlayState, cb),
    pick: (index) => ipcRenderer.send(IPC.overlayPick, index),
    close: () => ipcRenderer.send(IPC.overlayClose),
    openPanel: (panel) => ipcRenderer.send(IPC.overlayOpenPanel, panel),
    peekHover: (inside) => ipcRenderer.send(IPC.overlayPeekHover, inside),
    answerPermission: (answer) => ipcRenderer.send(IPC.overlayPermissionAnswer, answer),
    promptHeight: (height) => ipcRenderer.send(IPC.overlayPromptHeight, height)
  }
}

contextBridge.exposeInMainWorld('browserr', api)
followTheme()
