import { app, clipboard, dialog, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import { INTERNAL_SCHEME, looksLikeUrl, searchUrl, SEARCH_ENGINE_NAMES, toNavigableUrl } from '@shared/url'
import { bookmarksChanged, settingsChanged, toggleBookmark } from './broadcast'
import { draftFromLink } from './share'
import { store } from './store'
import type { Tab } from './tab'
import { BrowserWindowController, focusedController } from './window'

const isMac = process.platform === 'darwin'

type Item = MenuItemConstructorOptions

/** Runs `fn` against the focused window, opening one if none exists. */
function withWindow(fn: (c: BrowserWindowController) => void): () => void {
  return () => fn(focusedController() ?? new BrowserWindowController())
}

function withTab(fn: (tab: Tab, c: BrowserWindowController) => void): () => void {
  return () => {
    const c = focusedController()
    if (c?.activeTab) fn(c.activeTab, c)
  }
}

function internal(page: string): () => void {
  return withWindow((c) => c.createTab(`${INTERNAL_SCHEME}://${page}/`))
}

function compact(items: (Item | false | null | undefined)[]): Item[] {
  const out: Item[] = []
  for (const item of items) {
    if (!item) continue
    if (item.type === 'separator' && (!out.length || out.at(-1)?.type === 'separator')) continue
    out.push(item)
  }
  while (out.at(-1)?.type === 'separator') out.pop()
  return out
}

const separator: Item = { type: 'separator' }

// ---- application menu (also provides the keyboard shortcuts) ----

export function buildAppMenu(): void {
  const tabShortcuts: Item[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Select Last Tab' : `Select Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: withWindow((c) => c.selectTab(i))
  }))

  const template: Item[] = compact([
    isMac && {
      label: app.name,
      submenu: [
        { role: 'about' },
        separator,
        { label: 'Settings…', accelerator: 'Cmd+,', click: internal('settings') },
        separator,
        { role: 'services' },
        separator,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        separator,
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: compact([
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: withWindow((c) => c.createTab()) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => new BrowserWindowController() },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: withWindow((c) => c.reopenClosedTab()) },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: withWindow((c) => c.focusOmnibox()) },
        separator,
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: withWindow((c) => c.closeActiveTab()) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: withWindow((c) => c.win.close()) },
        separator,
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: withTab((tab) => savePage(tab)) },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: withTab((tab) => tab.wc.print()) },
        !isMac && separator,
        !isMac && { label: 'Settings', click: internal('settings') },
        !isMac && { role: 'quit', label: 'Exit' }
      ])
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        separator,
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: withWindow((c) => openFind(c)) },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl+G',
          click: withWindow((c) => c.sendCommand({ type: 'find-next', forward: true }))
        },
        {
          label: 'Find Previous',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: withWindow((c) => c.sendCommand({ type: 'find-next', forward: false }))
        }
      ]
    },
    {
      label: 'View',
      submenu: compact([
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withTab((tab) => tab.reload()) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: withTab((tab) => tab.reload(true)) },
        isMac && { label: 'Stop', accelerator: 'Cmd+.', click: withTab((tab) => tab.wc.stop()) },
        separator,
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: withTab((tab) => tab.zoom('in')) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: withTab((tab) => tab.zoom('out')) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: withTab((tab) => tab.zoom('reset')) },
        separator,
        {
          label: 'Show Links Sidebar',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: withWindow((c) => c.sendCommand({ type: 'toggle-sidebar', panel: 'inbox' }))
        },
        {
          label: 'Always Show Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          type: 'checkbox',
          checked: store.settings.showBookmarksBar,
          click: () => {
            store.updateSettings({ showBookmarksBar: !store.settings.showBookmarksBar })
            settingsChanged()
          }
        },
        { role: 'togglefullscreen' },
        separator,
        {
          label: 'Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: withTab((tab) => tab.toggleDevTools())
        },
        !app.isPackaged && {
          label: 'Browser UI Developer Tools',
          click: withWindow((c) => c.win.webContents.openDevTools({ mode: 'detach' }))
        }
      ])
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withTab((tab) => tab.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withTab((tab) => tab.goForward()) },
        separator,
        { label: 'Show All History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: internal('history') }
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: withWindow((c) => toggleBookmark(c)) },
        { label: 'Bookmark Manager', accelerator: 'CmdOrCtrl+Alt+B', click: internal('bookmarks') }
      ]
    },
    {
      label: 'Share',
      submenu: [
        {
          label: 'Send to a Friend…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: withWindow((c) => void c.openSendPickerForTab())
        },
        separator,
        { label: 'Inbox', click: withWindow((c) => c.sendCommand({ type: 'open-sidebar', panel: 'inbox' })) },
        { label: 'Friends', click: withWindow((c) => c.sendCommand({ type: 'open-sidebar', panel: 'friends' })) },
        { label: 'Downloads', accelerator: isMac ? 'Alt+Cmd+L' : 'Ctrl+J', click: withWindow((c) => c.sendCommand({ type: 'open-sidebar', panel: 'downloads' })) }
      ]
    },
    {
      label: 'Window',
      submenu: compact([
        { role: 'minimize' },
        isMac && { role: 'zoom' },
        separator,
        { label: 'Next Tab', accelerator: isMac ? 'Cmd+Alt+Right' : 'Ctrl+Tab', click: withWindow((c) => c.cycleTab(1)) },
        { label: 'Previous Tab', accelerator: isMac ? 'Cmd+Alt+Left' : 'Ctrl+Shift+Tab', click: withWindow((c) => c.cycleTab(-1)) },
        ...tabShortcuts,
        isMac && separator,
        isMac && { role: 'front' }
      ])
    },
    {
      role: 'help',
      submenu: [{ label: 'Firebase Console', click: () => shell.openExternal('https://console.firebase.google.com/project/browserr-share') }]
    }
  ])

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function openFind(c: BrowserWindowController): void {
  c.win.webContents.focus()
  c.sendCommand({ type: 'open-find' })
}

