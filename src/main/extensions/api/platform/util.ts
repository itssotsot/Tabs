import { nativeImage, type NativeImage, type Session } from 'electron'
import { readFile } from 'node:fs/promises'
import { normalize, sep } from 'node:path'
import type { CallContext } from '../../router'
import { ExtensionError } from '../../router'

/** Small helpers shared by the platform API modules. */

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const asObject = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {})

/** Second-level labels under which registrations happen one level deeper (example.co.uk). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'gob', 'mil', 'nom', 'sch', 'ltd', 'plc'])

/**
 * The registrable domain ("site") of a host, approximated without the Public Suffix List:
 * the last two labels, or three under common second-level labels of country domains.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2
  return labels.slice(-take).join('.')
}

/** `scheme://registrable-domain`, Chrome's notion of a site for partitioning. */
export function siteOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.hostname) return null
    return `${u.protocol}//${registrableDomain(u.hostname)}`
  } catch {
    return null
  }
}

/** Whether two URLs are cross-site (different scheme or registrable domain). */
export function isCrossSite(a: string, b: string): boolean {
  const sa = siteOf(a)
  const sb = siteOf(b)
  return !sa || !sb || sa !== sb
}

/** Resolves a URL an extension passed (relative ones are its own files). */
export function resolveUrl(call: CallContext, url: string): string {
  return new URL(url, call.extension.url).href
}

/**
 * Loads an image an extension refers to: its own files, data: URLs, or http(s) URLs (fetched
 * through the web session). Returns null when it can't be loaded.
 */
export async function loadImage(call: CallContext, url: string | undefined, ses: Session | null): Promise<NativeImage | null> {
  if (!url || typeof url !== 'string') return null
  try {
    if (url.startsWith('data:')) {
      const image = nativeImage.createFromDataURL(url)
      return image.isEmpty() ? null : image
    }
    const resolved = new URL(url, call.extension.url)
    if (resolved.protocol === 'chrome-extension:') {
      if (resolved.host !== call.extensionId) return null
      const root = normalize(call.extension.path)
      const file = normalize(`${root}${sep}${decodeURIComponent(resolved.pathname)}`)
      if (!file.startsWith(root + sep)) return null
      const image = nativeImage.createFromBuffer(await readFile(file))
      return image.isEmpty() ? null : image
    }
    if ((resolved.protocol === 'https:' || resolved.protocol === 'http:') && ses) {
      const response = await ses.fetch(resolved.href, { signal: AbortSignal.timeout(8000) })
      if (!response.ok) return null
      const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
      return image.isEmpty() ? null : image
    }
  } catch {
    // Unreadable or not an image.
  }
  return null
}

/** Throws unless `value` is an integer. */
export function requireInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ExtensionError(`Invalid ${name}.`)
  return value
}
