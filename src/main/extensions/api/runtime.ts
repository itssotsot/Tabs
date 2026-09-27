import { BrowserWindowController } from '../../window'
import { lifecycle } from '../lifecycle'
import { extensionOptionsUrl, reloadExtension } from '../manager'
import { allContexts, defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../router'
import { getState, setState } from '../state'
import { allTabs, currentWindow, lastFocusedWindow } from '../tabs-model'

/**
 * The parts of chrome.runtime Electron has but doesn't do anything with: install and startup
 * events, the options page, the uninstall URL, and the list of running contexts.
 */

function openOrFocus(url: string, call?: CallContext): void {
  const existing = allTabs().find(({ tab }) => tab.url === url)
  if (existing) {
    existing.controller.activate(existing.tab)
    existing.controller.focus()
    return
  }
  const c = currentWindow(call) ?? lastFocusedWindow() ?? new BrowserWindowController({ urls: [] })
  c.createTab(url)
  c.focus()
}

function getContexts(call: CallContext, filter: unknown): chrome.runtime.ExtensionContext[] {
  const f = (filter && typeof filter === 'object' ? filter : {}) as chrome.runtime.ContextFilter
  const out: chrome.runtime.ExtensionContext[] = []
  for (const ctx of allContexts(call.extensionId)) {
    if (ctx.type === 'OTHER') continue
    const wc = ctx.webContents
    let tabId = -1
    let windowId = -1
    if (ctx.type === 'TAB' && wc) {
      const found = allTabs().find(({ tab }) => tab.liveWc === wc)
      if (found) {
        tabId = wc.id
        windowId = found.controller.win.id
      }
    }
    const entry = {
      contextId: ctx.key,
      contextType: ctx.type as chrome.runtime.ContextType,
      documentId: ctx.frame ? `${ctx.frame.processId}:${ctx.frame.routingId}` : undefined,
      documentOrigin: ctx.frame ? ctx.frame.origin : undefined,
      documentUrl: ctx.frame ? ctx.frame.url : undefined,
      frameId: ctx.frame ? (ctx.frame.parent ? ctx.frame.frameTreeNodeId : 0) : -1,
      incognito: false,
      tabId,
      windowId
    } as chrome.runtime.ExtensionContext
    if (f.contextTypes?.length && !f.contextTypes.includes(entry.contextType)) continue
    if (f.contextIds?.length && !f.contextIds.includes(entry.contextId)) continue
    if (f.tabIds?.length && !f.tabIds.includes(tabId)) continue
    if (f.windowIds?.length && !f.windowIds.includes(windowId)) continue
    if (f.frameIds?.length && !f.frameIds.includes(entry.frameId)) continue
    if (f.documentUrls?.length && !f.documentUrls.includes(entry.documentUrl ?? '')) continue
    if (f.documentOrigins?.length && !f.documentOrigins.includes(entry.documentOrigin ?? '')) continue
    if (f.documentIds?.length && !f.documentIds.includes(entry.documentId ?? '')) continue
    if (f.incognito === true) continue
    out.push(entry)
  }
  return out
}

defineApi('runtime', {
  methods: {
    openOptionsPage: (call) => {
      const url = extensionOptionsUrl(call.extensionId)
      if (!url) throw new ExtensionError('Could not create an options page.')
      openOrFocus(url, call)
    },
    setUninstallURL: (call, url) => {
      if (url !== undefined && typeof url !== 'string') throw new ExtensionError('Invalid URL.')
      if (url && !/^https?:\/\//i.test(url)) throw new ExtensionError('Invalid URL: must be http or https.')
      setState(call.extensionId, 'uninstallUrl', url || undefined)
    },
    getContexts,
    reload: (call) => void reloadExtension(call.extensionId),
    // The Web Store library checks for updates by itself every few hours.
    requestUpdateCheck: () => ({ status: 'no_update' })
  }
})

defineApi('extension', {
  methods: {
    // Extensions are loaded without file:// access, and there's no incognito mode.
    isAllowedFileSchemeAccess: () => false,
    isAllowedIncognitoAccess: () => false,
    setUpdateUrlData: () => undefined
  }
})

defineEvent('runtime.onInstalled')
defineEvent('runtime.onStartup')

lifecycle.on('loaded', (extension, reason, previousVersion) => {
  if (reason === 'install' || reason === 'update') {
    const details: chrome.runtime.InstalledDetails = { reason: reason as chrome.runtime.OnInstalledReason }
    if (previousVersion) details.previousVersion = previousVersion
    emit('runtime.onInstalled', [details], { extensionId: extension.id, force: true })
  } else if (reason === 'startup') {
    emit('runtime.onStartup', [], { extensionId: extension.id, force: true })
  }
})

lifecycle.on('uninstalled', (extensionId) => {
  const url = getState<string | undefined>(extensionId, 'uninstallUrl', undefined)
  if (url) openOrFocus(url)
})
