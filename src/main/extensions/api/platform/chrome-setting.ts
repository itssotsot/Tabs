import { hasApiPermission, loadedExtension } from '../../access'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError } from '../../router'
import { getGlobalState, getState, setGlobalState, setState } from '../../state'

/**
 * Chrome's `types.ChromeSetting` (https://developer.chrome.com/docs/extensions/reference/api/types):
 * browser settings extensions can take over, like chrome.privacy.* and chrome.proxy.settings.
 *
 * Every extension may set a value; the one installed most recently wins, and its value is applied
 * until it clears it or stops running. `levelOfControl` tells each extension where it stands.
 * Extension pages reach the settings through the internal `chromeSetting` namespace (see
 * src/preload/extension-api/custom/platform.ts), which checks the setting's permission.
 */

export type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'

export interface SettingDefinition<T> {
  /** Dotted path under chrome, e.g. `privacy.network.webRTCIPHandlingPolicy`. */
  path: string
  /** Needed to read, set and hear about the setting. */
  permission: string
  /** The value when no extension controls the setting. */
  defaultValue: T | (() => T)
  /** Checks and normalizes a value from `set`; throws ExtensionError when it's invalid. */
  validate?: (value: unknown) => T
  /** Puts the effective value into effect whenever it changes. */
  apply?: (value: T, controller: string | null) => void
  /** Replaces the default `<path>.onChange` event (fontSettings has its own events). */
  notify?: (setting: Setting<T>) => void
}

interface Entry {
  value: unknown
  /** When it was set, to keep a stable order among one extension's settings. */
  at: number
}

type Stored = Record<string, Record<string, Entry>>

const STATE_KEY = 'chromeSettings'
const PRECEDENCE_KEY = 'settingsPrecedence'

function stored(): Stored {
  return getGlobalState<Stored>(STATE_KEY, {})
}

/** Paths of settings some extension has set (for settings defined on demand, like fonts per script). */
export function storedSettingPaths(): string[] {
  return Object.keys(stored())
}

function save(data: Stored): void {
  setGlobalState(STATE_KEY, data)
}

/** Later installs take precedence, like in Chrome. Recorded the first time we see an extension. */
export function extensionPrecedence(extensionId: string): number {
  return getState<number>(extensionId, PRECEDENCE_KEY, 0)
}

const precedence = extensionPrecedence

export class Setting<T> {
  private lastValue: string
  private lastController: string | null = null

  constructor(readonly def: SettingDefinition<T>) {
    this.lastValue = JSON.stringify(this.defaultValue())
  }

  get path(): string {
    return this.def.path
  }

  defaultValue(): T {
    const d = this.def.defaultValue
    return typeof d === 'function' ? (d as () => T)() : d
  }

  /** Entries from running extensions that (still) have the permission, highest precedence first. */
  private candidates(): [string, Entry][] {
    const entries = Object.entries(stored()[this.path] ?? {})
    return entries
      .filter(([id]) => !!loadedExtension(id) && hasApiPermission(id, this.def.permission))
      .sort(([a, ea], [b, eb]) => precedence(b) - precedence(a) || eb.at - ea.at)
  }

  /** The extension whose value is in effect, if any. */
  controller(): string | null {
    return this.candidates()[0]?.[0] ?? null
  }

  value(): T {
    const top = this.candidates()[0]
    return top ? (top[1].value as T) : this.defaultValue()
  }

  levelOfControl(extensionId: string): LevelOfControl {
    if (!hasApiPermission(extensionId, this.def.permission)) return 'not_controllable'
    const controller = this.controller()
    if (controller === extensionId) return 'controlled_by_this_extension'
    if (controller && precedence(controller) > precedence(extensionId)) return 'controlled_by_other_extensions'
    return 'controllable_by_this_extension'
  }

  /** What `get` returns to an extension. */
  details(extensionId: string): { value: T; levelOfControl: LevelOfControl } {
    return { value: this.value(), levelOfControl: this.levelOfControl(extensionId) }
  }

  set(extensionId: string, raw: unknown): void {
    const value = this.def.validate ? this.def.validate(raw) : (raw as T)
    const data = stored()
    data[this.path] = { ...data[this.path], [extensionId]: { value, at: Date.now() } }
    save(data)
    this.refresh()
  }

  clear(extensionId: string): void {
    const data = stored()
    if (!data[this.path]?.[extensionId]) return
    delete data[this.path][extensionId]
    if (!Object.keys(data[this.path]).length) delete data[this.path]
    save(data)
    this.refresh()
  }

