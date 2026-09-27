import { app, dialog, nativeImage, webContents, type Session } from 'electron'
import { installChromeWebStore, uninstallExtension } from 'electron-chrome-web-store'
import { readdirSync, readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import type { ExtensionInfo } from '@shared/types'
import { store } from './store'
import { controllerFor } from './window'

/**
 * Chrome extensions, installed from the Chrome Web Store (electron-chrome-web-store).
 * Electron runs content scripts, background workers and options pages, but not toolbar
 * buttons or pop-ups, so extensions that rely on those only partly work.
 */

export const WEB_STORE_URL = 'https://chromewebstore.google.com/category/extensions'

/** Store extension IDs: 32 letters a–p. */
const ID_RE = /^[a-p]{32}$/
/** Install folders are named `<version>_0`; anything else is an install in progress. */
const VERSION_DIR_RE = /^\d[\d.]*_\d+$/

interface Manifest {
  name?: string
  description?: string
  version?: string
  default_locale?: string
  manifest_version?: number
  icons?: Record<string, string>
  options_page?: string
  options_ui?: { page?: string }
  permissions?: string[]
  host_permissions?: string[]
  optional_permissions?: string[]
  content_scripts?: { matches?: string[] }[]
  background?: { service_worker?: string }
}

interface Installed {
  id: string
  path: string
  manifest: Manifest
}

let ses: Session | null = null
/** Why an enabled extension didn't load, by ID. */
const loadErrors = new Map<string, string>()

const extensionsPath = (): string => join(app.getPath('userData'), 'Extensions')

function readdir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as T
  } catch {
    return null
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** The newest installed version of an extension. */
function findInstalled(id: string): Installed | null {
  let best: Installed | null = null
  for (const name of readdir(join(extensionsPath(), id))) {
    if (!VERSION_DIR_RE.test(name)) continue
    const path = join(extensionsPath(), id, name)
    const manifest = readJson<Manifest>(join(path, 'manifest.json'))
    if (!manifest?.version) continue
    if (!best || compareVersions(manifest.version, best.manifest.version!) > 0) best = { id, path, manifest }
  }
  return best
}

function allInstalled(): Installed[] {
  return readdir(extensionsPath())
    .filter((id) => ID_RE.test(id))
    .flatMap((id) => findInstalled(id) ?? [])
}

/** Resolves `__MSG_name__` placeholders from the extension's _locales folder. */
function localize(ext: Installed, text: string | undefined): string {
  const key = text?.match(/^__MSG_(\w+)__$/)?.[1].toLowerCase()
  if (!key) return text ?? ''
  const locale = app.getLocale().replace('-', '_')
  for (const loc of new Set([locale, locale.split('_')[0], ext.manifest.default_locale])) {
    if (!loc) continue
    const messages = readJson<Record<string, { message?: string }>>(join(ext.path, '_locales', loc, 'messages.json'))
    const entry = messages && Object.entries(messages).find(([k]) => k.toLowerCase() === key)?.[1]
    if (entry?.message) return entry.message
  }
  return text ?? ''
}

/** The extension's icon closest to 48px, as a data: URL. */
function iconOf(ext: Installed): string | null {
  const sizes = Object.keys(ext.manifest.icons ?? {})
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const size = sizes.find((n) => n >= 48) ?? sizes.at(-1)
  if (!size) return null
  const file = normalize(join(ext.path, ext.manifest.icons![String(size)]))
  if (!file.startsWith(ext.path + sep)) return null
  const image = nativeImage.createFromPath(file)
  return image.isEmpty() ? null : image.resize({ width: 48, height: 48 }).toDataURL()
}

function optionsUrl(ext: Installed): string | null {
  const page = ext.manifest.options_ui?.page ?? ext.manifest.options_page
  return page ? `chrome-extension://${ext.id}/${page.replace(/^\/+/, '')}` : null
}

/** Chrome's install warnings for the permissions people most need to know about. */
function permissionWarnings(manifest: Manifest): string[] {
  const permissions = new Set(manifest.permissions ?? [])
  const hosts = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []),
    // Manifest V2 lists hosts among its permissions.
    ...[...permissions].filter((p) => p.includes('://') || p === '<all_urls>')
  ]
  const warnings: string[] = []
  const allSites = hosts.some((h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h))
  if (allSites || permissions.has('debugger')) {
    warnings.push('Read and change all your data on all websites')
  } else if (hosts.length) {
    const names = [...new Set(hosts.map((h) => h.replace(/^[^:]+:\/\/(\*\.)?/, '').replace(/\/.*$/, '')))]
    warnings.push(
      names.length <= 3
        ? `Read and change your data on ${names.join(', ').replace(/, ([^,]*)$/, ' and $1')}`
        : `Read and change your data on ${names.length} websites`
    )
  }
  const LABELS: [string, string][] = [
    ['history', 'Read and change your browsing history'],
    ['tabs', 'Read your browsing history'],
    ['bookmarks', 'Read and change your bookmarks'],
    ['downloads', 'Manage your downloads'],
    ['clipboardRead', 'Read data you copy and paste'],
    ['clipboardWrite', 'Modify data you copy and paste'],
    ['geolocation', 'Detect your physical location'],
    ['management', 'Manage your apps, extensions, and themes'],
    ['privacy', 'Change your privacy-related settings'],
    ['notifications', 'Display notifications'],
    ['nativeMessaging', 'Communicate with cooperating native applications']
  ]
  for (const [permission, label] of LABELS) {
    if (permission === 'tabs' && permissions.has('history')) continue
    if (permissions.has(permission)) warnings.push(label)
  }
  return warnings
}

