import { app, shell, type DownloadItem, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DownloadAction } from '@shared/api'
import type { DownloadState } from '@shared/types'

interface Tracked {
  state: DownloadState
  item: DownloadItem | null
}

const downloads = new Map<string, Tracked>()
let nextId = 1
let listener: (list: DownloadState[]) => void = () => {}
let pushTimer: NodeJS.Timeout | null = null

export function listDownloads(): DownloadState[] {
  return [...downloads.values()].map((d) => d.state).sort((a, b) => b.startTime - a.startTime)
}

function push(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    listener(listDownloads())
  }, 150)
}

/** "file.zip" -> "file (1).zip" when the name is taken. */
function uniquePath(dir: string, filename: string): string {
  const ext = extname(filename)
  const base = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${base} (${i})${ext}`)
  return candidate
}

export function setupDownloads(ses: Session, onChange: (list: DownloadState[]) => void): void {
  listener = onChange
  ses.on('will-download', (_event, item) => {
    const id = String(nextId++)
    const path = uniquePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(path)

    const tracked: Tracked = {
      item,
      state: {
        id,
        filename: path.split(/[\\/]/).pop() ?? item.getFilename(),
        path,
        url: item.getURL(),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        paused: false,
        startTime: Date.now()
      }
    }
    downloads.set(id, tracked)

    item.on('updated', (_e, state) => {
      tracked.state = {
        ...tracked.state,
        state: state === 'interrupted' ? 'interrupted' : 'progressing',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        paused: item.isPaused()
      }
      push()
    })
    item.once('done', (_e, state) => {
      tracked.state = { ...tracked.state, state, receivedBytes: item.getReceivedBytes(), paused: false }
      tracked.item = null
      if (state === 'completed' && process.platform === 'darwin') app.dock?.downloadFinished(path)
      push()
    })
    push()
  })
}

export function downloadAction(action: DownloadAction, id?: string): void {
  if (action === 'clear') {
    for (const [key, d] of downloads) if (d.state.state !== 'progressing') downloads.delete(key)
    return push()
  }
  const d = id ? downloads.get(id) : undefined
  if (!d) return
  switch (action) {
    case 'open':
      void shell.openPath(d.state.path)
      break
    case 'show':
      shell.showItemInFolder(d.state.path)
      break
    case 'cancel':
      d.item?.cancel()
      break
    case 'pause':
      d.item?.pause()
      break
    case 'resume':
      if (d.item?.canResume()) d.item.resume()
      break
    case 'remove':
      d.item?.cancel()
      downloads.delete(d.state.id)
      break
  }
  push()
}
