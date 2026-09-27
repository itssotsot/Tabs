import type { Bookmark } from '@shared/types'
import { bookmarksChanged } from '../../../broadcast'
import { store, storeEvents } from '../../../store'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError } from '../../router'
import { getGlobalState, setGlobalState } from '../../state'
import { diffBookmarks, type BookmarkChange, type SeenBookmark as Seen } from './bookmark-diff'
import { isNumber, isObject, isString } from './util'

/**
 * chrome.bookmarks over the app's bookmarks, which are one flat list. Extensions see Chrome's
 * tree: the root "0" with "Bookmarks bar" ("1"), holding the app's bookmarks, and "Other
 * bookmarks" ("2"), always empty. There are no other folders. Bookmarks get Chrome-style numeric
 * ids, remembered per app bookmark. Changes from either side fire the events: the list is diffed
 * after every change.
 */

type Node = chrome.bookmarks.BookmarkTreeNode

const ROOT_ID = '0'
const BAR_ID = '1'
const OTHER_ID = '2'
const FIRST_ID = 5
const NO_FOLDERS = 'Folders are not supported in this browser: bookmarks can only go in the Bookmarks bar ("1").'
const ROOTS = "Can't modify the root bookmark folders."

interface Ids {
  /** App bookmark id -> Chrome id. */
  byApp: Record<string, string>
  next: number
}

function ids(): Ids {
  return getGlobalState<Ids>('bookmarkIds', { byApp: {}, next: FIRST_ID })
}

function chromeId(bookmark: Bookmark): string {
  const state = ids()
  let id = state.byApp[bookmark.id]
  if (!id) {
    id = String(state.next++)
    state.byApp[bookmark.id] = id
    setGlobalState('bookmarkIds', state)
  }
  return id
}

/** Forgets the ids of bookmarks that are gone (after their removal was reported). */
function pruneIds(): void {
  const state = ids()
  const live = new Set(store.bookmarks.map((b) => b.id))
  const stale = Object.keys(state.byApp).filter((appId) => !live.has(appId))
  if (!stale.length) return
  for (const appId of stale) delete state.byApp[appId]
  setGlobalState('bookmarkIds', state)
}

function findByChromeId(id: string): { bookmark: Bookmark; index: number } | null {
  const byApp = ids().byApp
  const index = store.bookmarks.findIndex((b) => byApp[b.id] === id)
  return index === -1 ? null : { bookmark: store.bookmarks[index], index }
}

/** When the bar last changed, for dateGroupModified. */
let barModified = Date.now()

function bookmarkNode(bookmark: Bookmark, index: number): Node {
  return {
    id: chromeId(bookmark),
    parentId: BAR_ID,
    index,
    url: bookmark.url,
    title: bookmark.title,
    dateAdded: bookmark.createdAt,
    syncing: false
  } as Node
}

function folderNode(id: string, withChildren: boolean): Node {
  const common = { dateAdded: 0, syncing: false }
  if (id === ROOT_ID) {
    const node = { id, title: '', ...common } as Node
    if (withChildren) node.children = [folderNode(BAR_ID, true), folderNode(OTHER_ID, true)]
    return node
  }
  const bar = id === BAR_ID
  const node = {
    id,
    parentId: ROOT_ID,
    index: bar ? 0 : 1,
    title: bar ? 'Bookmarks bar' : 'Other bookmarks',
    folderType: bar ? 'bookmarks-bar' : 'other',
    dateGroupModified: bar ? barModified : 0,
    ...common
  } as Node
  if (withChildren) node.children = bar ? store.bookmarks.map(bookmarkNode) : []
  return node
}

function nodeFor(id: unknown, withChildren = false): Node {
  if (!isString(id)) throw new ExtensionError("Can't find bookmark for id.")
  if (id === ROOT_ID || id === BAR_ID || id === OTHER_ID) return folderNode(id, withChildren)
  const found = findByChromeId(id)
  if (!found) throw new ExtensionError("Can't find bookmark for id.")
  return bookmarkNode(found.bookmark, found.index)
}

