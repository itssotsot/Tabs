// Our copy of @ghostery/adblocker-electron-preload (element hiding and scriptlets).
//
// The original listens for `unload`, and any page with an unload listener is
// excluded from the back/forward cache, so Back/Forward always reloaded. This
// version cleans up on `pagehide` instead. src/main/adblock.ts unregisters the
// original preload.
import { DOMMonitor } from '@ghostery/adblocker-content'
import { ipcRenderer } from 'electron'

const INJECT = '@ghostery/adblocker/inject-cosmetic-filters'
const MUTATION_OBSERVER = '@ghostery/adblocker/is-mutation-observer-enabled'

function inject(data?: unknown): void {
  // Rejects when blocking is turned off (no handler registered); that's fine.
  ipcRenderer.invoke(INJECT, window.location.href, data).catch(() => {})
}

export function installCosmeticFiltering(): void {
  if (window !== window.top || window.location.href.startsWith('devtools://')) return

  let monitor: DOMMonitor | null = null
  inject()

  window.addEventListener(
    'DOMContentLoaded',
    () => {
      monitor = new DOMMonitor((update) => {
        if (update.type === 'features') inject({ ...update })
      })
      monitor.queryAll(window)
      ipcRenderer
        .invoke(MUTATION_OBSERVER)
        .then((enabled) => enabled && monitor?.start(window))
        .catch(() => {})
    },
    { once: true, passive: true }
  )

  // A page going into the back/forward cache (persisted) keeps its monitor.
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return
    monitor?.stop()
    monitor = null
  })
}
