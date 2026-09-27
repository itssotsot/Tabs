/**
 * The storage.sync StorageArea logic: Chrome's quotas, write-rate limits, errors and change
 * records, over any per-extension item store. No Electron here.
 */

export const SYNC_QUOTA = {
  QUOTA_BYTES: 102_400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512,
  MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
  MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
  MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000
} as const

export type Items = Record<string, unknown>
export type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>

/** An API error (quota, bad arguments), with Chrome's message. */
export class SyncError extends Error {}

export interface SyncBackend {
  read(extensionId: string): Items
  /** Called with the whole new set of items after each change that went through. */
  write(extensionId: string, items: Items): void
}

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Chrome counts an item as its key plus its value's JSON, in bytes. */
export function itemBytes(key: string, value: unknown): number {
  return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value) ?? '')
}

export function totalBytes(items: Items): number {
  let total = 0
  for (const [key, value] of Object.entries(items)) total += itemBytes(key, value)
  return total
}

export interface SyncArea {
  get(extensionId: string, keys: unknown): Items
  keys(extensionId: string): string[]
  /** These return what changed (only keys whose value actually changed). */
  set(extensionId: string, values: unknown): Changes
  remove(extensionId: string, keys: unknown): Changes
  clear(extensionId: string): Changes
  bytesInUse(extensionId: string, keys: unknown): number
  /** Forgets an extension's write history (it was uninstalled). */
  forget(extensionId: string): void
}

export function createSyncArea(backend: SyncBackend, now: () => number = Date.now): SyncArea {
  /** Recent write times per extension, for the write-rate quotas. */
  const writes = new Map<string, number[]>()

  function countWrite(extensionId: string): void {
    const t = now()
    const recent = (writes.get(extensionId) ?? []).filter((w) => t - w < 3_600_000)
    if (recent.length >= SYNC_QUOTA.MAX_WRITE_OPERATIONS_PER_HOUR) throw new SyncError('MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded')
    if (recent.filter((w) => t - w < 60_000).length >= SYNC_QUOTA.MAX_WRITE_OPERATIONS_PER_MINUTE) {
      throw new SyncError('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded')
    }
    recent.push(t)
    writes.set(extensionId, recent)
  }

  /** Keys asked for: null for all, else the names (and defaults, for the object form). */
  function parseKeys(keys: unknown): { names: string[] | null; defaults: Items } {
    if (keys === undefined || keys === null) return { names: null, defaults: {} }
    if (typeof keys === 'string') return { names: [keys], defaults: {} }
    if (Array.isArray(keys)) {
      if (!keys.every((k) => typeof k === 'string')) throw new SyncError('Invalid argument: keys must be strings.')
      return { names: keys as string[], defaults: {} }
    }
    if (isObject(keys)) return { names: Object.keys(keys), defaults: keys }
    throw new SyncError('Invalid argument: keys must be a string, an array of strings or an object.')
  }

  function names(keys: unknown): string[] {
    if (typeof keys === 'string') return [keys]
    if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) return keys as string[]
    throw new SyncError('Invalid argument: keys must be a string or an array of strings.')
  }

  return {
    get(extensionId: string, keys: unknown): Items {
      const { names, defaults } = parseKeys(keys)
      const items = backend.read(extensionId)
      if (!names) return structuredClone(items)
      const out: Items = {}
      for (const name of names) {
        if (has(items, name)) out[name] = structuredClone(items[name])
        else if (defaults[name] !== undefined) out[name] = defaults[name]
      }
      return out
    },

    keys(extensionId: string): string[] {
      return Object.keys(backend.read(extensionId))
    },

    set(extensionId: string, values: unknown): Changes {
      if (!isObject(values)) throw new SyncError('Invalid argument: items must be an object.')
      const current = backend.read(extensionId)
      const next: Items = { ...current }
      const changes: Changes = {}
      for (const [key, raw] of Object.entries(values)) {
        if (raw === undefined) continue
        // Stored as JSON, like Chrome: functions and undefined members disappear, dates become {}.
        const value = JSON.parse(JSON.stringify(raw) ?? 'null') as unknown
        if (itemBytes(key, value) > SYNC_QUOTA.QUOTA_BYTES_PER_ITEM) throw new SyncError('QUOTA_BYTES_PER_ITEM quota exceeded')
        next[key] = value
        if (has(current, key) && same(current[key], value)) continue
        changes[key] = has(current, key) ? { oldValue: current[key], newValue: value } : { newValue: value }
      }
      if (Object.keys(next).length > SYNC_QUOTA.MAX_ITEMS) throw new SyncError('MAX_ITEMS quota exceeded')
      if (totalBytes(next) > SYNC_QUOTA.QUOTA_BYTES) throw new SyncError('QUOTA_BYTES quota exceeded')
      countWrite(extensionId)
      backend.write(extensionId, next)
      return changes
    },

    remove(extensionId: string, keys: unknown): Changes {
      const list = names(keys)
      countWrite(extensionId)
      const next: Items = { ...backend.read(extensionId) }
      const changes: Changes = {}
      for (const name of list) {
        if (!has(next, name)) continue
        changes[name] = { oldValue: next[name] }
        delete next[name]
      }
      backend.write(extensionId, next)
      return changes
    },

    clear(extensionId: string): Changes {
      countWrite(extensionId)
      const changes: Changes = {}
      for (const [key, value] of Object.entries(backend.read(extensionId))) changes[key] = { oldValue: value }
      backend.write(extensionId, {})
      return changes
    },

    bytesInUse(extensionId: string, keys: unknown): number {
      const items = backend.read(extensionId)
      if (keys === undefined || keys === null) return totalBytes(items)
      let total = 0
      for (const name of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []) {
        if (typeof name === 'string' && has(items, name)) total += itemBytes(name, items[name])
      }
      return total
    },

    forget(extensionId: string): void {
      writes.delete(extensionId)
    }
  }
}