const isFolder = (id: string): boolean => id === ROOT_ID || id === BAR_ID || id === OTHER_ID

// ---- events: diff the list after every change ----

let seen: Seen[] | null = null
/** True while this module changes the list itself and reports the change exactly. */
let applying = false

function current(): Seen[] {
  return store.bookmarks.map((b) => ({ id: chromeId(b), url: b.url, title: b.title }))
}

function report(change: BookmarkChange): void {
  const found = findByChromeId(change.id)
  switch (change.type) {
    case 'created':
      if (found) emit('bookmarks.onCreated', [change.id, bookmarkNode(found.bookmark, change.index ?? found.index)])
      break
    case 'removed': {
      const item = change.item!
      const node = { id: change.id, parentId: BAR_ID, index: change.index, url: item.url, title: item.title, syncing: false } as Node
      emit('bookmarks.onRemoved', [change.id, { parentId: BAR_ID, index: change.index, node }])
      break
    }
    case 'moved':
      emit('bookmarks.onMoved', [change.id, { parentId: BAR_ID, index: change.index, oldParentId: BAR_ID, oldIndex: change.oldIndex }])
      break
    case 'changed':
      emit('bookmarks.onChanged', [change.id, { title: change.item!.title, url: change.item!.url }])
      break
  }
}

function onListChanged(): void {
  if (applying) return
  const next = current()
  const before = seen
  seen = next
  if (!before) return
  const changes = diffBookmarks(before, next)
  if (changes.length) barModified = Date.now()
  for (const change of changes) report(change)
  pruneIds()
}

storeEvents.on('bookmarks-changed', onListChanged)

/** Changes the list from an extension call, then reports exactly that change and tells the app. */
function apply(fn: () => BookmarkChange): void {
  seen ??= current()
  applying = true
  let change: BookmarkChange
  try {
    change = fn()
  } finally {
    applying = false
  }
  seen = current()
  bookmarksChanged()
  barModified = Date.now()
  report(change)
  pruneIds()
}

// ---- API ----

function parentOf(parentId: unknown): void {
  if (parentId === undefined || parentId === BAR_ID) return
  if (parentId === ROOT_ID) throw new ExtensionError(ROOTS)
  if (parentId === OTHER_ID || isString(parentId)) throw new ExtensionError(NO_FOLDERS)
  throw new ExtensionError("Can't find parent bookmark for id.")
}

function checkUrl(url: unknown): string {
  if (!isString(url)) throw new ExtensionError(NO_FOLDERS)
  try {
    new URL(url)
  } catch {
    throw new ExtensionError('Invalid URL.')
  }
  if (/^javascript:/i.test(url)) throw new ExtensionError('Invalid URL.')
  return url
}

function create(_call: unknown, details: unknown): Node {
  const d = isObject(details) ? details : {}
  parentOf(d.parentId)
  const url = checkUrl(d.url)
  const title = isString(d.title) ? d.title : ''
  const index = isNumber(d.index) ? d.index : undefined
  if (index !== undefined && (index < 0 || index > store.bookmarks.length)) throw new ExtensionError('Index out of bounds.')
  let id = ''
  apply(() => {
    const created = store.addBookmark(url, title || url, index)
    id = chromeId(created)
    return { type: 'created', id, index: store.bookmarks.indexOf(created) }
  })
  return nodeFor(id)
}

function move(_call: unknown, id: unknown, destination: unknown): Node {
  if (isString(id) && isFolder(id)) throw new ExtensionError(ROOTS)
  const node = nodeFor(id)
  const d = isObject(destination) ? destination : {}
  parentOf(d.parentId)
  const from = node.index!
  // Chrome's index is where it goes among the folder's current children (itself included).
  let to = isNumber(d.index) ? d.index : store.bookmarks.length
  if (to < 0 || to > store.bookmarks.length) throw new ExtensionError('Index out of bounds.')
  if (to > from) to--
  if (to !== from) {
    apply(() => {
      store.moveBookmark(findByChromeId(node.id)!.bookmark.id, to)
      return { type: 'moved', id: node.id, index: to, oldIndex: from }
    })
  }
  return nodeFor(node.id)
}

