import { JsonFile } from '../../../store'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { createSyncArea, SyncError, type Changes, type Items } from './sync-area'

/**
 * chrome.storage.sync. Electron's own object fails every call ("sync" is not available), so the
 * extension side (custom/data.ts) swaps in one backed by this per-extension JSON store. Nothing
 * syncs anywhere: like Chrome signed out, the data just stays on this computer, with Chrome's
 * quotas and errors (sync-area.ts).
 */

let file: JsonFile<{ extensions: Record<string, Items> }> | null = null

function data(): Record<string, Items> {
  file ??= new JsonFile('extension-storage-sync', { extensions: {} })
  return file.data.extensions
}

const area = createSyncArea({
  read: (extensionId) => data()[extensionId] ?? {},
  write: (extensionId, items) => {
    if (Object.keys(items).length) data()[extensionId] = items
    else delete data()[extensionId]
    file!.save()
  }
})

/** Runs an area operation with its errors as API errors. */
function run<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    throw err instanceof SyncError ? new ExtensionError(err.message) : err
  }
}

/** Reaches chrome.storage.sync.onChanged and (through the extension side) chrome.storage.onChanged. */
function changed(extensionId: string, changes: Changes): void {
  if (Object.keys(changes).length) emit('storage.sync.onChanged', [changes], { extensionId })
}

defineApi('storage.sync', {
  permissions: ['storage'],
  methods: {
    get: (call: CallContext, keys) => run(() => area.get(call.extensionId, keys)),
    getKeys: (call: CallContext) => area.keys(call.extensionId),
    set: (call: CallContext, items) => changed(call.extensionId, run(() => area.set(call.extensionId, items))),
    remove: (call: CallContext, keys) => changed(call.extensionId, run(() => area.remove(call.extensionId, keys))),
    clear: (call: CallContext) => changed(call.extensionId, run(() => area.clear(call.extensionId))),
    getBytesInUse: (call: CallContext, keys) => area.bytesInUse(call.extensionId, keys),
    setAccessLevel: () => {
      // Chrome only lets storage.session change who can see it.
      throw new ExtensionError('This StorageArea is not available for setting access level')
    }
  }
})

defineEvent('storage.sync.onChanged', { permissions: ['storage'] })

lifecycle.on('uninstalled', (extensionId) => {
  area.forget(extensionId)
  if (!data()[extensionId]) return
  delete data()[extensionId]
  file!.save()
})
