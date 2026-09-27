import { nativeImage, type ContextMenuParams, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { Tab } from '../../tab'
import type { BrowserWindowController } from '../../window'
import { allLoadedExtensions, grantActiveTab } from '../access'
import { lifecycle } from '../lifecycle'
import { extensionDisplay } from '../manager'
import { matchesAny } from '../match-pattern'
import { defineApi, defineEvent, emit, ExtensionError } from '../router'
import { getState, setState } from '../state'
import { chromeTabId, toChromeTab } from '../tabs-model'

/**
 * chrome.contextMenus: items extensions add to the page's right-click menu and to their toolbar
 * button's menu. Items persist until the extension is updated or removed, like Chrome's.
 */

type ItemId = string | number
type ItemType = 'normal' | 'checkbox' | 'radio' | 'separator'

interface MenuItem {
  id: ItemId
  parentId?: ItemId
  title?: string
  type: ItemType
  checked: boolean
  enabled: boolean
  visible: boolean
  contexts: string[]
  documentUrlPatterns?: string[]
  targetUrlPatterns?: string[]
}

const CONTEXTS = new Set(['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action'])
const MAX_TOP_LEVEL_IN_ACTION = 6

const menus = new Map<string, MenuItem[]>()

function itemsOf(id: string): MenuItem[] {
  let list = menus.get(id)
  if (!list) {
    list = getState<MenuItem[]>(id, 'contextMenus', [])
    menus.set(id, list)
  }
  return list
}

function save(id: string): void {
  setState(id, 'contextMenus', menus.get(id) ?? [])
}

function sameId(a: ItemId | undefined, b: ItemId | undefined): boolean {
  return a !== undefined && b !== undefined && String(a) === String(b) && typeof a === typeof b
}

function validate(props: Record<string, unknown>, list: MenuItem[], existing?: MenuItem): Partial<MenuItem> {
  const out: Partial<MenuItem> = {}
  if (props.type !== undefined) {
    if (!['normal', 'checkbox', 'radio', 'separator'].includes(props.type as string)) throw new ExtensionError(`Invalid type: ${String(props.type)}`)
    out.type = props.type as ItemType
  }
  if (props.title !== undefined) out.title = String(props.title)
  if (typeof props.checked === 'boolean') out.checked = props.checked
  if (typeof props.enabled === 'boolean') out.enabled = props.enabled
  if (typeof props.visible === 'boolean') out.visible = props.visible
  if (props.contexts !== undefined) {
    const contexts = (Array.isArray(props.contexts) ? props.contexts : [props.contexts]).map(String)
    for (const c of contexts) if (!CONTEXTS.has(c)) throw new ExtensionError(`Invalid context: ${c}`)
    out.contexts = contexts.map((c) => (c === 'browser_action' || c === 'page_action' ? 'action' : c))
  }
  for (const key of ['documentUrlPatterns', 'targetUrlPatterns'] as const) {
    if (props[key] !== undefined) {
      const patterns = (props[key] as unknown[]).map(String)
      for (const p of patterns) {
        if (p !== '<all_urls>' && !/^(\*|[a-z][a-z0-9+.-]*):\/\//i.test(p)) throw new ExtensionError(`Invalid url pattern '${p}'`)
      }
      out[key] = patterns
    }
  }
  if (props.parentId !== undefined) {
    const parent = list.find((i) => sameId(i.id, props.parentId as ItemId))
    if (!parent) throw new ExtensionError(`Cannot find menu item with id ${String(props.parentId)}`)
    // An item can't become its own ancestor.
    for (let p: MenuItem | undefined = parent; p; p = list.find((i) => sameId(i.id, p!.parentId))) {
      if (existing && sameId(p.id, existing.id)) throw new ExtensionError('Cannot set a menu item to be a child of itself or its descendants.')
    }
    out.parentId = props.parentId as ItemId
  }
  const type = out.type ?? existing?.type ?? 'normal'
  const title = out.title ?? existing?.title
  if (type !== 'separator' && !title) throw new ExtensionError('Title is required for non-separator menu items.')
  return out
}

function descendants(list: MenuItem[], id: ItemId): Set<string> {
  const out = new Set<string>([String(id)])
  let grew = true
  while (grew) {
    grew = false
    for (const item of list) {
      if (item.parentId !== undefined && out.has(String(item.parentId)) && !out.has(String(item.id))) {
        out.add(String(item.id))
        grew = true
      }
    }
  }
  return out
}

defineApi('contextMenus', {
  permissions: ['contextMenus'],
  methods: {
    create: (call, props) => {
      const p = (props ?? {}) as Record<string, unknown>
      const list = itemsOf(call.extensionId)
      const id = p.id as ItemId
      if (id === undefined || id === null) throw new ExtensionError('Missing id.')
      if (list.some((i) => sameId(i.id, id))) throw new ExtensionError(`Cannot create item with duplicate id ${String(id)}`)
      const fields = validate(p, list)
      list.push({ id, type: 'normal', checked: false, enabled: true, visible: true, contexts: ['page'], ...fields })
      save(call.extensionId)
      return id
    },
    update: (call, id, props) => {
      const list = itemsOf(call.extensionId)
      const item = list.find((i) => sameId(i.id, id as ItemId))
      if (!item) throw new ExtensionError(`Cannot find menu item with id ${String(id)}`)
      Object.assign(item, validate((props ?? {}) as Record<string, unknown>, list, item))
      save(call.extensionId)
    },
    remove: (call, id) => {
      const list = itemsOf(call.extensionId)
      if (!list.some((i) => sameId(i.id, id as ItemId))) throw new ExtensionError(`Cannot find menu item with id ${String(id)}`)
      const gone = descendants(list, id as ItemId)
      menus.set(call.extensionId, list.filter((i) => !gone.has(String(i.id))))
      save(call.extensionId)
    },
    removeAll: (call) => {
      menus.set(call.extensionId, [])
      save(call.extensionId)
    }
  }
})

defineEvent('contextMenus.onClicked', { permissions: ['contextMenus'] })

// Chrome drops an extension's items when it's updated or reinstalled; it recreates them in onInstalled.
lifecycle.on('loaded', (extension, reason) => {
  if (reason === 'install' || reason === 'update') {
    menus.set(extension.id, [])
    save(extension.id)
  }
})
lifecycle.on('unloaded', (id) => menus.delete(id))

// ---- building menus ----

/** What was right-clicked, in Chrome's terms. */
interface ClickContext {
  contexts: Set<string>
  pageUrl: string
  frameUrl?: string
  frameId: number
  linkUrl?: string
  srcUrl?: string
  mediaType?: 'image' | 'video' | 'audio'
  selectionText?: string
  editable: boolean
}

function clickContext(tab: Tab, p: ContextMenuParams): ClickContext {
  const contexts = new Set<string>(['all'])
  if (p.linkURL) contexts.add('link')
  if (p.selectionText.trim()) contexts.add('selection')
  if (p.isEditable) contexts.add('editable')
  if (p.mediaType === 'image' || p.mediaType === 'video' || p.mediaType === 'audio') contexts.add(p.mediaType)
  const inFrame = !!p.frameURL && p.frameURL !== p.pageURL
  if (inFrame) contexts.add('frame')
  // "page" is a click on the page itself, not on a link, selection, field or media.
  if (![...contexts].some((c) => c !== 'all' && c !== 'frame')) contexts.add('page')
  const frame = p.frame
  return {
    contexts,
    pageUrl: p.pageURL || tab.url,
    frameUrl: inFrame ? p.frameURL : undefined,
    frameId: frame && frame.parent ? frame.frameTreeNodeId : 0,
    linkUrl: p.linkURL || undefined,
    srcUrl: p.srcURL || undefined,
    mediaType: p.mediaType === 'image' || p.mediaType === 'video' || p.mediaType === 'audio' ? p.mediaType : undefined,
    selectionText: p.selectionText.trim() || undefined,
    editable: p.isEditable
  }
}

/** Only top-level items are matched by context; a matching parent shows all its children. */
function visibleIn(item: MenuItem, click: ClickContext, topLevel: boolean): boolean {
  if (!item.visible) return false
  const matchesContext = item.contexts.some((c) => (c === 'all' ? !click.contexts.has('action') : click.contexts.has(c)))
  if (topLevel && !matchesContext) return false
  if (item.documentUrlPatterns && !matchesAny(item.documentUrlPatterns, click.frameUrl ?? click.pageUrl)) return false
  if (item.targetUrlPatterns) {
    const target = click.linkUrl ?? click.srcUrl
    if (target && !matchesAny(item.targetUrlPatterns, target)) return false
  }
  return true
}

function menuIcon(extensionId: string): NativeImage | undefined {
  const icon = extensionDisplay(extensionId)?.icon
  if (!icon) return undefined
  const image = nativeImage.createFromDataURL(icon)
  return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16, quality: 'best' })
}

