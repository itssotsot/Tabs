// What sites may do: use your camera, microphone, location and so on. Asked under the address bar
// (permission-prompts.ts), remembered per site (or allowed until you leave the page), with a default for
// each in settings. macOS's own camera and microphone access for Tabs is checked too.
import { BrowserWindow, desktopCapturer, dialog, shell, systemPreferences, webContents, type Session, type WebContents } from 'electron'
import { IPC } from '@shared/api'
import { SITE_PERMISSIONS } from '@shared/constants'
import type { DeviceChoice, PageSitePermissionState, SitePermission } from '@shared/types'
import { extensionHooks } from './extension-hooks'
import { askInPage } from './permission-prompts'
import { store } from './store'

/** Harmless permissions granted without asking, like Chrome does. */
const AUTO_GRANT = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'storage-access',
  'top-level-storage-access',
  'speaker-selection',
  'window-management'
])

type Device = 'camera' | 'microphone'
const isDevice = (p: SitePermission): p is Device => p === 'camera' || p === 'microphone'

/** What Electron asks for, as Tabs' permissions ("media" is the camera, the microphone or both). Null: always denied. */
function permissionsFor(permission: string, mediaTypes?: string[]): SitePermission[] | null {
  if (permission === 'media') {
    const types = mediaTypes?.length ? mediaTypes : ['video', 'audio']
    const wanted: SitePermission[] = []
    if (types.includes('video')) wanted.push('camera')
    if (types.includes('audio')) wanted.push('microphone')
    return wanted
  }
  return permission in SITE_PERMISSIONS ? [permission as SitePermission] : null
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

const hostOf = (url: string): string => originOf(url).replace(/^https?:\/\//, '')

/** chrome.contentSettings types for the permissions extensions can decide. */
const CONTENT_SETTING_TYPES: Partial<Record<SitePermission, string>> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'location',
  notifications: 'notifications',
  'clipboard-read': 'clipboard'
}

/** "Allow this time": for the page's site, until the tab leaves it. */
const allowedOnce = new WeakMap<WebContents, { origin: string; permissions: Set<SitePermission> }>()

function allowOnce(wc: WebContents, origin: string, permissions: SitePermission[]): void {
  const existing = allowedOnce.get(wc)
  if (existing?.origin === origin) {
    for (const p of permissions) existing.permissions.add(p)
    return
  }
  allowedOnce.set(wc, { origin, permissions: new Set(permissions) })
  const leave = (_e: unknown, url: string): void => {
    if (originOf(url) === origin) return
    allowedOnce.delete(wc)
    wc.off('did-navigate', leave)
  }
  wc.on('did-navigate', leave)
}

type Decision = 'allow' | 'deny' | 'ask'

function decide(wc: WebContents | null, permission: SitePermission, url: string, topUrl: string): Decision {
  const type = CONTENT_SETTING_TYPES[permission]
  const fromExtension = type ? extensionHooks.contentSetting(type, url, topUrl) : undefined
  if (fromExtension === 'block') return 'deny'
  if (fromExtension === 'allow') return 'allow'
  const origin = originOf(url)
  const once = wc && allowedOnce.get(wc)
  if (once?.origin === origin && once.permissions.has(permission)) return 'allow'
  const saved = store.getPermission(origin, permission)
  if (saved) return saved
  return store.settings.blockedPermissions.includes(permission) ? 'deny' : 'ask'
}

/** macOS's own access for Tabs to each device: granted, blocked (off in System Settings), or not asked yet. */
function systemAccess(device: Device): 'granted' | 'blocked' | 'unknown' {
  if (process.platform !== 'darwin') return 'granted'
  const status = systemPreferences.getMediaAccessStatus(device)
  return status === 'granted' ? 'granted' : status === 'not-determined' ? 'unknown' : 'blocked'
}

const SYSTEM_SETTINGS: Record<Device, string> = {
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

export interface PermissionHooks {
  /** The window a page is in, for the fallback dialog. */
  windowFor(wc: WebContents): BrowserWindow | null
  /** Whether a page is a tab's, which asks under the address bar. Others (extension popups) ask with a dialog. */
  isTab(wc: WebContents): boolean
  /** The browser's own UI and browserr:// pages, which may use devices (the prompt's camera preview, settings' lists). */
  isOwn(wc: WebContents): boolean
}

/** Tells you macOS isn't letting Tabs use the devices, with the way to change it. */
async function explainSystemBlock(wc: WebContents, url: string, blocked: Device[], hooks: PermissionHooks): Promise<void> {
  let open = false
  if (hooks.isTab(wc)) {
    const answer = await askInPage(wc, { kind: 'system', host: hostOf(url), blocked })
    open = answer.decision === 'open-system-settings'
  } else {
    const names = blocked.map((d) => SITE_PERMISSIONS[d].name.toLowerCase()).join(' and ')
    const options = {
      type: 'warning' as const,
      buttons: ['Open System Settings', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      message: `macOS isn't letting Tabs use your ${names}`,
      detail: `Turn on Tabs under Privacy & Security › ${blocked.map((d) => SITE_PERMISSIONS[d].name).join(' and ')} in System Settings, then reload the page.`
    }
    const parent = hooks.windowFor(wc)
    open = (parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)).response === 0
  }
  if (open) void shell.openExternal(SYSTEM_SETTINGS[blocked[0]])
}

/** The question for pages that aren't a tab's: a dialog, remembered unless you untick it. */
async function askWithDialog(parent: BrowserWindow | null, origin: string, permissions: SitePermission[]): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: ['Allow', 'Block'],
    defaultId: 0,
    cancelId: 1,
    message: `${hostOf(origin)} wants to ${permissions.map((p) => SITE_PERMISSIONS[p].wants).join(' and ')}`,
    checkboxLabel: 'Remember my choice for this site',
    checkboxChecked: true
  }
  const { response, checkboxChecked } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  const allowed = response === 0
  if (checkboxChecked) for (const p of permissions) store.setPermission(origin, p, allowed ? 'allow' : 'deny')
  return allowed
}

