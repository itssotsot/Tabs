/**
 * The chrome.* namespaces we provide, described as data. `installNamespaces` runs in the
 * extension's world (see core.ts for the rules that implies) and turns each spec into methods
 * that call the main process, event objects, and constants.
 */

export interface NamespaceSpec {
  /** Path under `chrome`, e.g. `cookies` or `system.cpu`. */
  name: string
  /** Only when the manifest declares one of these permissions (in permissions or optional_permissions). */
  permissions?: string[]
  /** …or has this manifest key (e.g. `action`, `side_panel`). Without either, always available. */
  manifestKey?: string
  /** Replace Electron's own object for this namespace instead of adding to it. */
  replace?: boolean
  /** Methods implemented by the main-process module that defines this namespace. */
  methods?: string[]
  /** Methods to leave to Electron when it already has them. */
  keepNative?: string[]
  /** Events, `onSomething`. Use `{ response: true }` for ones whose listeners can answer. */
  events?: (string | { name: string; response?: boolean })[]
  /** Constants and enums. Added only where Electron doesn't already have them. */
  constants?: Record<string, unknown>
}

export function installNamespaces(specs: NamespaceSpec[]): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext) return
  for (const spec of specs) {
    try {
      const byPermission = spec.permissions?.some((p) => ext.declares(p)) ?? false
      const byKey = spec.manifestKey ? ext.hasManifestKey(spec.manifestKey) : false
      const gated = !!spec.permissions?.length || !!spec.manifestKey
      if (gated && !byPermission && !byKey) continue
      const target = ext.namespace(spec.name, spec.replace)
      const props: Record<string, unknown> = {}
      for (const method of spec.methods ?? []) {
        if (spec.keepNative?.includes(method) && typeof target[method] === 'function') continue
        props[method] = ext.fn(spec.name, method)
      }
      for (const e of spec.events ?? []) {
        const name = typeof e === 'string' ? e : e.name
        props[name] = ext.event(`${spec.name}.${name}`, typeof e === 'string' ? {} : { response: e.response })
      }
      for (const [key, value] of Object.entries(spec.constants ?? {})) {
        if (target[key] === undefined || spec.replace) props[key] = value
      }
      ext.define(target, props)
    } catch (err) {
      console.error(`[extensions] couldn't set up chrome.${spec.name}`, err)
    }
  }
}