function titleOf(item: MenuItem, click: ClickContext): string {
  const selection = (click.selectionText ?? '').replace(/\s+/g, ' ')
  const short = selection.length > 30 ? `${selection.slice(0, 29)}…` : selection
  return (item.title ?? '').replace(/%s/g, short).replace(/&/g, '&&')
}

function onClick(extensionId: string, item: MenuItem, list: MenuItem[], click: ClickContext, tab: Tab | null, c: BrowserWindowController): void {
  const wasChecked = item.checked
  if (item.type === 'checkbox') item.checked = !item.checked
  if (item.type === 'radio') {
    // Radio items form a group with their adjacent radio siblings.
    const siblings = list.filter((i) => sameId(i.parentId, item.parentId) || (i.parentId === undefined && item.parentId === undefined))
    const index = siblings.indexOf(item)
    let start = index
    while (start > 0 && siblings[start - 1].type === 'radio') start--
    let end = index
    while (end < siblings.length - 1 && siblings[end + 1].type === 'radio') end++
    for (let i = start; i <= end; i++) siblings[i].checked = siblings[i] === item
  }
  if (item.type === 'checkbox' || item.type === 'radio') save(extensionId)
  const info: Record<string, unknown> = {
    menuItemId: item.id,
    editable: click.editable,
    pageUrl: click.pageUrl,
    frameId: click.frameId
  }
  if (item.parentId !== undefined) info.parentMenuItemId = item.parentId
  if (click.frameUrl) info.frameUrl = click.frameUrl
  if (click.linkUrl) info.linkUrl = click.linkUrl
  if (click.srcUrl) info.srcUrl = click.srcUrl
  if (click.mediaType) info.mediaType = click.mediaType
  if (click.selectionText) info.selectionText = click.selectionText
  if (item.type === 'checkbox' || item.type === 'radio') {
    info.wasChecked = wasChecked
    info.checked = item.checked
  }
  if (tab) grantActiveTab(extensionId, chromeTabId(tab))
  emit('contextMenus.onClicked', (id) => [info, tab ? toChromeTab(tab, c, id) : undefined], { extensionId, force: true })
}

