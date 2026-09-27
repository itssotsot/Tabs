import type { ClearDataOptions, Session } from 'electron'
import { store } from '../../../store'
import { allLoadedExtensions } from '../../access'
import { lifecycle } from '../../lifecycle'
import { defineApi, ExtensionError, type CallContext } from '../../router'
import { asObject } from './util'

/**
 * chrome.browsingData over the web session's storage and the browser's history.
 *
 * Electron can clear by origin but not by time, so `since` only narrows history; other data is
 * cleared entirely. Data of extension origins is left alone unless `originTypes.extension` asks
 * for it. Tabs keeps no form data or passwords, and app caches no longer exist, so those are no-ops.
 */

type DataType =
  | 'appcache'
  | 'cache'
  | 'cacheStorage'
  | 'cookies'
  | 'downloads'
  | 'fileSystems'
  | 'formData'
  | 'history'
  | 'indexedDB'
  | 'localStorage'
  | 'passwords'
  | 'pluginData'
  | 'serverBoundCertificates'
  | 'serviceWorkers'
  | 'webSQL'

const ALL_TYPES: DataType[] = [
  'appcache',
  'cache',
  'cacheStorage',
  'cookies',
  'downloads',
  'fileSystems',
  'formData',
  'history',
  'indexedDB',
  'localStorage',
  'passwords',
  'pluginData',
  'serverBoundCertificates',
  'serviceWorkers',
  'webSQL'
]

/** Types that can be limited to origins, like in Chrome ("cookies, storage and cache"). */
const ORIGIN_TYPES = new Set<DataType>(['cache', 'cacheStorage', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'])

/** Our data type -> Electron's clearData type. */
const CLEAR_DATA: Partial<Record<DataType, NonNullable<ClearDataOptions['dataTypes']>[number]>> = {
  cache: 'cache',
  cookies: 'cookies',
  downloads: 'downloads',
  fileSystems: 'fileSystems',
  indexedDB: 'indexedDB',
  localStorage: 'localStorage',
  serviceWorkers: 'serviceWorkers',
  webSQL: 'webSQL'
}

let ses: Session | null = null

lifecycle.on('ready', (session) => {
  ses = session
})

interface RemovalOptions {
  since: number
  origins?: string[]
  excludeOrigins?: string[]
  includeExtensions: boolean
}

function toOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new ExtensionError('Invalid origin.')
  try {
    const origin = new URL(value).origin
    if (origin === 'null') throw new Error()
    return origin
  } catch {
    throw new ExtensionError(`Invalid origin: "${value}".`)
  }
}

function readOptions(value: unknown): RemovalOptions {
  const d = asObject(value)
  const since = d.since === undefined ? 0 : d.since
  if (typeof since !== 'number' || !Number.isFinite(since)) throw new ExtensionError("Invalid 'since'.")
  if (d.origins !== undefined && d.excludeOrigins !== undefined) throw new ExtensionError("'origins' and 'excludeOrigins' can't be used together.")
  const list = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v)) throw new ExtensionError(`Invalid '${name}'.`)
    if (name === 'origins' && !v.length) throw new ExtensionError("'origins' can't be empty.")
    return v.map(toOrigin)
  }
  const originTypes = asObject(d.originTypes)
  return {
    since,
    origins: list(d.origins, 'origins'),
    excludeOrigins: list(d.excludeOrigins, 'excludeOrigins'),
    includeExtensions: originTypes.extension === true
  }
}

function readTypes(value: unknown): DataType[] {
  const d = asObject(value)
  return ALL_TYPES.filter((t) => d[t] === true)
}

/** Removes history entries visited since `since` (all of it for 0). */
function removeHistory(since: number): void {
  if (since <= 0) {
    store.clearHistory()
    return
  }
  for (const entry of store.searchHistory('', Number.MAX_SAFE_INTEGER)) {
    if (entry.lastVisit >= since) store.removeHistory(entry.url)
  }
}

async function removeData(options: RemovalOptions, types: DataType[]): Promise<void> {
  if (!ses) throw new ExtensionError('Browsing data is not available yet.')
  if (options.origins && types.some((t) => !ORIGIN_TYPES.has(t))) {
    throw new ExtensionError("Removing these data types isn't supported with an 'origins' filter; only cookies, storage and cache are.")
  }
  const jobs: Promise<unknown>[] = []
  const dataTypes = types.map((t) => CLEAR_DATA[t]).filter((t): t is NonNullable<typeof t> => !!t)
  if (dataTypes.length) {
    const clear: ClearDataOptions = { dataTypes }
    if (options.origins) clear.origins = options.origins
    else {
      // Extensions' own storage survives unless asked for.
      const exclude = [...(options.excludeOrigins ?? [])]
      if (!options.includeExtensions) for (const ext of allLoadedExtensions()) exclude.push(new URL(ext.url).origin)
      if (exclude.length) clear.excludeOrigins = [...new Set(exclude)]
    }
    jobs.push(ses.clearData(clear))
  }
  if (types.includes('cacheStorage')) {
    // Not one of clearData's types; clearStorageData takes one origin at a time.
    if (options.origins) for (const origin of options.origins) jobs.push(ses.clearStorageData({ origin, storages: ['cachestorage'] }))
    else jobs.push(ses.clearStorageData({ storages: ['cachestorage'] }))
  }
  if (types.includes('history')) removeHistory(options.since)
  await Promise.all(jobs)
}

function remover(types: DataType[] | null) {
  return async (_call: CallContext, options: unknown, dataToRemove?: unknown): Promise<void> => {
    await removeData(readOptions(options), types ?? readTypes(dataToRemove))
  }
}

function settings(): Record<string, unknown> {
  const selected = new Set<DataType>(['cache', 'cacheStorage', 'cookies', 'fileSystems', 'history', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'])
  return {
    options: { since: 0, originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false } },
    dataToRemove: Object.fromEntries(ALL_TYPES.map((t) => [t, selected.has(t)])),
    dataRemovalPermitted: Object.fromEntries(ALL_TYPES.map((t) => [t, true]))
  }
}

defineApi('browsingData', {
  permissions: ['browsingData'],
  methods: {
    settings,
    remove: remover(null),
    removeAppcache: remover(['appcache']),
    removeCache: remover(['cache']),
    removeCacheStorage: remover(['cacheStorage']),
    removeCookies: remover(['cookies']),
    removeDownloads: remover(['downloads']),
    removeFileSystems: remover(['fileSystems']),
    removeFormData: remover(['formData']),
    removeHistory: remover(['history']),
    removeIndexedDB: remover(['indexedDB']),
    removeLocalStorage: remover(['localStorage']),
    removePasswords: remover(['passwords']),
    removePluginData: remover(['pluginData']),
    removeServiceWorkers: remover(['serviceWorkers']),
    removeWebSQL: remover(['webSQL'])
  }
})
