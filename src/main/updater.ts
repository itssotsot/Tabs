import { app, dialog, net, shell } from 'electron'
import { autoUpdater, type UpdateFileInfo, type UpdateInfo } from 'electron-updater'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, createWriteStream, existsSync, openSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import type { UpdateReady } from '@shared/types'
import { profile } from './env'

/**
 * Updates come from GitHub Releases (`publish` in electron-builder.yml; `npm run release` uploads them).
 *
 * Windows installs them the usual way: download in the background, install on restart (or on quit).
 *
 * Squirrel.Mac only swaps apps signed with a Developer ID, which the Mac build doesn't have, so the Mac
 * does it itself: download the release's zip, unpack it, check it's Tabs signed by the same team as
 * this copy, and when Tabs quits, a small script swaps the new app in and (after Update) reopens it.
 * Where Tabs can't replace itself (run from the DMG or Downloads, a folder you can't write to), it
 * downloads the DMG instead and opens it for you to drag over.
 *
 * BROWSERR_UPDATE_FEED=<url> points a packaged copy at another feed (latest-mac.yml and the files next to
 * it), even in a profile, for testing updates end to end.
 */
const RELEASES = 'https://github.com/itssotsot/tabs/releases/download'
const FIRST_CHECK_DELAY = 10_000
const CHECK_EVERY = 4 * 60 * 60 * 1000

const isMac = process.platform === 'darwin'
const testFeed = app.isPackaged ? process.env.BROWSERR_UPDATE_FEED?.replace(/\/+$/, '') || null : null
// Profiles are for testing a second account next to the first; one copy updating is enough.
const enabled = app.isPackaged && (!profile || !!testFeed)

const run = promisify(execFile)

/** A new Tabs.app, unpacked and checked, waiting for Tabs to quit so it can take this one's place. */
interface StagedApp {
  path: string
  /** Reopen Tabs once it's swapped (Update); otherwise it's just installed for next time (quit). */
  relaunch: boolean
}

let ready: UpdateReady | null = null
let staged: StagedApp | null = null
let dmgPath: string | null = null
let downloading: string | null = null
let listener: (update: UpdateReady | null) => void = () => {}

const updatesDir = (): string => join(app.getPath('userData'), 'Updates')
/** The running Tabs.app (…/Tabs.app/Contents/MacOS/Tabs). */
const bundlePath = (): string => resolve(app.getPath('exe'), '../../..')

export function pendingUpdate(): UpdateReady | null {
  return ready
}

function setReady(version: string): void {
  ready = { version }
  listener(ready)
}

function fileUrl(info: UpdateInfo, file: UpdateFileInfo): string {
  return testFeed ? `${testFeed}/${file.url}` : `${RELEASES}/v${info.version}/${file.url}`
}

/** Downloads a file from the release and checks it against the hash electron-builder published. */
async function download(info: UpdateInfo, file: UpdateFileInfo): Promise<string> {
  const path = join(updatesDir(), basename(file.url))
  const res = await net.fetch(fileUrl(info, file))
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
  if (hash.digest('base64') !== file.sha512) throw new Error(`${file.url} is damaged (checksum mismatch)`)
  return path
}

/**
 * Whether this copy can be swapped for a new one: not on a read-only volume (the DMG, or the hidden copy macOS
 * runs apps from Downloads in), in a folder you can write to, and on the same disk as the Updates folder, so
 * the swap is two renames rather than a slow copy that could be cut short.
 */
function canReplaceSelf(): boolean {
  const bundle = bundlePath()
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return statSync(dirname(bundle)).dev === statSync(updatesDir()).dev
  } catch {
    return false
  }
}

/** The team a Tabs.app is signed by, or null if it isn't signed by one. */
async function signingTeam(bundle: string): Promise<string | null> {
  // codesign prints the details on stderr.
  const { stderr } = await run('codesign', ['-dv', '--verbose=2', bundle]).catch((err) => ({ stderr: String(err.stderr ?? '') }))
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim()
  return team && team !== 'not set' ? team : null
}

async function plistValue(bundle: string, key: string): Promise<string> {
  const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  return stdout.trim()
}

/** Downloads the zip, unpacks it and checks the app inside is the new Tabs, intact and signed by this copy's team. */
async function stageApp(info: UpdateInfo): Promise<string> {
  const file = info.files.find((f) => f.url.endsWith(`-${process.arch}.zip`))
  if (!file) throw new Error(`${info.version} has no zip for ${process.arch}`)
  const zip = await download(info, file)

  const into = join(updatesDir(), 'staged')
  await run('ditto', ['-x', '-k', zip, into])
  await rm(zip, { force: true })
  const next = join(into, basename(bundlePath()))
  if (!existsSync(next)) throw new Error(`the zip has no ${basename(bundlePath())}`)

  const current = bundlePath()
  const [id, version, team, ourId, ourTeam] = await Promise.all([
    plistValue(next, 'CFBundleIdentifier'),
    plistValue(next, 'CFBundleShortVersionString'),
    signingTeam(next),
    plistValue(current, 'CFBundleIdentifier'),
    signingTeam(current)
  ])
  if (id !== ourId) throw new Error(`the zip holds ${id}, not ${ourId}`)
  if (version !== info.version) throw new Error(`the zip holds version ${version}, not ${info.version}`)
  if (!ourTeam || team !== ourTeam) throw new Error(`the new app is signed by team ${team ?? 'none'}, this one by ${ourTeam ?? 'none'}`)
  // Every file is still what was signed.
  await run('codesign', ['--verify', '--deep', '--strict', next])
  return next
}

