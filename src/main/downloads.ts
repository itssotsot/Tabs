import { app, shell, type DownloadItem, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { DownloadAction } from '@shared/api'
import type { DownloadState } from '@shared/types'

interface Tracked {
  state: DownloadState
  item: DownloadItem | null
  /** Where the file goes once it's complete, when that changed after the download started. */
  retarget?: string
}

/** Where a new download is saved, decided by whoever started it (a Chrome extension). */
export interface DownloadPlan {
  /** Full path. Without one, the usual unique name in the Downloads folder. */
  path?: string
  /** Ask where to save it (the save dialog), starting at `path`. */
  saveAs?: boolean
}

/** Download changes, for code that follows along (chrome.downloads). Ids are the DownloadState ids. */
interface DownloadEventMap {
  created: [id: string, item: DownloadItem]
  /** Progress, pause, completion, a new target file… (not coalesced). */
  changed: [id: string]
  /** Removed from the list. */
  removed: [id: string]
}

export const downloadEvents = new EventEmitter<DownloadEventMap>()

let planner: (item: DownloadItem) => DownloadPlan | null = () => null

/** Lets chrome.downloads decide where the downloads it started are saved. */
export function setDownloadPlanner(fn: (item: DownloadItem) => DownloadPlan | null): void {
  planner = fn
}

const downloads = new Map<string, Tracked>()
let nextId = 1
let listener: (list: DownloadState[]) => void = () => {}
let pushTimer: NodeJS.Timeout | null = null

/** A download's state and, while it's running, its Electron item. */
export function downloadEntry(id: string): { state: DownloadState; item: DownloadItem | null } | null {
  const d = downloads.get(id)
  return d ? { state: d.state, item: d.item } : null
}

/**
 * Changes where a running or finished download's file ends up (chrome.downloads.onDeterminingFilename
 * decides after the bytes started arriving). A finished file is renamed now, a running one when it's done.
 */
export function retargetDownload(id: string, path: string): void {
  const d = downloads.get(id)
  if (!d || path === d.state.path) return
  if (d.state.state === 'completed') {
    try {
      mkdirSync(dirname(path), { recursive: true })
      renameSync(d.state.path, path)
    } catch {
      return
    }
  } else if (d.state.state === 'progressing') {
    d.retarget = path
  } else return
  d.state = { ...d.state, path, filename: path.split(/[\\/]/).pop() ?? d.state.filename }
  downloadEvents.emit('changed', id)
  push()
}

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
    const plan = planner(item)
    const path = plan?.path ?? uniquePath(app.getPath('downloads'), item.getFilename())
    if (plan?.saveAs) {
      // No save path: Electron asks where to save it.
      item.setSaveDialogOptions({ defaultPath: path })
    } else {
      // Electron creates missing folders.
      item.setSavePath(path)
    }

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

    /** The path picked in the save dialog, once there is one. */
    const syncChosenPath = (): void => {
      const chosen = plan?.saveAs ? item.getSavePath() : ''
      if (chosen && chosen !== tracked.state.path && !tracked.retarget) {
        tracked.state = { ...tracked.state, path: chosen, filename: chosen.split(/[\\/]/).pop() ?? tracked.state.filename }
      }
    }

    item.on('updated', (_e, state) => {
      syncChosenPath()
      tracked.state = {
        ...tracked.state,
        state: state === 'interrupted' ? 'interrupted' : 'progressing',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        paused: item.isPaused()
      }
      downloadEvents.emit('changed', id)
      push()
    })
    item.once('done', (_e, state) => {
      syncChosenPath()
      tracked.state = { ...tracked.state, state, receivedBytes: item.getReceivedBytes(), paused: false }
      tracked.item = null
      const target = tracked.retarget
      tracked.retarget = undefined
      if (state === 'completed' && target) {
        try {
          mkdirSync(dirname(target), { recursive: true })
          renameSync(item.getSavePath() || path, target)
          tracked.state = { ...tracked.state, path: target }
        } catch {
          // Keep the file where it is.
          const saved = item.getSavePath() || path
          tracked.state = { ...tracked.state, path: saved, filename: saved.split(/[\\/]/).pop() ?? tracked.state.filename }
        }
      }
      if (state === 'completed' && process.platform === 'darwin') app.dock?.downloadFinished(tracked.state.path)
      downloadEvents.emit('changed', id)
      push()
    })
    downloadEvents.emit('created', id, item)
    push()
  })
}

export function downloadAction(action: DownloadAction, id?: string): void {
  if (action === 'clear') {
    for (const [key, d] of downloads) {
      if (d.state.state === 'progressing') continue
      downloads.delete(key)
      downloadEvents.emit('removed', key)
    }
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
      downloadEvents.emit('removed', d.state.id)
      break
  }
  push()
}
