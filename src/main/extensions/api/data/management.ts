import { nativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { store } from '../../../store'
import { hasApiPermission, loadedExtension } from '../../access'
import { lifecycle } from '../../lifecycle'
import {
  extensionFolder,
  extensionOptionsUrl,
  listExtensions,
  localizedManifestString,
  permissionWarnings,
  removeExtension,
  setExtensionEnabled
} from '../../manager'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { confirmForExtension, extensionName, isObject, isString } from './util'

/**
 * chrome.management. Electron has getSelf, uninstallSelf (which doesn't uninstall) and
 * getPermissionWarningsByManifest; this adds the rest, on top of the extension manager. There are
 * no apps, so the app methods fail like they do for extensions in Chrome.
 */

type Info = chrome.management.ExtensionInfo
type Manifest = Parameters<typeof permissionWarnings>[0] & Record<string, unknown>

const isHostPattern = (p: string): boolean => p === '<all_urls>' || p.includes('://')
const notFound = (id: unknown): ExtensionError => new ExtensionError(`Failed to find extension with id ${String(id)}.`)

function manifestFor(id: string): Manifest | null {
  const loaded = loadedExtension(id)
  if (loaded) return loaded.manifest as Manifest
  const folder = extensionFolder(id)
  if (!folder) return null
  try {
    return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8').replace(/^﻿/, '')) as Manifest
  } catch {
    return null
  }
}

function iconsOf(id: string, manifest: Manifest): chrome.management.IconInfo[] | undefined {
  const folder = extensionFolder(id)
  const icons = manifest.icons
  if (!folder || !icons) return undefined
  const out: chrome.management.IconInfo[] = []
  for (const [size, path] of Object.entries(icons)) {
    const file = normalize(join(folder, path))
    if (!file.startsWith(folder + sep)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) out.push({ size: Number(size), url: image.toDataURL() })
  }
  return out.length ? out.sort((a, b) => a.size - b.size) : undefined
}

/** ExtensionInfo for an installed extension (running or turned off). */
export function extensionInfo(id: string): Info | null {
  const listed = listExtensions().find((e) => e.id === id)
  const manifest = listed ? manifestFor(id) : null
  if (!listed || !manifest) return null
  const permissions = manifest.permissions ?? []
  const hosts = [
    ...(manifest.manifest_version === 2 ? permissions.filter(isHostPattern) : (manifest.host_permissions ?? [])),
    ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? [])
  ]
  const info = {
    id,
    name: listed.name,
    shortName: localizedManifestString(id, (manifest.short_name as string | undefined) ?? manifest.name) || listed.name,
    description: listed.description,
    version: listed.version,
    mayDisable: true,
    mayEnable: true,
    enabled: listed.enabled && !!loadedExtension(id),
    isApp: false,
    type: (manifest.theme ? 'theme' : 'extension') as Info['type'],
    offlineEnabled: manifest.offline_enabled === true,
    optionsUrl: extensionOptionsUrl(id) ?? listed.optionsUrl ?? '',
    permissions: [...new Set(permissions.filter((p) => !isHostPattern(p)))],
    hostPermissions: [...new Set(hosts)],
    installType: 'normal' as Info['installType']
  } as Info
  if (isString(manifest.version_name)) info.versionName = manifest.version_name
  if (isString(manifest.homepage_url)) info.homepageUrl = manifest.homepage_url
  if (isString(manifest.update_url)) info.updateUrl = manifest.update_url
  if (!info.enabled) info.disabledReason = 'unknown' as Info['disabledReason']
  const icons = iconsOf(id, manifest)
  if (icons) info.icons = icons
  return info
}

function requireInfo(id: unknown): Info {
  const info = isString(id) ? extensionInfo(id) : null
  if (!info) throw notFound(id)
  return info
}

function requireManagement(call: CallContext): void {
  if (!hasApiPermission(call.extensionId, 'management')) throw new ExtensionError('This method needs the "management" permission.')
}

async function setEnabled(call: CallContext, id: unknown, enabled: unknown): Promise<void> {
  requireManagement(call)
  const info = requireInfo(id)
  const on = enabled === true
  if (info.enabled === on) return
  if (info.id !== call.extensionId) {
    const verb = on ? 'turn on' : 'turn off'
    const ok = await confirmForExtension(call.extensionId, {
      message: `“${extensionName(call.extensionId)}” wants to ${verb} “${info.name}”`,
      confirm: on ? 'Turn on' : 'Turn off'
    })
    if (!ok) throw new ExtensionError(on ? 'The user did not accept the re-enable dialog.' : 'The user did not allow the extension to be turned off.')
  }
  await setExtensionEnabled(info.id, on)
}

