import { EventEmitter } from 'node:events'
import type { Extension, Session } from 'electron'

/**
 * Extension lifecycle for the API modules: when an extension starts running (and why), stops,
 * or is uninstalled. Modules reset per-extension state here (context menus on update, network
 * rules on uninstall…).
 */

export type LoadReason = 'install' | 'update' | 'startup' | 'enable'

interface LifecycleEvents {
  /** The web session is set up; runs once, before any extension loads. */
  ready: [session: Session]
  /** An extension was loaded. `previousVersion` is set for updates. */
  loaded: [extension: Extension, reason: LoadReason, previousVersion: string | undefined]
  /** An extension stopped running (turned off, updated, or uninstalled). */
  unloaded: [extensionId: string]
  /** An extension was removed for good; forget everything about it. */
  uninstalled: [extensionId: string]
}

class Lifecycle extends EventEmitter<LifecycleEvents> {}

export const lifecycle = new Lifecycle()
lifecycle.setMaxListeners(100)
