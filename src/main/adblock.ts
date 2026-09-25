import { app, type Session } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

let blocker: ElectronBlocker | null = null
let loading: Promise<ElectronBlocker | null> | null = null

function load(): Promise<ElectronBlocker | null> {
  loading ??= ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: join(app.getPath('userData'), 'adblock-engine.bin'),
    read: fs.readFile,
    write: fs.writeFile
  })
    .then((b) => (blocker = b))
    .catch((err) => {
      console.error('[adblock] failed to load filter lists', err)
      loading = null
      return null
    })
  return loading
}

export async function setAdblockEnabled(ses: Session, enabled: boolean): Promise<void> {
  if (enabled) {
    const b = await load()
    if (b && !b.isBlockingEnabled(ses)) b.enableBlockingInSession(ses)
  } else if (blocker?.isBlockingEnabled(ses)) {
    blocker.disableBlockingInSession(ses)
  }
}
