import { app, dialog, net, shell } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { UpdateReady } from '@shared/types'
import { profile } from './env'

/**
 * Updates come from GitHub Releases (`publish` in electron-builder.yml; `npm run release` uploads them).
 *
 * Windows installs them the usual way: download in the background, install on restart.
 * The Mac app isn't signed with a Developer ID, which Squirrel.Mac needs to swap the app
 * in place, so there we download the new DMG ourselves and open it when you choose to update.
 */
const RELEASES = 'https://github.com/itssotsot/tabs/releases/download'
const FIRST_CHECK_DELAY = 10_000
const CHECK_EVERY = 4 * 60 * 60 * 1000

const isMac = process.platform === 'darwin'
// Profiles are for testing a second account next to the first; one copy updating is enough.
const enabled = app.isPackaged && !profile

let ready: UpdateReady | null = null
let dmgPath: string | null = null
let downloading: string | null = null
let listener: (update: UpdateReady | null) => void = () => {}

const updatesDir = (): string => join(app.getPath('userData'), 'Updates')

export function pendingUpdate(): UpdateReady | null {
  return ready
}

function setReady(version: string): void {
  ready = { version }
  listener(ready)
}

/** Downloads this Mac's DMG from the release and checks it against the hash electron-builder published. */
async function downloadDmg(info: UpdateInfo): Promise<void> {
  if (downloading === info.version || ready?.version === info.version) return
  const file = info.files.find((f) => f.url.endsWith(`-${process.arch}.dmg`))
  if (!file) return console.error(`[updates] ${info.version} has no DMG for ${process.arch}`)

  downloading = info.version
  try {
    await rm(updatesDir(), { recursive: true, force: true })
    await mkdir(updatesDir(), { recursive: true })
    const path = join(updatesDir(), basename(file.url))

    const res = await net.fetch(`${RELEASES}/v${info.version}/${file.url}`)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const hash = createHash('sha512')
    await pipeline(
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(path)
    )
    if (hash.digest('base64') !== file.sha512) throw new Error('The download is damaged (checksum mismatch)')

    dmgPath = path
    setReady(info.version)
  } catch (err) {
    console.error('[updates] DMG download failed', err)
  } finally {
    downloading = null
  }
}

export function setupUpdates(onChange: (update: UpdateReady | null) => void): void {
  listener = onChange
  if (!enabled) return

  // A DMG left from the last update (or one you skipped; it downloads again if it's still newest).
  if (isMac) void rm(updatesDir(), { recursive: true, force: true })

  autoUpdater.autoDownload = !isMac
  autoUpdater.autoInstallOnAppQuit = !isMac
  autoUpdater.on('update-available', (info) => isMac && void downloadDmg(info))
  autoUpdater.on('update-downloaded', (info) => setReady(info.version))
  autoUpdater.on('error', (err) => console.error('[updates]', err))

  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY)
  setInterval(check, CHECK_EVERY)
}

/** Installs the downloaded update: restarts on Windows; on a Mac, opens the DMG and quits so the app can be replaced. */
export async function installUpdate(): Promise<void> {
  if (!ready) return
  if (!isMac) return autoUpdater.quitAndInstall(true, true)

  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `Update to Tabs ${ready.version}`,
    detail:
      'Tabs will quit and open the new version. Drag Tabs onto the Applications folder, choose Replace, then open Tabs again. Your tabs will be where you left them.',
    buttons: ['Quit and Update', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0 || !dmgPath) return
  const error = await shell.openPath(dmgPath)
  if (error) {
    dialog.showErrorBox("Couldn't open the update", error)
    return
  }
  app.quit()
}

/** "Check for Updates…" in the menus. */
export async function checkForUpdatesNow(): Promise<void> {
  const info = (message: string, detail?: string): void => void dialog.showMessageBox({ type: 'info', message, detail })
  if (!enabled) return info('Updates are off', 'Only the installed app checks for updates, and not in a second profile.')
  if (ready) return installUpdate()
  if (downloading) return info(`Downloading Tabs ${downloading}…`, 'An Update button appears in the toolbar when it’s ready.')

  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) return info('You’re up to date', `Tabs ${app.getVersion()} is the newest version.`)
    info(`Downloading Tabs ${result.updateInfo.version}…`, 'An Update button appears in the toolbar when it’s ready.')
  } catch (err) {
    dialog.showErrorBox('Couldn’t check for updates', err instanceof Error ? err.message : String(err))
  }
}
