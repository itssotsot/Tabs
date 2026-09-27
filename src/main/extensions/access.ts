import type { Extension, Session } from 'electron'
import { matchPattern, matchesAny } from './match-pattern'
import { getState, setState } from './state'

/**
 * What an extension may do: the API permissions and host permissions in its manifest, optional
 * ones the user granted later (chrome.permissions.request), and temporary access to a tab
 * from activeTab (granted when the user clicks its button, runs its shortcut or menu item).
 */

let ses: Session | null = null

export function setAccessSession(session: Session): void {
  ses = session
}

export function loadedExtension(id: string): Extension | null {
  return ses?.extensions.getExtension(id) ?? null
}

export function allLoadedExtensions(): Extension[] {
  return ses?.extensions.getAllExtensions() ?? []
}

export interface ExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  content_scripts?: { matches?: string[]; exclude_matches?: string[] }[]
  [key: string]: unknown
}

export function manifestOf(id: string): ExtensionManifest | null {
  return (loadedExtension(id)?.manifest as ExtensionManifest | undefined) ?? null
}

const isHostPattern = (p: string): boolean => p === '<all_urls>' || p.includes('://')

export interface Granted {
  permissions: string[]
  origins: string[]
}

export function grantedOptional(id: string): Granted {
  return getState<Granted>(id, 'grantedPermissions', { permissions: [], origins: [] })
}

export function setGrantedOptional(id: string, granted: Granted): void {
  setState(id, 'grantedPermissions', { permissions: [...new Set(granted.permissions)], origins: [...new Set(granted.origins)] })
}

/** API permissions the extension has now (manifest + granted optional ones). */
export function apiPermissions(id: string): Set<string> {
  const m = manifestOf(id)
  const set = new Set((m?.permissions ?? []).filter((p) => !isHostPattern(p)))
  for (const p of grantedOptional(id).permissions) set.add(p)
  return set
}

export function hasApiPermission(id: string, permission: string): boolean {
  return apiPermissions(id).has(permission)
}

/** Host permission patterns the extension has now. */
export function hostPermissions(id: string): string[] {
  const m = manifestOf(id)
  if (!m) return []
  const declared = m.manifest_version === 2 ? (m.permissions ?? []).filter(isHostPattern) : (m.host_permissions ?? [])
  return [...declared, ...grantedOptional(id).origins]
}

/** Hosts its content scripts run on; Chrome counts these when deciding what a tab's URL reveals. */
function scriptableHosts(id: string): string[] {
  return (manifestOf(id)?.content_scripts ?? []).flatMap((c) => c.matches ?? [])
}

/** Tabs where activeTab currently grants access, per extension. Cleared when the tab navigates away or closes. */
const activeTabGrants = new Map<string, Set<number>>()

export function grantActiveTab(id: string, tabId: number): void {
  if (!hasApiPermission(id, 'activeTab')) return
  let tabs = activeTabGrants.get(id)
  if (!tabs) activeTabGrants.set(id, (tabs = new Set()))
  tabs.add(tabId)
}

export function hasActiveTabGrant(id: string, tabId: number): boolean {
  return activeTabGrants.get(id)?.has(tabId) ?? false
}

/** A tab went to another page (or closed): activeTab no longer covers it. */
export function revokeActiveTab(tabId: number): void {
  for (const tabs of activeTabGrants.values()) tabs.delete(tabId)
}

export function forgetExtensionAccess(id: string): void {
  activeTabGrants.delete(id)
}

/** Whether the extension may read or script this URL (in this tab, when activeTab applies). */
export function hasHostAccess(id: string, url: string, tabId?: number): boolean {
  if (url.startsWith(`chrome-extension://${id}/`)) return true
  if (tabId !== undefined && hasActiveTabGrant(id, tabId)) return true
  return matchesAny(hostPermissions(id), url)
}

/** Whether tabs.Tab objects show this tab's URL, title and favicon to the extension. */
export function canSeeTabDetails(id: string, url: string, tabId?: number): boolean {
  if (hasApiPermission(id, 'tabs')) return true
  return hasHostAccess(id, url, tabId) || matchesAny(scriptableHosts(id), url)
}

/** Whether a permission name or origin pattern is one the manifest allows asking for. */
export function isOptional(id: string, permissionOrOrigin: string): boolean {
  const m = manifestOf(id)
  if (!m) return false
  if (isHostPattern(permissionOrOrigin)) {
    const optionalHosts = m.manifest_version === 2 ? (m.optional_permissions ?? []).filter(isHostPattern) : (m.optional_host_permissions ?? [])
    const wanted = matchPattern(permissionOrOrigin)
    return optionalHosts.some((p) => p === permissionOrOrigin || p === '<all_urls>' || (!!wanted && matchPattern(p)?.coversAllHosts === true))
  }
  return (m.optional_permissions ?? []).includes(permissionOrOrigin)
}
