import { dialog, nativeImage, type MessageBoxOptions } from 'electron'
import { apiPermissions, grantedOptional, hostPermissions, isOptional, manifestOf, setGrantedOptional } from '../../access'
import { extensionDisplay, permissionWarnings } from '../../manager'
import { globToRegExp } from '../../match-pattern'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { currentWindow, findExtraWindow } from '../../tabs-model'
import { asObject } from './util'

/**
 * chrome.permissions: optional permissions and host permissions the extension asks for at run
 * time. Only ones listed as optional in the manifest can be requested; the user approves them in
 * a dialog with Chrome's warnings, and grants are remembered (access.ts folds them into what the
 * extension may do).
 */

interface Permissions {
  permissions: string[]
  origins: string[]
}

const isHostPattern = (p: string): boolean => p === '<all_urls>' || p.includes('://')
const ALL_URLS_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file', 'urn'])

interface Pattern {
  all: boolean
  scheme: string
  host: string
  anySubdomain: boolean
  path: string
}

function parsePattern(pattern: string): Pattern | null {
  if (pattern === '<all_urls>') return { all: true, scheme: '*', host: '', anySubdomain: true, path: '/*' }
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern)
  if (!m) return null
  let host = m[2].toLowerCase().replace(/:(\d+|\*)$/, '')
  let anySubdomain = false
  if (host === '*') host = ''
  else if (host.startsWith('*.')) {
    anySubdomain = true
    host = host.slice(2)
  } else if (host.includes('*')) return null
  if (m[1] !== 'file' && !host && m[2] !== '*') return null
  return { all: false, scheme: m[1].toLowerCase(), host, anySubdomain: anySubdomain || !host, path: m[3] ?? '/*' }
}

/** Whether host pattern `granted` includes everything `requested` does. */
export function patternCovers(granted: string, requested: string): boolean {
  if (granted === requested) return true
  const g = parsePattern(granted)
  const r = parsePattern(requested)
  if (!g || !r) return false
  if (g.all) return r.all || r.scheme === '*' || ALL_URLS_SCHEMES.has(r.scheme)
  if (r.all) return false
  const schemeOk = g.scheme === '*' ? ['*', 'http', 'https'].includes(r.scheme) : g.scheme === r.scheme
  if (!schemeOk) return false
  if (g.host) {
    if (!r.host) return false
    const hostOk = g.anySubdomain ? r.host === g.host || r.host.endsWith(`.${g.host}`) : !r.anySubdomain && r.host === g.host
    if (!hostOk) return false
  }
  return globToRegExp(g.path).test(r.path)
}

function readRequest(value: unknown): Permissions {
  const d = asObject(value)
  const list = (v: unknown, name: string): string[] => {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ExtensionError(`Invalid '${name}': expected an array of strings.`)
    return [...new Set(v as string[])]
  }
  const permissions = list(d.permissions, 'permissions')
  const origins = list(d.origins, 'origins')
  for (const origin of origins) {
    if (!parsePattern(origin)) throw new ExtensionError(`Invalid value for origin pattern ${origin}: Invalid scheme.`)
  }
  // Manifest V2 style: hosts among the permissions.
  for (const p of permissions.filter(isHostPattern)) {
    if (!origins.includes(p)) origins.push(p)
  }
  return { permissions: permissions.filter((p) => !isHostPattern(p)), origins }
}

/** Host patterns the extension can use now, counting its content scripts' hosts like Chrome does. */
function activeOrigins(extensionId: string): string[] {
  const scripts = (manifestOf(extensionId)?.content_scripts ?? []).flatMap((c) => c.matches ?? [])
  return [...new Set([...hostPermissions(extensionId), ...scripts])]
}

function requiredPermissions(extensionId: string): Permissions {
  const m = manifestOf(extensionId)
  const declared = m?.permissions ?? []
  return {
    permissions: declared.filter((p) => !isHostPattern(p)),
    origins: m?.manifest_version === 2 ? declared.filter(isHostPattern) : (m?.host_permissions ?? [])
  }
}

function contains(call: CallContext, value: unknown): boolean {
  const wanted = readRequest(value)
  const have = apiPermissions(call.extensionId)
  if (!wanted.permissions.every((p) => have.has(p))) return false
  const origins = activeOrigins(call.extensionId)
  return wanted.origins.every((o) => origins.some((g) => patternCovers(g, o)))
}