function buildItems(extensionId: string, list: MenuItem[], parentId: ItemId | undefined, click: ClickContext, tab: Tab | null, c: BrowserWindowController): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of list) {
    if (parentId === undefined ? item.parentId !== undefined : !sameId(item.parentId, parentId)) continue
    if (!visibleIn(item, click, parentId === undefined)) continue
    if (item.type === 'separator') {
      out.push({ type: 'separator' })
      continue
    }
    const children = buildItems(extensionId, list, item.id, click, tab, c)
    const option: MenuItemConstructorOptions = { label: titleOf(item, click), enabled: item.enabled }
    if (children.length) option.submenu = children
    else {
      if (item.type === 'checkbox' || item.type === 'radio') {
        option.type = item.type
        option.checked = item.checked
      }
      option.click = () => onClick(extensionId, item, list, click, tab, c)
    }
    out.push(option)
  }
  // No separators at the ends or doubled up.
  return out.filter((o, i, all) => o.type !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1].type !== 'separator'))
}

/** Items from every extension for a right-click on a page: one entry per extension, a submenu if it has several. */
export function extensionPageMenuItems(c: BrowserWindowController, tab: Tab, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const click = clickContext(tab, params)
  const out: MenuItemConstructorOptions[] = []
  for (const { id: extensionId } of allLoadedExtensions()) {
    const items = buildItems(extensionId, itemsOf(extensionId), undefined, click, tab, c)
    if (!items.length) continue
    const icon = menuIcon(extensionId)
    if (items.length === 1 && !items[0].submenu && items[0].type !== 'separator') out.push({ ...items[0], icon })
    else out.push({ label: (extensionDisplay(extensionId)?.name ?? extensionId).replace(/&/g, '&&'), icon, submenu: items })
  }
  return out
}

/** An extension's items for right-clicking its toolbar button (contexts: action), at most six at the top. */
export function extensionActionMenuItems(extensionId: string, c: BrowserWindowController): MenuItemConstructorOptions[] {
  const tab = c.activeTab
  const click: ClickContext = { contexts: new Set(['action']), pageUrl: tab?.url ?? '', frameId: 0, editable: false }
  const list = itemsOf(extensionId).filter((i) => i.contexts.includes('action') || i.parentId !== undefined)
  return buildItems(extensionId, list, undefined, click, tab, c).slice(0, MAX_TOP_LEVEL_IN_ACTION)
}
