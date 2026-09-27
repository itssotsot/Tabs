import { searchUrl } from '@shared/url'
import { store } from '../../../store'
import { BrowserWindowController } from '../../../window'
import { defineApi, ExtensionError, type CallContext } from '../../router'
import { currentWindow, findTab } from '../../tabs-model'
import { isNumber, isObject, isString } from './util'

/** chrome.search: a search with the search engine picked in settings. */

function query(call: CallContext, queryInfo: unknown): void {
  const q = isObject(queryInfo) ? queryInfo : {}
  if (!isString(q.text) || !q.text.trim()) throw new ExtensionError('Empty text parameter.')
  if (q.disposition !== undefined && q.tabId !== undefined) throw new ExtensionError('Cannot set both "disposition" and "tabId".')
  const url = searchUrl(q.text, store.settings.searchEngine)
  if (q.tabId !== undefined) {
    const found = isNumber(q.tabId) ? findTab(q.tabId) : null
    if (!found) throw new ExtensionError(`No tab with id: ${String(q.tabId)}.`)
    found.tab.load(url)
    return
  }
  const disposition = q.disposition ?? 'CURRENT_TAB'
  if (disposition === 'NEW_WINDOW') {
    new BrowserWindowController({ urls: [url] }).focus()
    return
  }
  if (disposition !== 'CURRENT_TAB' && disposition !== 'NEW_TAB') throw new ExtensionError(`Invalid disposition: ${String(disposition)}.`)
  const c = currentWindow(call)
  if (!c) {
    new BrowserWindowController({ urls: [url] })
    return
  }
  const active = c.activeTab
  if (disposition === 'NEW_TAB' || !active) c.createTab(url)
  else active.load(url)
}

defineApi('search', {
  permissions: ['search'],
  methods: { query }
})
