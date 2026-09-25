import { BrowserWindow, desktopCapturer, dialog, webContents, type Session, type WebContents } from 'electron'
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

/** Permissions that need the user's OK. Everything else is denied. */
const ASK: Record<string, string> = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'control your MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'idle-detection': 'know when you are actively using this device',
  openExternal: 'open an external application',
  'display-capture': 'see your screen'
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function describe(permission: string, mediaTypes?: string[]): string {
  if (permission === 'media' && mediaTypes?.length) {
    const wantsVideo = mediaTypes.includes('video')
    const wantsAudio = mediaTypes.includes('audio')
    if (wantsVideo && !wantsAudio) return 'use your camera'
    if (wantsAudio && !wantsVideo) return 'use your microphone'
  }
  return ASK[permission] ?? `use "${permission}"`
}

const pending = new Map<string, Promise<boolean>>()

type WindowLookup = (wc: WebContents) => BrowserWindow | null

async function ask(
  parent: BrowserWindow | null,
  origin: string,
  permission: string,
  mediaTypes?: string[]
): Promise<boolean> {
  const key = `${origin}|${permission}|${mediaTypes?.join(',') ?? ''}`
  const existing = pending.get(key)
  if (existing) return existing

  const prompt = (async () => {
    const host = origin.replace(/^https?:\/\//, '')
    const options = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 0,
      cancelId: 1,
      message: `${host} wants to ${describe(permission, mediaTypes)}`,
      checkboxLabel: 'Remember my choice for this site',
      checkboxChecked: true
    }
    const { response, checkboxChecked } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    const allowed = response === 0
    // Media prompts are remembered per permission, not per device type.
    if (checkboxChecked) store.setPermission(origin, permission, allowed ? 'allow' : 'deny')
    return allowed
  })().finally(() => pending.delete(key))

  pending.set(key, prompt)
  return prompt
}

export function setupPermissions(ses: Session, windowFor: WindowLookup): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_GRANT.has(permission)) return callback(true)
    if (!(permission in ASK)) return callback(false)

    const origin = originOf(details.requestingUrl || wc.getURL())
    const saved = store.getPermission(origin, permission)
    if (saved) return callback(saved === 'allow')

    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
    ask(windowFor(wc) ?? BrowserWindow.getFocusedWindow(), origin, permission, mediaTypes).then(callback, () => callback(false))
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_GRANT.has(permission)) return true
    const saved = store.getPermission(originOf(requestingOrigin), permission)
    if (saved) return saved === 'allow'
    // Unknown checks (e.g. background-sync) keep Chromium's default behaviour.
    return !(permission in ASK)
  })

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const wc = request.frame ? webContents.fromFrame(request.frame) : undefined
      const origin = originOf(request.securityOrigin ?? '')
      const parent = (wc && windowFor(wc)) ?? BrowserWindow.getFocusedWindow()
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (!sources.length) return callback({})
      const options = {
        type: 'question' as const,
        buttons: ['Share screen', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `${origin.replace(/^https?:\/\//, '')} wants to see your screen`
      }
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
      if (response !== 0) return callback({})
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined })
    },
    // On macOS 15+ this shows the system picker instead of the handler above.
    { useSystemPicker: true }
  )
}
