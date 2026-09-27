import { nativeImage, type NativeImage } from 'electron'
import { join, normalize, sep } from 'node:path'
import { IPC } from '@shared/api'
import type { Rect, ToolbarExtension } from '@shared/types'
import { browserEvents } from '../../browser-events'
import { BrowserWindowController } from '../../window'
import { allLoadedExtensions, grantActiveTab, loadedExtension, manifestOf } from '../access'
import { lifecycle } from '../lifecycle'
import { extensionDisplay, extensionFolder } from '../manager'
import { openActionPopup } from '../popup'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../router'
import { getState, setState } from '../state'
import { chromeTabId, currentWindow, findTab, resolveWindow, toChromeTab } from '../tabs-model'
import { openSidePanel, panelOpensOnActionClick } from './side-panel'

/**
 * chrome.action and the extension buttons in the toolbar: each extension's icon, title, badge
 * and popup (globally or per tab), what happens when you click it, and which buttons are pinned.
 */

type Color = [number, number, number, number]

interface ActionState {
  title?: string
  popup?: string
  /** data: URL for the toolbar. */
  icon?: string | null
  badgeText?: string
  badgeColor?: Color
  badgeTextColor?: Color
  enabled?: boolean
}

interface ActionManifest {
  default_title?: string
  default_popup?: string
  default_icon?: string | Record<string, string>
}

const DEFAULT_BADGE_COLOR: Color = [95, 99, 104, 255]

const globalState = new Map<string, ActionState>()
const tabState = new Map<string, Map<number, ActionState>>()
/** Counts from declarativeNetRequest's displayActionCountAsBadgeText, by extension and tab. */
const ruleBadges = new Map<string, Map<number, string>>()

function manifestAction(id: string): ActionManifest | null {
  const m = manifestOf(id)
  return (m?.action as ActionManifest | undefined) ?? null
}

// ---- icons ----

const iconCache = new Map<string, string | null>()

/** Picks the file closest to 32px (a 16px button on a 2x screen) from an icon path or size map. */
function pickIconPath(icon: string | Record<string, string> | undefined): string | null {
  if (!icon) return null
  if (typeof icon === 'string') return icon
  const sizes = Object.keys(icon)
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const size = sizes.find((n) => n >= 32) ?? sizes.at(-1)
  return size ? icon[String(size)] : null
}

function iconFromFile(extensionId: string, path: string): string | null {
  const key = `${extensionId}:${path}`
  if (iconCache.has(key)) return iconCache.get(key)!
  const folder = extensionFolder(extensionId)
  let url: string | null = null
  if (folder) {
    const file = normalize(join(folder, path.replace(/^\/+/, '')))
    if (file.startsWith(folder + sep)) {
      const image = nativeImage.createFromPath(file)
      if (!image.isEmpty()) url = image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
    }
  }
  iconCache.set(key, url)
  return url
}

function defaultIcon(extensionId: string): string | null {
  const fromAction = pickIconPath(manifestAction(extensionId)?.default_icon)
  if (fromAction) {
    const url = iconFromFile(extensionId, fromAction)
    if (url) return url
  }
  const icons = manifestOf(extensionId)?.icons as Record<string, string> | undefined
  const fromIcons = pickIconPath(icons)
  return (fromIcons && iconFromFile(extensionId, fromIcons)) || (extensionDisplay(extensionId)?.icon ?? null)
}

interface PlainImageData {
  width: number
  height: number
  data: number[]
}

function imageFromData(data: PlainImageData): NativeImage | null {
  const { width, height } = data
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.data?.length !== width * height * 4) return null
  // ImageData is RGBA; Electron's bitmaps are BGRA.
  const buffer = Buffer.alloc(width * height * 4)
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = data.data[i + 2]
    buffer[i + 1] = data.data[i + 1]
    buffer[i + 2] = data.data[i]
    buffer[i + 3] = data.data[i + 3]
  }
  return nativeImage.createFromBitmap(buffer, { width, height })
}

/**
 * An icon path as extensions write it: relative to the calling script or page, root-relative, or a
 * full chrome-extension:// URL of its own. Returns the path inside the extension's folder.
 */