  /** Re-evaluates who controls the setting; applies and announces a change (`quiet`: apply only). */
  refresh(quiet = false): void {
    const value = this.value()
    const controller = this.controller()
    const serialized = JSON.stringify(value)
    if (serialized === this.lastValue && controller === this.lastController) return
    const valueChanged = serialized !== this.lastValue
    this.lastValue = serialized
    this.lastController = controller
    if (valueChanged) {
      try {
        this.def.apply?.(value, controller)
      } catch (err) {
        console.error(`[extensions] couldn't apply ${this.path}`, err)
      }
    }
    if (quiet) return
    if (this.def.notify) this.def.notify(this)
    else emit(`${this.path}.onChange`, (id) => [this.details(id)])
  }
}

const settings = new Map<string, Setting<unknown>>()

/** Registers a ChromeSetting (and its `onChange` event unless it brings its own notification). */
export function defineSetting<T>(def: SettingDefinition<T>): Setting<T> {
  const setting = new Setting<T>(def)
  settings.set(def.path, setting as Setting<unknown>)
  if (!def.notify) defineEvent(`${def.path}.onChange`, { permissions: [def.permission] })
  return setting
}

function settingFor(extensionId: string, path: unknown): Setting<unknown> {
  const setting = typeof path === 'string' ? settings.get(path) : undefined
  if (!setting) throw new ExtensionError('Unknown setting.')
  if (!hasApiPermission(extensionId, setting.def.permission)) {
    throw new ExtensionError(
      `You do not have permission to access the preference '${String(path)}'. Be sure to declare in your manifest what permissions you need.`
    )
  }
  return setting
}

const SCOPES = new Set(['regular', 'regular_only', 'incognito_persistent', 'incognito_session_only'])

/** Tabs has no incognito windows, so incognito preferences are off limits (as for extensions not allowed in incognito). */
export function checkScope(details: unknown): void {
  const d = (details && typeof details === 'object' ? details : {}) as { scope?: unknown; incognito?: unknown }
  if (d.incognito === true) throw new ExtensionError('You do not have permission to access incognito preferences.')
  if (d.scope === undefined) return
  if (typeof d.scope !== 'string' || !SCOPES.has(d.scope)) throw new ExtensionError(`Invalid scope: ${String(d.scope)}.`)
  if (d.scope.startsWith('incognito')) throw new ExtensionError("You cannot set a preference for incognito when you are not allowed to access incognito.")
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

defineApi('chromeSetting', {
  methods: {
    get: (call, path, details) => {
      const setting = settingFor(call.extensionId, path)
      checkScope({ incognito: asObject(details).incognito })
      return setting.details(call.extensionId)
    },
    set: (call, path, details) => {
      const setting = settingFor(call.extensionId, path)
      const d = asObject(details)
      if (!('value' in d)) throw new ExtensionError("Missing required property 'value'.")
      checkScope(d)
      setting.set(call.extensionId, d.value)
    },
    clear: (call, path, details) => {
      const setting = settingFor(call.extensionId, path)
      checkScope(asObject(details))
      setting.clear(call.extensionId)
    }
  }
})

function refreshAll(quiet = false): void {
  for (const setting of settings.values()) setting.refresh(quiet)
}

lifecycle.on('loaded', (extension, reason) => {
  if (!precedence(extension.id)) setState(extension.id, PRECEDENCE_KEY, Date.now())
  // Settings restored at startup aren't changes.
  refreshAll(reason === 'startup')
})

lifecycle.on('unloaded', () => {
  // The extension is still listed as loaded while its unload event runs.
  setTimeout(refreshAll, 0)
})

lifecycle.on('uninstalled', (extensionId) => {
  const data = stored()
  let changed = false
  for (const path of Object.keys(data)) {
    if (!data[path][extensionId]) continue
    delete data[path][extensionId]
    if (!Object.keys(data[path]).length) delete data[path]
    changed = true
  }
  if (changed) save(data)
  refreshAll()
})

/** Shared validators for setting values. */
export const validators = {
  boolean: (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new ExtensionError('Invalid value: expected a boolean.')
    return value
  },
  oneOf:
    <T extends string>(...allowed: T[]) =>
    (value: unknown): T => {
      if (typeof value !== 'string' || !(allowed as string[]).includes(value)) {
        throw new ExtensionError(`Invalid value: expected one of ${allowed.map((a) => `"${a}"`).join(', ')}.`)
      }
      return value as T
    }
}