async function uninstallExtension(call: CallContext, id: string, confirm: boolean): Promise<void> {
  const name = extensionName(id)
  if (confirm) {
    const self = id === call.extensionId
    const ok = await confirmForExtension(call.extensionId, {
      type: 'warning',
      message: self ? `Remove “${name}”?` : `“${extensionName(call.extensionId)}” wants to remove “${name}”`,
      confirm: 'Remove'
    })
    if (!ok) throw new ExtensionError(`Extension with id ${id} uninstall canceled by user.`)
  }
  // After the reply has gone out: an extension removing itself stops running.
  setTimeout(() => void removeExtension(id).catch((err) => console.error('[extensions] uninstall failed', err)), 0)
}

function parseManifest(text: unknown): Manifest {
  if (!isString(text)) throw new ExtensionError('Manifest is invalid.')
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isObject(parsed)) throw new Error()
    return parsed as Manifest
  } catch {
    throw new ExtensionError('Manifest is invalid.')
  }
}

const notAnApp = (id: unknown): ExtensionError => new ExtensionError(`Extension with id ${String(id)} is not an App.`)

defineApi('management', {
  methods: {
    // Without the permission Chrome still allows these three.
    getSelf: (call) => requireInfo(call.extensionId),
    uninstallSelf: (call, options) => uninstallExtension(call, call.extensionId, isObject(options) && options.showConfirmDialog === true),
    getPermissionWarningsByManifest: (_call, manifestStr) => permissionWarnings(parseManifest(manifestStr)),

    getAll: (call) => {
      requireManagement(call)
      return listExtensions()
        .map((e) => extensionInfo(e.id))
        .filter((i): i is Info => !!i)
    },
    get: (call, id) => {
      requireManagement(call)
      return requireInfo(id)
    },
    setEnabled,
    uninstall: (call, id, options) => {
      requireManagement(call)
      const info = requireInfo(id)
      // Removing another extension always asks; removing itself only when told to.
      const self = info.id === call.extensionId
      return uninstallExtension(call, info.id, !self || (isObject(options) && options.showConfirmDialog === true))
    },
    getPermissionWarningsById: (call, id) => {
      requireManagement(call)
      requireInfo(id)
      const manifest = manifestFor(id as string)
      return manifest ? permissionWarnings(manifest) : []
    },
    launchApp: (call, id) => {
      requireManagement(call)
      requireInfo(id)
      throw notAnApp(id)
    },
    createAppShortcut: (call, id) => {
      requireManagement(call)
      requireInfo(id)
      throw notAnApp(id)
    },
    setLaunchType: (call, id) => {
      requireManagement(call)
      requireInfo(id)
      throw notAnApp(id)
    },
    generateAppForLink: (call) => {
      requireManagement(call)
      throw new ExtensionError("Apps aren't supported in this browser.")
    }
  }
})

for (const name of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) defineEvent(`management.${name}`, { permissions: ['management'] })

/** Tells every other extension with the permission. */
function tellOthers(event: string, subject: string, args: () => unknown[] | null): void {
  let cached: unknown[] | null | undefined
  emit(event, (extensionId) => {
    if (extensionId === subject) return null
    if (cached === undefined) cached = args()
    return cached
  })
}

lifecycle.on('loaded', (extension, reason) => {
  const event = reason === 'install' || reason === 'update' ? 'management.onInstalled' : reason === 'enable' ? 'management.onEnabled' : null
  if (!event) return
  tellOthers(event, extension.id, () => {
    const info = extensionInfo(extension.id)
    return info ? [info] : null
  })
})

lifecycle.on('unloaded', (extensionId) => {
  // Unloads also happen for updates and uninstalls; only a turned-off extension is "disabled".
  setTimeout(() => {
    if (!store.disabledExtensions.includes(extensionId)) return
    tellOthers('management.onDisabled', extensionId, () => {
      const info = extensionInfo(extensionId)
      return info ? [info] : null
    })
  }, 0)
})

lifecycle.on('uninstalled', (extensionId) => {
  tellOthers('management.onUninstalled', extensionId, () => [extensionId])
})