function extensionPath(extensionId: string, path: string, base: string): string | null {
  try {
    const url = new URL(path, base.startsWith(`chrome-extension://${extensionId}/`) ? base : `chrome-extension://${extensionId}/`)
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId ? decodeURIComponent(url.pathname) : null
  } catch {
    return null
  }
}

function iconFromDetails(extensionId: string, details: Record<string, unknown>, base: string): string | null {
  const imageData = details.imageData as PlainImageData | Record<string, PlainImageData> | undefined
  if (imageData) {
    const single = typeof (imageData as PlainImageData).width === 'number'
    let chosen: PlainImageData | undefined = single ? (imageData as PlainImageData) : undefined
    if (!single) {
      const map = imageData as Record<string, PlainImageData>
      const sizes = Object.keys(map)
        .map(Number)
        .sort((a, b) => a - b)
      chosen = map[String(sizes.find((n) => n >= 32) ?? sizes.at(-1))]
    }
    const image = chosen ? imageFromData(chosen) : null
    if (!image) throw new ExtensionError('Icon invalid.')
    return image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
  }
  const path = pickIconPath(details.path as string | Record<string, string> | undefined)
  if (path) {
    const file = extensionPath(extensionId, path, base)
    const url = file ? iconFromFile(extensionId, file) : null
    if (!url) throw new ExtensionError(`Failed to set icon '${path}': file not found or not an image.`)
    return url
  }
  throw new ExtensionError('Either path or imageData must be specified.')
}

// ---- colors ----

function parseColor(value: unknown): Color {
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a = 255] = value.map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))))
    return [r, g, b, a]
  }
  if (typeof value === 'string') {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim())?.[1]
    if (hex) {
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
      const n = (i: number): number => parseInt(full.slice(i, i + 2), 16)
      return [n(0), n(2), n(4), full.length >= 8 ? n(6) : 255]
    }
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(value.trim())
    if (rgb) {
      const alpha = rgb[4] === undefined ? 255 : Math.round(Math.min(1, Number(rgb[4])) * 255)
      return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha]
    }
    const named: Record<string, Color> = {
      red: [255, 0, 0, 255],
      green: [0, 128, 0, 255],
      blue: [0, 0, 255, 255],
      black: [0, 0, 0, 255],
      white: [255, 255, 255, 255],
      gray: [128, 128, 128, 255],
      grey: [128, 128, 128, 255],
      orange: [255, 165, 0, 255],
      yellow: [255, 255, 0, 255],
      purple: [128, 0, 128, 255],
      transparent: [0, 0, 0, 0]
    }
    const color = named[value.trim().toLowerCase()]
    if (color) return color
  }
  throw new ExtensionError('The color specification could not be parsed.')
}