function savePage(tab: Tab): void {
  const base = (tab.state.title || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100)
  void dialog
    .showSaveDialog({ defaultPath: `${app.getPath('downloads')}/${base}.html`, filters: [{ name: 'Web Page', extensions: ['html'] }] })
    .then(({ canceled, filePath }) => {
      if (!canceled && filePath) void tab.wc.savePage(filePath, 'HTMLComplete')
    })
}

// ---- right-click on a page ----

export function showPageContextMenu(c: BrowserWindowController, tab: Tab, p: ContextMenuParams): void {
  const wc = tab.wc
  const engine = store.settings.searchEngine
  const selection = p.selectionText.trim()
  const isPlainPage = !p.linkURL && !p.isEditable && !selection && p.mediaType === 'none'
  const openInBackground = (url: string): void => void c.openTab(url, { active: false, opener: tab })

  const items = compact([
    // Spelling
    ...(p.misspelledWord
      ? ([
          ...p.dictionarySuggestions.slice(0, 5).map((s): Item => ({ label: s, click: () => wc.replaceMisspelling(s) })),
          !p.dictionarySuggestions.length && { label: 'No spelling suggestions', enabled: false },
          { label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
          separator
        ] as (Item | false)[])
      : []),

    // Links
    ...(p.linkURL
      ? ([
          { label: 'Open Link in New Tab', click: () => openInBackground(p.linkURL) },
          { label: 'Open Link in New Window', click: () => new BrowserWindowController({ urls: [p.linkURL] }) },
          separator,
          /^https?:/.test(p.linkURL) && {
            label: 'Send Link to a Friend…',
            click: () => {
              const draft = draftFromLink(p.linkURL, p.linkText)
              if (draft) c.openSendPicker(draft)
            }
          },
          { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
          separator
        ] as (Item | false)[])
      : []),

    // Images
    ...(p.mediaType === 'image' && p.srcURL
      ? ([
          { label: 'Open Image in New Tab', click: () => openInBackground(p.srcURL) },
          { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
          { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
          { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
          separator
        ] as (Item | false)[])
      : []),

    // Video / audio with a real URL
    ...((p.mediaType === 'video' || p.mediaType === 'audio') && /^https?:/.test(p.srcURL)
      ? ([
          { label: `Open ${p.mediaType === 'video' ? 'Video' : 'Audio'} in New Tab`, click: () => openInBackground(p.srcURL) },
          { label: `Save ${p.mediaType === 'video' ? 'Video' : 'Audio'} As…`, click: () => wc.downloadURL(p.srcURL) },
          separator
        ] as (Item | false)[])
      : []),

    // Text fields
    ...(p.isEditable
      ? ([
          { role: 'undo', enabled: p.editFlags.canUndo },
          { role: 'redo', enabled: p.editFlags.canRedo },
          separator,
          { role: 'cut', enabled: p.editFlags.canCut },
          { role: 'copy', enabled: p.editFlags.canCopy },
          { role: 'paste', enabled: p.editFlags.canPaste },
          { role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
          { role: 'selectAll', enabled: p.editFlags.canSelectAll },
          separator
        ] as Item[])
      : []),

    // Selected text
    ...(!p.isEditable && selection
      ? ([
          { role: 'copy' },
          looksLikeUrl(selection)
            ? { label: `Go to ${truncate(selection, 30)}`, click: () => openInBackground(toNavigableUrl(selection, engine)) }
            : {
                label: `Search ${SEARCH_ENGINE_NAMES[engine]} for “${truncate(selection, 30)}”`,
                click: () => c.openTab(searchUrl(selection, engine), { active: true, opener: tab })
              },
          separator
        ] as (Item | false)[])
      : []),

    // Page
    ...(isPlainPage
      ? ([
          { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => tab.goBack() },
          { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => tab.goForward() },
          { label: 'Reload', click: () => tab.reload() },
          separator,
          !tab.isInternal && { label: 'Send Page to a Friend…', accelerator: 'CmdOrCtrl+Shift+S', click: () => void c.openSendPickerForTab(tab) },
          !tab.isInternal && { label: 'Copy Page Address', click: () => clipboard.writeText(tab.url) },
          separator,
          { label: 'Save Page As…', click: () => savePage(tab) },
          { label: 'Print…', click: () => wc.print() },
          separator
        ] as (Item | false)[])
      : []),

    {
      label: 'Inspect',
      click: () => {
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
        wc.inspectElement(p.x, p.y)
      }
    }
  ])

  Menu.buildFromTemplate(items).popup({ window: c.win })
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

// ---- right-click on a tab ----

export function showTabContextMenu(c: BrowserWindowController, tab: Tab): void {
  const muted = tab.muted
  Menu.buildFromTemplate(
    compact([
      { label: 'New Tab to the Right', click: () => c.createTab(undefined, { index: c.indexOf(tab) + 1 }) },
      separator,
      { label: 'Reload', click: () => tab.reload() },
      { label: 'Duplicate', click: () => c.duplicateTab(tab) },
      { label: tab.pinned ? 'Unpin' : 'Pin', click: () => c.setPinned(tab, !tab.pinned) },
      { label: muted ? 'Unmute Site' : 'Mute Site', click: () => tab.toggleMute() },
      !tab.isInternal && { label: 'Send to a Friend…', click: () => void c.openSendPickerForTab(tab) },
      separator,
      { label: 'Close Tab', click: () => c.closeTab(tab) },
      { label: 'Close Other Tabs', click: () => c.closeOtherTabs(tab) },
      { label: 'Close Tabs to the Right', click: () => c.closeTabsToRight(tab) },
      separator,
      { label: 'Reopen Closed Tab', click: () => c.reopenClosedTab() }
    ])
  ).popup({ window: c.win })
}

// ---- the lock icon in the address bar ----

export function showSiteInfoMenu(c: BrowserWindowController): void {
  const tab = c.activeTab
  if (!tab || tab.isInternal) return
  let origin: string
  try {
    origin = new URL(tab.url).origin
  } catch {
    return
  }
  const secure = origin.startsWith('https:')
  const permissions = Object.entries(store.sitePermissions(origin))
  const names: Record<string, string> = {
    media: 'Camera & microphone',
    geolocation: 'Location',
    notifications: 'Notifications',
    'clipboard-read': 'Clipboard',
    openExternal: 'Open external apps',
    midi: 'MIDI devices',
    midiSysex: 'MIDI devices (full control)',
    'idle-detection': 'Idle detection',
    'display-capture': 'Screen sharing'
  }

  Menu.buildFromTemplate(
    compact([
      { label: origin.replace(/^https?:\/\//, ''), enabled: false },
      { label: secure ? '🔒 Connection is secure' : '⚠️ Connection is not secure', enabled: false },
      separator,
      ...permissions.map(([perm, decision]): Item => ({
        label: `${names[perm] ?? perm}: ${decision === 'allow' ? 'Allowed' : 'Blocked'}`,
        click: () => {
          store.setPermission(origin, perm, decision === 'allow' ? 'deny' : 'allow')
        }
      })),
      permissions.length > 0 && separator,
      permissions.length > 0 && {
        label: 'Reset Permissions',
        click: () => {
          store.clearSitePermissions(origin)
          tab.reload()
        }
      },
      {
        label: 'Clear Cookies and Site Data',
        click: async () => {
          await tab.wc.session.clearStorageData({ origin })
          tab.reload()
        }
      }
    ])
  ).popup({ window: c.win })
}

// ---- the ⋯ button ----

export function showAppMenu(c: BrowserWindowController, x: number, y: number): void {
  const tab = c.activeTab
  const zoom = tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100
  Menu.buildFromTemplate(
    compact([
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => c.createTab() },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => new BrowserWindowController() },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => c.reopenClosedTab() },
      separator,
      { label: 'Inbox', click: () => c.sendCommand({ type: 'open-sidebar', panel: 'inbox' }) },
      { label: 'Friends', click: () => c.sendCommand({ type: 'open-sidebar', panel: 'friends' }) },
      { label: 'History', accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H', click: internal('history') },
      { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Alt+B', click: internal('bookmarks') },
      { label: 'Downloads', click: () => c.sendCommand({ type: 'open-sidebar', panel: 'downloads' }) },
      separator,
      tab && { label: `Zoom (${zoom}%)`, enabled: false },
      tab && { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => tab.zoom('in') },
      tab && { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => tab.zoom('out') },
      tab && zoom !== 100 && { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => tab.zoom('reset') },
      separator,
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => openFind(c) },
      tab && { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => tab.wc.print() },
      tab && { label: 'Developer Tools', click: () => tab.toggleDevTools() },
      separator,
      { label: 'Settings', click: internal('settings') },
      { label: isMac ? 'Quit Browserr' : 'Exit', click: () => app.quit() }
    ])
  ).popup({ window: c.win, x: Math.round(x), y: Math.round(y) })
}

// ---- right-click on a bookmark in the bookmarks bar ----

export function showBookmarkContextMenu(c: BrowserWindowController, id: string): void {
  const bookmark = store.bookmarks.find((b) => b.id === id)
  if (!bookmark) return
  Menu.buildFromTemplate([
    { label: 'Open in New Tab', click: () => c.createTab(bookmark.url, { active: false }) },
    { label: 'Open in New Window', click: () => new BrowserWindowController({ urls: [bookmark.url] }) },
    separator,
    { label: 'Copy Address', click: () => clipboard.writeText(bookmark.url) },
    {
      label: 'Delete',
      click: () => {
        store.removeBookmark(id)
        bookmarksChanged()
      }
    },
    separator,
    { label: 'Bookmark Manager', click: internal('bookmarks') }
  ]).popup({ window: c.win })
}
