import type { Extension, WebContents, WebFrameMain } from 'electron'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { hasActiveTabGrant, hasHostAccess } from '../../access'
import { ExtensionError, type CallContext } from '../../router'
import { findTab } from '../../tabs-model'
import { chromeFrameId, documentToken, isLive } from './frames'

/**
 * What the injection APIs share: which frames of which tab an InjectionTarget means, whether the
 * extension may touch them, reading script files from the extension, and the access rule of the
 * page-level APIs (debugger, pageCapture).
 */

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const ACCESS_DENIED = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'

/** The live page of a tab, or an API error. */
export function tabPage(tabId: unknown): { wc: WebContents; tabId: number } {
  const found = isNumber(tabId) ? findTab(tabId) : null
  if (!found) throw new ExtensionError(`No tab with id: ${String(tabId)}.`)
  const wc = found.tab.liveWc
  if (!wc || wc.isDestroyed()) throw new ExtensionError(`Cannot access contents of tab ${String(tabId)}: it is discarded.`)
  return { wc, tabId: tabId as number }
}

export interface TargetFrame {
  readonly frame: WebFrameMain
  readonly frameId: number
  /** The document's token (see frames.ts); null where the page-scripts preload doesn't run (about:blank…). */
  readonly documentId: string | null
  readonly url: string
  readonly origin: string
}

export function targetFrame(frame: WebFrameMain): TargetFrame {
  return { frame, frameId: chromeFrameId(frame), documentId: documentToken(frame), url: frame.url, origin: frame.origin }
}

/** The URL whose host decides access: a local document (about:blank, srcdoc, data:) counts as its origin. */
function accessUrl(f: TargetFrame): string {
  if (/^(about|data|blob):/i.test(f.url) && f.origin && f.origin !== 'null') return `${f.origin}/`
  return f.url
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Whether the extension may script a frame: host permissions, or activeTab for the tab's main frame
 * and subframes of the same origin.
 */
export function mayScriptFrame(extensionId: string, f: TargetFrame, main: TargetFrame, tabId: number): boolean {
  const url = accessUrl(f)
  if (hasHostAccess(extensionId, url)) return true
  if (!hasActiveTabGrant(extensionId, tabId)) return false
  const mainOrigin = originOf(accessUrl(main))
  return f.frame === main.frame || (!!mainOrigin && mainOrigin !== 'null' && originOf(url) === mainOrigin)
}

export interface ResolvedTarget {
  wc: WebContents
  tabId: number
  frames: TargetFrame[]
}

function framesOf(wc: WebContents): TargetFrame[] {
  try {
    return wc.mainFrame.framesInSubtree.filter(isLive).map(targetFrame)
  } catch {
    return []
  }
}

/**
 * The frames an InjectionTarget ({ tabId, frameIds?, documentIds?, allFrames? }) selects that the
 * extension may script and that we can run code in. Frames named explicitly must qualify;
 * allFrames skips the rest.
 */
export function resolveTarget(call: CallContext, target: unknown, deniedMessage = ACCESS_DENIED): ResolvedTarget {
  if (!isObject(target)) throw new ExtensionError('Invalid target.')
  const { wc, tabId } = tabPage(target.tabId)
  const frameIds = target.frameIds
  const documentIds = target.documentIds
  if (frameIds !== undefined && documentIds !== undefined) throw new ExtensionError("Cannot specify both 'frameIds' and 'documentIds'.")
  if (target.allFrames === true && (frameIds !== undefined || documentIds !== undefined)) {
    throw new ExtensionError("Cannot specify both 'allFrames' and 'frameIds' or 'documentIds'.")
  }
  const all = framesOf(wc)
  const main = all.find((f) => f.frameId === 0)
  if (!main) throw new ExtensionError(`Cannot access contents of tab ${tabId}.`)
  const usable = (f: TargetFrame): boolean => !!f.documentId && mayScriptFrame(call.extensionId, f, main, tabId)
  let frames: TargetFrame[]
  if (Array.isArray(frameIds)) {
    frames = frameIds.map((id) => {
      const f = all.find((x) => x.frameId === id)
      if (!f) throw new ExtensionError(`No frame with id ${String(id)} in tab with id ${tabId}.`)
      return f
    })
  } else if (Array.isArray(documentIds)) {
    frames = documentIds.map((id) => {
      const f = all.find((x) => x.documentId === id)
      if (!f) throw new ExtensionError(`No document with id ${String(id)} in tab with id ${tabId}.`)
      return f
    })
  } else if (target.allFrames === true) {
    if (!usable(main)) throw new ExtensionError(deniedMessage)
    return { wc, tabId, frames: all.filter(usable) }
  } else {
    frames = [main]
  }
  frames = [...new Set(frames)]
  if (frames.some((f) => !usable(f))) throw new ExtensionError(deniedMessage)
  return { wc, tabId, frames }
}

/** A file from the extension's folder, never outside it. */
export function readExtensionFile(extension: Extension, file: unknown): string {
  if (typeof file !== 'string' || !file) throw new ExtensionError('Invalid file.')
  const root = resolve(extension.path)
  const path = resolve(root, file.replace(/^[/\\]+/, ''))
  if (!path.startsWith(root + sep)) throw new ExtensionError(`Could not load file: '${file}'.`)
  try {
    return readFileSync(path, 'utf8').replace(/^﻿/, '')
  } catch {
    throw new ExtensionError(`Could not load file: '${file}'.`)
  }
}

const WEB_STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

/**
 * APIs whose permission alone covers every ordinary web page in Chrome (debugger, pageCapture):
 * host access, or an http(s) page that isn't the Web Store. Browser pages, other extensions'
 * pages and file URLs (without host access) are off limits.
 */
export function mayUsePageApi(extensionId: string, url: string, tabId: number): boolean {
  if (hasHostAccess(extensionId, url, tabId)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (url === 'about:blank') return true
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (WEB_STORE_HOSTS.has(parsed.hostname) && (parsed.hostname !== 'chrome.google.com' || parsed.pathname.startsWith('/webstore'))) return false
  return true
}