const css = ([r, g, b, a]: Color): string => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`

/** Chrome picks white or black badge text for contrast unless the extension sets it. */
function autoTextColor([r, g, b]: Color): Color {
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? [0, 0, 0, 255] : [255, 255, 255, 255]
}

// ---- state ----

function globalFor(id: string): ActionState {
  let s = globalState.get(id)
  if (!s) globalState.set(id, (s = {}))
  return s
}

function stateFor(id: string, tabId: number | undefined): ActionState {
  const base = globalFor(id)
  const manifest = manifestAction(id)
  const perTab = tabId !== undefined ? tabState.get(id)?.get(tabId) : undefined
  const pick = <K extends keyof ActionState>(key: K): ActionState[K] => (perTab && perTab[key] !== undefined ? perTab[key] : base[key])
  return {
    title: pick('title') ?? manifest?.default_title ?? extensionDisplay(id)?.name ?? '',
    popup: pick('popup') ?? manifest?.default_popup ?? '',
    icon: pick('icon') ?? defaultIcon(id),
    badgeText: pick('badgeText') ?? '',
    badgeColor: pick('badgeColor') ?? DEFAULT_BADGE_COLOR,
    badgeTextColor: pick('badgeTextColor'),
    enabled: pick('enabled') ?? true
  }
}

function setValue<K extends keyof ActionState>(id: string, details: unknown, key: K, value: ActionState[K]): void {
  const tabId = (details as { tabId?: unknown } | undefined)?.tabId
  if (typeof tabId === 'number') {
    if (!findTab(tabId)) throw new ExtensionError(`No tab with id: ${tabId}.`)
    let perExt = tabState.get(id)
    if (!perExt) tabState.set(id, (perExt = new Map()))
    const s = perExt.get(tabId) ?? {}
    s[key] = value
    perExt.set(tabId, s)
  } else {
    globalFor(id)[key] = value
  }
  scheduleToolbar()
}

function tabArg(details: unknown): number | undefined {
  const tabId = (details as { tabId?: unknown } | undefined)?.tabId
  return typeof tabId === 'number' ? tabId : undefined
}

export function isPinned(id: string): boolean {
  return getState<boolean>(id, 'pinned', manifestOf(id)?.action !== undefined)
}

export function setPinned(id: string, pinned: boolean): void {
  if (isPinned(id) === pinned) return
  setState(id, 'pinned', pinned)
  emit('action.onUserSettingsChanged', [{ isOnToolbar: pinned }], { extensionId: id })
  scheduleToolbar()
}

/** The popup page to open for a tab, or null. */
function popupUrl(id: string, tabId: number | undefined): string | null {
  const extension = loadedExtension(id)
  const popup = stateFor(id, tabId).popup
  if (!extension || !popup) return null
  try {
    return new URL(popup, extension.url).href
  } catch {
    return null
  }
}

export function setRuleCountBadge(extensionId: string, tabId: number, text: string | null): void {
  let perExt = ruleBadges.get(extensionId)
  if (!perExt) ruleBadges.set(extensionId, (perExt = new Map()))
  if (text) perExt.set(tabId, text)
  else perExt.delete(tabId)
  scheduleToolbar()
}

// ---- toolbar ----

export function toolbarFor(c: BrowserWindowController): ToolbarExtension[] {
  const tab = c.activeTab
  const tabId = tab ? chromeTabId(tab) : undefined
  return allLoadedExtensions()
    .filter((e) => e.url.startsWith('chrome-extension://'))
    .map((extension) => {
      const id = extension.id
      const s = stateFor(id, tabId)
      const badge = s.badgeText || (tabId !== undefined ? (ruleBadges.get(id)?.get(tabId) ?? '') : '')
      const color = s.badgeColor ?? DEFAULT_BADGE_COLOR
      return {
        id,
        name: extensionDisplay(id)?.name ?? extension.name,
        icon: s.icon ?? null,
        title: s.title ?? extension.name,
        badgeText: badge.slice(0, 4),
        badgeColor: css(color),
        badgeTextColor: css(s.badgeTextColor ?? autoTextColor(color)),
        enabled: s.enabled !== false,
        pinned: isPinned(id)
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const lastSent = new WeakMap<BrowserWindowController, string>()
let toolbarTimer: NodeJS.Timeout | null = null

export function scheduleToolbar(): void {
  if (toolbarTimer) return
  toolbarTimer = setTimeout(() => {
    toolbarTimer = null
    for (const c of BrowserWindowController.all) {
      if (c.win.isDestroyed()) continue
      const list = toolbarFor(c)
      const json = JSON.stringify(list)
      if (lastSent.get(c) === json) continue
      lastSent.set(c, json)
      c.win.webContents.send(IPC.extensionsToolbar, list)
    }
  }, 30)
}

/** The extension's toolbar button (or its entry in the extensions menu) was clicked. */
export function activateAction(c: BrowserWindowController, id: string, anchor: Rect): void {
  const tab = c.activeTab
  if (!tab || !loadedExtension(id)) return
  const tabId = chromeTabId(tab)
  const s = stateFor(id, tabId)
  if (s.enabled === false) return
  grantActiveTab(id, tabId)
  if (panelOpensOnActionClick(id)) {
    try {
      openSidePanel(c, id)
    } catch {
      // Turned off for this tab.
    }
    return
  }
  const popup = popupUrl(id, tabId)
  if (popup) {
    openActionPopup({ controller: c, extensionId: id, url: popup, anchor, tabId })
    return
  }
  if (manifestOf(id)?.action !== undefined) {
    emit('action.onClicked', (extensionId) => [toChromeTab(tab, c, extensionId)], { extensionId: id, force: true })
  }
}

function requireWindow(call: CallContext, windowId: unknown): BrowserWindowController {
  const c = typeof windowId === 'number' ? resolveWindow(windowId, call) : currentWindow(call)
  if (!c) throw new ExtensionError(`No window with id: ${String(windowId)}.`)
  return c
}

defineApi('action', {
  manifestKey: 'action',
  methods: {
    setIcon: (call, details) =>
      setValue(call.extensionId, details, 'icon', iconFromDetails(call.extensionId, (details ?? {}) as Record<string, unknown>, call.context.url)),
    setTitle: (call, details) => setValue(call.extensionId, details, 'title', String((details as { title?: unknown })?.title ?? '')),
    getTitle: (call, details) => stateFor(call.extensionId, tabArg(details)).title,
    setPopup: (call, details) => {
      const popup = String((details as { popup?: unknown })?.popup ?? '')
      setValue(call.extensionId, details, 'popup', popup)
    },
    getPopup: (call, details) => popupUrl(call.extensionId, tabArg(details)) ?? '',
    setBadgeText: (call, details) => {
      const text = (details as { text?: unknown })?.text
      setValue(call.extensionId, details, 'badgeText', typeof text === 'string' ? text : '')
    },
    getBadgeText: (call, details) => stateFor(call.extensionId, tabArg(details)).badgeText,
    setBadgeBackgroundColor: (call, details) => setValue(call.extensionId, details, 'badgeColor', parseColor((details as { color?: unknown })?.color)),
    getBadgeBackgroundColor: (call, details) => stateFor(call.extensionId, tabArg(details)).badgeColor,
    setBadgeTextColor: (call, details) => setValue(call.extensionId, details, 'badgeTextColor', parseColor((details as { color?: unknown })?.color)),
    getBadgeTextColor: (call, details) => {
      const s = stateFor(call.extensionId, tabArg(details))
      return s.badgeTextColor ?? autoTextColor(s.badgeColor ?? DEFAULT_BADGE_COLOR)
    },
    enable: (call, tabId) => setValue(call.extensionId, typeof tabId === 'number' ? { tabId } : undefined, 'enabled', true),
    disable: (call, tabId) => setValue(call.extensionId, typeof tabId === 'number' ? { tabId } : undefined, 'enabled', false),
    isEnabled: (call, tabId) => stateFor(call.extensionId, typeof tabId === 'number' ? tabId : undefined).enabled !== false,
    getUserSettings: (call) => ({ isOnToolbar: isPinned(call.extensionId) }),
    openPopup: (call, options) => {
      const c = requireWindow(call, (options as { windowId?: unknown } | undefined)?.windowId)
      const tab = c.activeTab
      if (!tab || !popupUrl(call.extensionId, chromeTabId(tab))) throw new ExtensionError('Extension does not have a popup on the active tab.')
      // The browser UI knows where the button is; it opens the popup from there.
      c.sendCommand({ type: 'open-extension-popup', extensionId: call.extensionId })
    }
  }
})

defineEvent('action.onClicked')
defineEvent('action.onUserSettingsChanged')

lifecycle.on('loaded', () => scheduleToolbar())
lifecycle.on('unloaded', (id) => {
  globalState.delete(id)
  tabState.delete(id)
  ruleBadges.delete(id)
  for (const key of [...iconCache.keys()]) if (key.startsWith(`${id}:`)) iconCache.delete(key)
  scheduleToolbar()
})
browserEvents.on('window-state', () => scheduleToolbar())
browserEvents.on('window-created', () => scheduleToolbar())
browserEvents.on('tab-closed', (tab) => {
  const tabId = chromeTabId(tab)
  for (const perExt of tabState.values()) perExt.delete(tabId)
  for (const perExt of ruleBadges.values()) perExt.delete(tabId)
})