async function prepareUpdate(info: UpdateInfo): Promise<void> {
  if (downloading === info.version || ready?.version === info.version) return
  downloading = info.version
  try {
    await rm(updatesDir(), { recursive: true, force: true })
    await mkdir(updatesDir(), { recursive: true })
    if (canReplaceSelf()) {
      try {
        staged = { path: await stageApp(info), relaunch: false }
        return setReady(info.version)
      } catch (err) {
        console.error('[updates] Tabs can’t update itself this time, falling back to the DMG:', err)
      }
    }
    const file = info.files.find((f) => f.url.endsWith(`-${process.arch}.dmg`))
    if (!file) throw new Error(`${info.version} has no DMG for ${process.arch}`)
    dmgPath = await download(info, file)
    setReady(info.version)
  } catch (err) {
    console.error('[updates] download failed', err)
  } finally {
    downloading = null
  }
}

/**
 * Waits for Tabs to quit, swaps the new app in with two renames (putting the old one back if the second fails),
 * and reopens it after Update (with any arguments after the first five). It ignores the signals logging out
 * sends, so it can't stop between the renames.
 */
const SWAP_SCRIPT = `#!/bin/bash
trap '' TERM HUP INT
pid="$1"; app="$2"; next="$3"; previous="$4"; relaunch="$5"; shift 5
for _ in $(seq 1 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$pid" 2>/dev/null; then echo "Tabs didn't quit"; exit 1; fi
rm -rf "$previous"
mv "$app" "$previous" || { echo "couldn't move the old app aside"; exit 1; }
if mv "$next" "$app"; then
  rm -rf "$previous"
  echo "updated"
else
  mv "$previous" "$app"
  echo "couldn't move the new app in; restored the old one"
fi
[ "$relaunch" = 1 ] && open "$app" --args "$@"
exit 0
`

/** Starts the swap as Tabs quits. The script outlives Tabs; what it did goes to update-swap.log. */
function startSwap(): void {
  if (!staged || !existsSync(staged.path)) return
  const script = join(updatesDir(), 'swap.sh')
  writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 })
  // Outside Updates, which the next launch clears.
  const log = openSync(join(app.getPath('userData'), 'update-swap.log'), 'w')
  const args = [script, String(process.pid), bundlePath(), staged.path, join(updatesDir(), 'previous.app'), staged.relaunch ? '1' : '0']
  // Reopens in the same profile (only a test copy with BROWSERR_UPDATE_FEED updates in one).
  if (profile) args.push(`--profile=${profile}`)
  spawn('/bin/bash', args, { detached: true, stdio: ['ignore', log, log] }).unref()
  closeSync(log)
  staged = null
}

/**
 * The first time Tabs is opened from the DMG or Downloads, offers to move it to Applications, where it can
 * update itself. Asked once; "Not Now" is remembered.
 */
function offerMoveToApplications(): void {
  if (!isMac || !app.isPackaged || profile || app.isInApplicationsFolder()) return
  const declined = join(app.getPath('userData'), 'move-to-applications-declined')
  if (existsSync(declined)) return
  const response = dialog.showMessageBoxSync({
    type: 'question',
    message: 'Move Tabs to your Applications folder?',
    detail: 'From there, Tabs installs its updates by itself.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) {
    writeFileSync(declined, '')
    return
  }
  try {
    // Quits and relaunches from Applications. A copy already there is replaced, unless it's running.
    app.moveToApplicationsFolder({ conflictHandler: (conflict) => conflict === 'exists' })
  } catch (err) {
    dialog.showErrorBox('Couldn’t move Tabs', err instanceof Error ? err.message : String(err))
  }
}

export function setupUpdates(onChange: (update: UpdateReady | null) => void): void {
  listener = onChange
  offerMoveToApplications()
  if (!enabled) return

  if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
  // What's left from the last update: a DMG, an app that was staged, the old app, the swap script.
  if (isMac) void rm(updatesDir(), { recursive: true, force: true })

  autoUpdater.autoDownload = !isMac
  autoUpdater.autoInstallOnAppQuit = !isMac
  autoUpdater.on('update-available', (info) => isMac && void prepareUpdate(info))
  autoUpdater.on('update-downloaded', (info) => setReady(info.version))
  autoUpdater.on('error', (err) => console.error('[updates]', err))
  // A staged app goes in whenever Tabs quits, so an update you didn't click is there next time.
  if (isMac) app.on('will-quit', startSwap)

  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY)
  setInterval(check, CHECK_EVERY)
}

/** Installs the downloaded update: restarts into it (Windows, and a Mac that can update itself), or opens the DMG. */
export async function installUpdate(): Promise<void> {
  if (!ready) return
  if (!isMac) return autoUpdater.quitAndInstall(true, true)
  if (staged) {
    staged.relaunch = true
    return app.quit()
  }

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