function getAll(call: CallContext): Permissions {
  return { permissions: [...apiPermissions(call.extensionId)], origins: activeOrigins(call.extensionId) }
}

/** One permission dialog at a time. */
let dialogQueue: Promise<unknown> = Promise.resolve()

async function confirm(call: CallContext, added: Permissions): Promise<boolean> {
  const warnings = permissionWarnings({ permissions: added.permissions, host_permissions: added.origins })
  // Like Chrome, permissions that come with no warning are granted without asking.
  if (!warnings.length) return true
  const display = extensionDisplay(call.extensionId)
  const name = display?.name ?? call.extension.name
  const icon = display?.icon ? nativeImage.createFromDataURL(display.icon) : undefined
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    message: `“${name}” is asking for more permissions`,
    detail: `It will be able to:\n${warnings.map((w) => `• ${w}`).join('\n')}`
  }
  const run = async (): Promise<boolean> => {
    // The caller's window: its tab's, its popup's, or the extension window it's in.
    const parent = (call.windowId !== undefined ? findExtraWindow(call.windowId)?.win : undefined) ?? currentWindow(call)?.win
    const { response } = await (parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    return response === 0
  }
  const result = dialogQueue.then(run, run)
  dialogQueue = result.catch(() => false)
  return result
}

async function request(call: CallContext, value: unknown): Promise<boolean> {
  const wanted = readRequest(value)
  const id = call.extensionId
  const have = apiPermissions(id)
  const origins = activeOrigins(id)
  const added: Permissions = { permissions: [], origins: [] }
  for (const p of wanted.permissions) {
    if (have.has(p)) continue
    if (!isOptional(id, p)) throw new ExtensionError('Only permissions specified in the manifest may be requested.')
    added.permissions.push(p)
  }
  for (const o of wanted.origins) {
    if (origins.some((g) => patternCovers(g, o))) continue
    if (!isOptional(id, o)) throw new ExtensionError('Only permissions specified in the manifest may be requested.')
    added.origins.push(o)
  }
  if (!added.permissions.length && !added.origins.length) return true
  if (!(await confirm(call, added))) return false
  const granted = grantedOptional(id)
  setGrantedOptional(id, { permissions: [...granted.permissions, ...added.permissions], origins: [...granted.origins, ...added.origins] })
  emit('permissions.onAdded', [added], { extensionId: id })
  return true
}

function remove(call: CallContext, value: unknown): boolean {
  const wanted = readRequest(value)
  const id = call.extensionId
  const required = requiredPermissions(id)
  if (wanted.permissions.some((p) => required.permissions.includes(p)) || wanted.origins.some((o) => required.origins.some((r) => patternCovers(r, o)))) {
    throw new ExtensionError('You cannot remove required permissions.')
  }
  const granted = grantedOptional(id)
  const removed: Permissions = {
    permissions: granted.permissions.filter((p) => wanted.permissions.includes(p)),
    // A removed pattern also takes away the narrower ones it covers.
    origins: granted.origins.filter((g) => wanted.origins.some((o) => patternCovers(o, g)))
  }
  // Like Chrome, removing permissions the extension doesn't hold succeeds.
  if (!removed.permissions.length && !removed.origins.length) return true
  setGrantedOptional(id, {
    permissions: granted.permissions.filter((p) => !removed.permissions.includes(p)),
    origins: granted.origins.filter((o) => !removed.origins.includes(o))
  })
  emit('permissions.onRemoved', [removed], { extensionId: id })
  return true
}

/** Chrome 133+: asks the user to grant access to a site from the toolbar. Tabs has no such UI yet. */
function hostAccessRequest(_call: CallContext, value: unknown): void {
  const d = asObject(value)
  if (d.tabId === undefined && d.documentId === undefined) throw new ExtensionError('Must specify either tabId or documentId.')
}

defineApi('permissions', {
  methods: {
    contains,
    getAll,
    request,
    remove,
    addHostAccessRequest: hostAccessRequest,
    removeHostAccessRequest: hostAccessRequest
  }
})

defineEvent('permissions.onAdded')
defineEvent('permissions.onRemoved')