/** Asks you, under the address bar or in a dialog; true if you allowed it. */
async function askUser(wc: WebContents, url: string, permissions: SitePermission[], hooks: PermissionHooks): Promise<boolean> {
  const origin = originOf(url)
  if (!hooks.isTab(wc)) return askWithDialog(hooks.windowFor(wc) ?? BrowserWindow.getFocusedWindow(), origin, permissions)
  const answer = await askInPage(wc, {
    kind: 'ask',
    host: hostOf(url),
    permissions,
    devices: store.settings.devices,
    // Without macOS's access yet, a preview would bring up macOS's own question before you've answered this one.
    preview: permissions.filter(isDevice).filter((d) => systemAccess(d) === 'granted')
  })
  if (answer.decision === 'always' || answer.decision === 'block') {
    for (const p of permissions) store.setPermission(origin, p, answer.decision === 'always' ? 'allow' : 'deny')
  }
  if (answer.decision === 'once') allowOnce(wc, origin, permissions)
  return answer.decision === 'once' || answer.decision === 'always'
}

/** A page's question being asked, so another one from it waits for the answer (sites often ask twice at once). */
const asking = new WeakMap<WebContents, Promise<boolean>>()

async function request(wc: WebContents, url: string, wanted: SitePermission[], hooks: PermissionHooks): Promise<boolean> {
  const decisions = wanted.map((p) => decide(wc, p, url, wc.getURL()))
  if (decisions.includes('deny')) return false

  // Asking whether a site may use a device macOS has turned off for Tabs would be pointless.
  const devices = wanted.filter(isDevice)
  const blocked = devices.filter((d) => systemAccess(d) === 'blocked')
  if (blocked.length) {
    void explainSystemBlock(wc, url, blocked, hooks)
    return false
  }

  const toAsk = wanted.filter((_, i) => decisions[i] === 'ask')
  if (toAsk.length) {
    const earlier = asking.get(wc)
    if (earlier) {
      // Its answer may be this one's too. After a no, don't ask again right away.
      return (await earlier.catch(() => false)) && request(wc, url, wanted, hooks)
    }
    const question = askUser(wc, url, toAsk, hooks)
    asking.set(wc, question)
    const allowed = await question.finally(() => {
      if (asking.get(wc) === question) asking.delete(wc)
      // The page (and its iframes) may be holding what the Permissions API said before.
      if (!wc.isDestroyed()) for (const frame of wc.mainFrame.framesInSubtree) frame.send(IPC.pagePermissionsChanged)
    })
    if (!allowed) return false
  }

  // The first time a site gets a device, macOS asks whether Tabs may use it.
  for (const device of devices) {
    if (systemAccess(device) === 'unknown' && !(await systemPreferences.askForMediaAccess(device))) {
      void explainSystemBlock(wc, url, [device], hooks)
      return false
    }
  }
  return true
}

