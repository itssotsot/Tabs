// Lets the tab list show and switch a call's mic and camera with the call's own controls, so the call shows
// you muted. Two ways, for each device: the standard one, Media Session's call actions (a site registers
// "togglemicrophone" and "togglecamera" and says whether each is on); else the site's file (PageSite.call),
// which reads and presses its buttons. A call neither covers is muted by Tabs itself (see Tab.call).
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import type { CallDevice, CallState, PageCall } from '@shared/types'
import type { PageSite } from './sites'

/**
 * Runs in the page's world, where the site talks to Media Session. Reports `eventName` events (a JSON CallState:
 * a device is null until the site has both a handler for it and said whether it's on), and runs the site's own
 * handler on `${eventName}-toggle`. Must be self-contained: it's serialized as a string.
 */
function watchCallActions(eventName: string): void {
  if (typeof MediaSession !== 'function') return
  type Action = 'togglemicrophone' | 'togglecamera'
  type CallSession = MediaSession & { setMicrophoneActive?(active: boolean): Promise<void>; setCameraActive?(active: boolean): Promise<void> }
  const proto = MediaSession.prototype as CallSession
  const handlers = new Map<Action, MediaSessionActionHandler>()
  const active: { mic: boolean | null; camera: boolean | null } = { mic: null, camera: null }
  const report = (): void => {
    const state: CallState = {
      mic: handlers.has('togglemicrophone') ? active.mic : null,
      camera: handlers.has('togglecamera') ? active.camera : null
    }
    document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(state) }))
  }

  const setActionHandler = proto.setActionHandler
  proto.setActionHandler = function (this: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    const name = action as string
    if (name === 'togglemicrophone' || name === 'togglecamera') {
      if (handler) handlers.set(name, handler)
      else handlers.delete(name)
      report()
    }
    return setActionHandler.call(this, action, handler)
  }
  for (const [method, device] of [
    ['setMicrophoneActive', 'mic'],
    ['setCameraActive', 'camera']
  ] as const) {
    const original = proto[method]
    if (typeof original !== 'function') continue
    proto[method] = function (this: CallSession, on: boolean) {
      active[device] = !!on
      report()
      return original.call(this, on)
    }
  }

  document.addEventListener(`${eventName}-toggle`, (e) => {
    const action: Action = (e as CustomEvent).detail === 'mic' ? 'togglemicrophone' : 'togglecamera'
    handlers.get(action)?.({ action: action as MediaSessionAction })
  })
}

/** How often the people in a call are read again, for the stills from their cameras (see PageSite.call.people). */
const PEOPLE_REFRESH_MS = 5000

export function installCallControls(site?: PageSite): void {
  const fromSite = site?.call
  const eventName = `browserr-call-${Math.random().toString(36).slice(2)}`
  let session: CallState = { mic: null, camera: null }

  let sent = 'null'
  let queued = false
  // Timers, not frames: the call goes on in a background tab, which gets no frames.
  const report = (): void => {
    if (queued) return
    queued = true
    setTimeout(() => {
      queued = false
      const read = fromSite?.read() ?? null
      const mic = session.mic ?? read?.mic ?? null
      const camera = session.camera ?? read?.camera ?? null
      const state: PageCall | null = mic === null && camera === null ? null : { mic, camera, people: fromSite?.people?.() ?? [] }
      const json = JSON.stringify(state)
      if (json === sent) return
      sent = json
      ipcRenderer.send(IPC.pageCallState, state)
    }, 50)
  }

  document.addEventListener(
    eventName,
    (e) => {
      e.stopImmediatePropagation()
      session = JSON.parse(String((e as CustomEvent).detail))
      report()
    },
    true
  )
  try {
    contextBridge.executeInMainWorld({ func: watchCallActions, args: [eventName] })
  } catch (err) {
    console.warn('[browserr] could not follow call actions', err)
  }

  // Observe the document itself: at preload time <html> may not exist yet.
  if (fromSite) new MutationObserver(report).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: fromSite.attributes })
  // Cameras change without the page changing: the stills of people's faces are drawn again every so often.
  if (fromSite?.people) setInterval(report, PEOPLE_REFRESH_MS)

  ipcRenderer.on(IPC.pageCallCommand, (_e, device: CallDevice) => {
    const bySession = device === 'mic' ? session.mic !== null : session.camera !== null
    if (bySession) document.dispatchEvent(new CustomEvent(`${eventName}-toggle`, { detail: device }))
    else fromSite?.toggle(device)
    report()
  })
}