function update(_call: unknown, id: unknown, changes: unknown): Node {
  if (isString(id) && isFolder(id)) throw new ExtensionError(ROOTS)
  const node = nodeFor(id)
  const c = isObject(changes) ? changes : {}
  const patch: { title?: string; url?: string } = {}
  if (isString(c.title)) patch.title = c.title
  if (c.url !== undefined) patch.url = checkUrl(c.url)
  if (Object.keys(patch).length && (patch.title !== node.title || (patch.url ?? node.url) !== node.url)) {
    apply(() => {
      store.updateBookmark(findByChromeId(node.id)!.bookmark.id, patch)
      return { type: 'changed', id: node.id, item: { id: node.id, title: patch.title ?? node.title, url: patch.url ?? node.url! } }
    })
  }
  return nodeFor(node.id)
}

function remove(_call: unknown, id: unknown): void {
  if (isString(id) && isFolder(id)) throw new ExtensionError(ROOTS)
  const node = nodeFor(id)
  apply(() => {
    store.removeBookmark(findByChromeId(node.id)!.bookmark.id)
    return { type: 'removed', id: node.id, index: node.index, item: { id: node.id, url: node.url!, title: node.title } }
  })
}

function search(_call: unknown, query: unknown): Node[] {
  const all = store.bookmarks.map(bookmarkNode)
  if (isString(query)) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return all.filter((n) => words.every((w) => `${n.url} ${n.title}`.toLowerCase().includes(w)))
  }
  if (!isObject(query)) throw new ExtensionError('Invalid query.')
  const words = isString(query.query) ? query.query.toLowerCase().split(/\s+/).filter(Boolean) : []
  // Folders have no URL, so "Bookmarks bar" and "Other bookmarks" match a title search.
  const folders = [folderNode(BAR_ID, false), folderNode(OTHER_ID, false)].filter((f) => {
    if (query.url !== undefined) return false
    if (isString(query.title) && f.title !== query.title) return false
    return words.every((w) => f.title.toLowerCase().includes(w)) && (words.length > 0 || isString(query.title))
  })
  const bookmarks = all.filter((n) => {
    if (isString(query.url) && n.url !== query.url) return false
    if (isString(query.title) && n.title !== query.title) return false
    return words.every((w) => `${n.url} ${n.title}`.toLowerCase().includes(w))
  })
  return [...folders, ...bookmarks]
}

function get(_call: unknown, idOrIds: unknown): Node[] {
  const list = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
  if (!list.length) throw new ExtensionError('Bookmark id list is empty.')
  return list.map((id) => nodeFor(id))
}

defineApi('bookmarks', {
  permissions: ['bookmarks'],
  methods: {
    get,
    getChildren: (_call, id) => {
      const node = nodeFor(id, true)
      if (node.url !== undefined) return []
      return (node.children ?? []).map((child) => ({ ...child, children: undefined }))
    },
    getRecent: (_call, numberOfItems) => {
      if (!isNumber(numberOfItems) || numberOfItems < 1) throw new ExtensionError('numberOfItems cannot be less than 1.')
      return store.bookmarks
        .map(bookmarkNode)
        .sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0))
        .slice(0, Math.floor(numberOfItems))
    },
    getTree: () => [folderNode(ROOT_ID, true)],
    getSubTree: (_call, id) => [nodeFor(id, true)],
    search,
    create,
    move,
    update,
    remove,
    removeTree: (call, id) => remove(call, id)
  }
})

for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded']) {
  defineEvent(`bookmarks.${name}`, { permissions: ['bookmarks'] })
}

// The first snapshot, so app changes before any extension call still fire events.
lifecycle.on('ready', () => {
  seen ??= current()
})