/**
 * Your devices' names, for a page to use them (see src/preload/capture.ts): only those it may use, since device
 * names are enough to tell people apart. Speakers come with the microphone, as in Chrome.
 */
export function devicesFor(wc: WebContents, url: string): DeviceChoice | null {
  const may = (p: Device): boolean => decide(wc, p, url, wc.getURL()) === 'allow'
  const { camera, microphone, speaker } = store.settings.devices
  const mic = may('microphone')
  const choice: DeviceChoice = { camera: may('camera') ? camera : null, microphone: mic ? microphone : null, speaker: mic ? speaker : null }
  return choice.camera || choice.microphone || choice.speaker ? choice : null
}

/**
 * How each permission looks to a page, for its preload to tell the Permissions API (src/preload/permission-states.ts).
 * The permission check can only say allowed or not, so a site you'd be asked about would otherwise read as blocked,
 * and sites that check first (Meet) never ask.
 */
export function permissionStates(wc: WebContents, url: string): Record<SitePermission, PageSitePermissionState> {
  const states = {} as Record<SitePermission, PageSitePermissionState>
  for (const permission of Object.keys(SITE_PERMISSIONS) as SitePermission[]) {
    const decision = decide(wc, permission, url, wc.getURL())
    states[permission] = decision === 'allow' ? 'granted' : decision === 'deny' ? 'denied' : 'prompt'
  }
  return states
}

export function setupPermissions(ses: Session, hooks: PermissionHooks): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_GRANT.has(permission)) return callback(true)
    const url = details.requestingUrl || wc.getURL()
    if (permission === 'media' && hooks.isOwn(wc)) return callback(true)
    if (extensionHooks.extensionPagePermission(permission, url)) return callback(true)
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
    const wanted = permissionsFor(permission, mediaTypes)
    if (!wanted?.length) return callback(false)
    request(wc, url, wanted, hooks).then(callback, () => callback(false))
  })

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (AUTO_GRANT.has(permission)) return true
    if (permission === 'media' && wc && hooks.isOwn(wc)) return true
    if (extensionHooks.extensionPagePermission(permission, requestingOrigin)) return true
    const mediaType = (details as { mediaType?: string }).mediaType
    const wanted = permissionsFor(permission, mediaType === 'video' || mediaType === 'audio' ? [mediaType] : undefined)
    // Unknown checks (e.g. background-sync) keep Chromium's default behaviour.
    if (!wanted) return true
    return wanted.every((p) => decide(wc, p, requestingOrigin, wc?.getURL() ?? requestingOrigin) === 'allow')
  })

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const wc = request.frame ? webContents.fromFrame(request.frame) : undefined
      const origin = originOf(request.securityOrigin ?? '')
      const parent = (wc && hooks.windowFor(wc)) ?? BrowserWindow.getFocusedWindow()
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (!sources.length) return callback({})
      const options = {
        type: 'question' as const,
        buttons: ['Share screen', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `${hostOf(origin)} wants to see your screen`
      }
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
      if (response !== 0) return callback({})
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined })
    },
    // On macOS 15+ this shows the system picker instead of the handler above.
    { useSystemPicker: true }
  )
}
