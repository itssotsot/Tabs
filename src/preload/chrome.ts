import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type BrowserrAPI, type Unsubscribe } from '@shared/api'

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BrowserrAPI = {
  platform: process.platform,
  tabs: {
    create: (url) => ipcRenderer.send(IPC.tabCreate, url),
    close: (id) => ipcRenderer.send(IPC.tabClose, id),
    activate: (id) => ipcRenderer.send(IPC.tabActivate, id),
    move: (id, toIndex) => ipcRenderer.send(IPC.tabMove, id, toIndex),
    contextMenu: (id) => ipcRenderer.send(IPC.tabContextMenu, id),
    toggleMute: (id) => ipcRenderer.send(IPC.tabToggleMute, id)
  },
  nav: {
    go: (input) => ipcRenderer.send(IPC.navigate, input),
    back: () => ipcRenderer.send(IPC.navBack),
    forward: () => ipcRenderer.send(IPC.navForward),
    reload: () => ipcRenderer.send(IPC.navReload),
    stop: () => ipcRenderer.send(IPC.navStop),
    resetZoom: () => ipcRenderer.send(IPC.zoomReset)
  },
  onWindowState: (cb) => on(IPC.windowState, cb),
  onCommand: (cb) => on(IPC.command, cb),
  setInsets: (insets) => ipcRenderer.send(IPC.setInsets, insets),
  siteInfoMenu: () => ipcRenderer.send(IPC.siteInfoMenu),
  appMenu: (x, y) => ipcRenderer.send(IPC.appMenu, x, y),
  omnibox: {
    query: (text) => ipcRenderer.invoke(IPC.omniboxQuery, text),
    show: (items, selected, rect) => ipcRenderer.send(IPC.omniboxShow, items, selected, rect),
    hide: () => ipcRenderer.send(IPC.omniboxHide),
    onPick: (cb) => on(IPC.omniboxPick, cb)
  },
  find: {
    start: (text, forward, findNext) => ipcRenderer.send(IPC.findStart, text, forward, findNext),
    stop: () => ipcRenderer.send(IPC.findStop),
    onState: (cb) => on(IPC.findState, cb)
  },
  bookmarks: {
    toggleCurrent: () => ipcRenderer.send(IPC.bookmarkToggle),
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
    openPicker: () => ipcRenderer.send(IPC.shareOpenPicker)
  },
  auth: {
    signInWithGoogle: () => ipcRenderer.invoke(IPC.signInWithGoogle)
  },
  notify: (n) => ipcRenderer.send(IPC.notify, n),
  setBadge: (count) => ipcRenderer.send(IPC.setBadge, count),
  openUrl: (url, background) => ipcRenderer.send(IPC.openUrl, url, background),
  overlay: {
    onState: (cb) => on(IPC.overlayState, cb),
    pick: (index) => ipcRenderer.send(IPC.overlayPick, index),
    close: () => ipcRenderer.send(IPC.overlayClose),
    openPanel: (panel) => ipcRenderer.send(IPC.overlayOpenPanel, panel)
  }
}

contextBridge.exposeInMainWorld('browserr', api)
