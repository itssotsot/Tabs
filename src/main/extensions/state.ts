import { JsonFile } from '../store'

/**
 * What the extension APIs remember across restarts, per extension: installed version, pinned
 * toolbar button, context menu items, dynamic network rules, granted optional permissions…
 * Each API module owns its own keys.
 */

type Section = Record<string, unknown>

let file: JsonFile<{ extensions: Record<string, Section>; global: Section }> | null = null

function data(): { extensions: Record<string, Section>; global: Section } {
  file ??= new JsonFile('extension-state', { extensions: {}, global: {} })
  return file.data
}

export function getState<T>(extensionId: string, key: string, fallback: T): T {
  const value = data().extensions[extensionId]?.[key]
  return value === undefined ? fallback : (value as T)
}

export function setState(extensionId: string, key: string, value: unknown): void {
  const all = data().extensions
  const section = (all[extensionId] ??= {})
  if (value === undefined) delete section[key]
  else section[key] = value
  file!.save()
}

export function getGlobalState<T>(key: string, fallback: T): T {
  const value = data().global[key]
  return value === undefined ? fallback : (value as T)
}

export function setGlobalState(key: string, value: unknown): void {
  const global = data().global
  if (value === undefined) delete global[key]
  else global[key] = value
  file!.save()
}

/** Forgets everything about an extension (it was uninstalled). */
export function clearState(extensionId: string): void {
  delete data().extensions[extensionId]
  file!.save()
}

export function flushState(): void {
  file?.flush()
}