interface InstallDetails {
  id: string
  localizedName: string
  manifest: unknown
  icon: Electron.NativeImage
  frame: Electron.WebFrameMain
}

async function confirmInstall(details: InstallDetails): Promise<{ action: 'allow' | 'deny' }> {
  const wc = webContents.fromFrame(details.frame)
  const win = wc ? controllerFor(wc)?.win : undefined
  const warnings = permissionWarnings(details.manifest as Manifest)
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Add extension', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    icon: details.icon.isEmpty() ? undefined : details.icon.resize({ width: 64, height: 64 }),
    message: `Add “${details.localizedName}”?`,
    detail: [
      warnings.length ? `It can:\n${warnings.map((w) => `• ${w}`).join('\n')}` : '',
      "Tabs doesn't show extension toolbar buttons or pop-ups yet, so some extensions only partly work."
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  if (response !== 0) return { action: 'deny' }
  // Adding an extension that was turned off turns it back on.
  store.setDisabledExtensions(store.disabledExtensions.filter((d) => d !== details.id))
  return { action: 'allow' }
}

async function load(ext: Installed): Promise<void> {
  if (!ses || ses.extensions.getExtension(ext.id)) return
  try {
    const loaded = await ses.extensions.loadExtension(ext.path)
    loadErrors.delete(ext.id)
    // Manifest V3 background workers otherwise only start on their first event.
    if (loaded.manifest.background?.service_worker) {
      await ses.serviceWorkers.startWorkerForScope(loaded.url).catch(() => {})
    }
  } catch (err) {
    loadErrors.set(ext.id, err instanceof Error ? err.message : String(err))
    console.error(`[extensions] couldn't load ${ext.id}`, err)
  }
}

/**
 * Lets tabs install extensions from the Chrome Web Store, then loads the installed ones
 * (except those turned off). Runs before any tab opens so content scripts see every page.
 */
export async function setupExtensions(session: Session): Promise<void> {
  ses = session
  try {
    // We load extensions ourselves so turned-off ones stay unloaded.
    await installChromeWebStore({ session, extensionsPath: extensionsPath(), loadExtensions: false, beforeInstall: confirmInstall })
  } catch (err) {
    console.error('[extensions] Chrome Web Store unavailable', err)
  }
  const disabled = new Set(store.disabledExtensions)
  await Promise.all(allInstalled().filter((ext) => !disabled.has(ext.id)).map(load))
}

export function listExtensions(): ExtensionInfo[] {
  const disabled = new Set(store.disabledExtensions)
  return allInstalled()
    .map((ext): ExtensionInfo => {
      const enabled = !disabled.has(ext.id)
      const loaded = !!ses?.extensions.getExtension(ext.id)
      return {
        id: ext.id,
        name: localize(ext, ext.manifest.name) || ext.id,
        version: ext.manifest.version ?? '',
        description: localize(ext, ext.manifest.description),
        enabled,
        icon: iconOf(ext),
        optionsUrl: optionsUrl(ext),
        error: enabled && !loaded ? (loadErrors.get(ext.id) ?? "This extension couldn't be loaded.") : null
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  const ext = ID_RE.test(id) ? findInstalled(id) : null
  if (!ext || !ses) return
  const disabled = store.disabledExtensions.filter((d) => d !== id)
  store.setDisabledExtensions(enabled ? disabled : [...disabled, id])
  if (enabled) await load(ext)
  else if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id)
}

export async function removeExtension(id: string): Promise<void> {
  if (!ID_RE.test(id) || !ses) return
  await uninstallExtension(id, { session: ses, extensionsPath: extensionsPath() })
  loadErrors.delete(id)
  store.setDisabledExtensions(store.disabledExtensions.filter((d) => d !== id))
}

/** The options page of an installed, running extension. */
export function extensionOptionsUrl(id: string): string | null {
  const ext = ID_RE.test(id) && ses?.extensions.getExtension(id) ? findInstalled(id) : null
  return ext ? optionsUrl(ext) : null
}
