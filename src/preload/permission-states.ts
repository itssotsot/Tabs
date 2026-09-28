// Electron's permission check only says allowed or not, so to a page, anything Tabs would ask about reads as
// blocked. Sites that check before asking (Meet does, for the microphone) then show their own "blocked" message
// and never ask. This tells them "prompt", as Chrome does, until you've decided.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/api'

/** Runs in the page's world. Must be self-contained: it's serialized as a string. */
function reportPrompt(eventName: string): void {
  let states: Record<string, string> = {}
  /** Status objects the page holds, whose Chromium state stays "denied" whatever you decide. */
  const held = new Set<{ status: WeakRef<PermissionStatus>; name: string; shown: string }>()
  const stateOf = (real: string, name: string): string => (real !== 'denied' ? real : states[name] === 'granted' || states[name] === 'prompt' ? states[name] : 'denied')
  const update = (e: Event): void => {
    states = JSON.parse(String((e as CustomEvent).detail)) ?? {}
    // What they show changed with your answer: tell the page, as Chrome does.
    for (const h of held) {
      const status = h.status.deref()
      if (!status) {
        held.delete(h)
        continue
      }
      const now = stateOf(status.state, h.name)
      if (now === h.shown) continue
      h.shown = now
      status.dispatchEvent(new Event('change'))
    }
  }
  document.addEventListener(`${eventName}-states`, update)
  /** Asks for the latest states; resolves when they're in (or soon, if they don't come). */
  const refresh = (): Promise<void> =>
    new Promise((resolve) => {
      document.addEventListener(`${eventName}-states`, () => resolve(), { once: true })
      document.dispatchEvent(new CustomEvent(`${eventName}-ask`))
      setTimeout(resolve, 500)
    })

  if (typeof Permissions === 'function') {
    const query = Permissions.prototype.query
    Permissions.prototype.query = async function (this: Permissions, descriptor: PermissionDescriptor) {
      const status = await query.call(this, descriptor)
      if (status.state !== 'denied') return status
      await refresh()
      const name = descriptor.name === 'midi' && (descriptor as { sysex?: boolean }).sysex ? 'midiSysex' : descriptor.name
      if (states[name] !== 'prompt') return status
      held.add({ status: new WeakRef(status), name, shown: 'prompt' })
      // Undecided: "prompt", and later whatever you decide.
      return new Proxy(status, {
        get(target, prop) {
          if (prop === 'state') return stateOf(target.state, name)
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target)
        }
      })
    }
  }

  // The same for notifications' own check, which pages read without waiting: "default" is Chrome's "prompt".
  const permission = typeof Notification === 'function' ? Object.getOwnPropertyDescriptor(Notification, 'permission') : undefined
  if (permission?.get) {
    const read = permission.get
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      enumerable: permission.enumerable,
      get(this: typeof Notification) {
        const real = read.call(this) as NotificationPermission
        if (real !== 'denied') return real
        return states.notifications === 'prompt' ? 'default' : states.notifications === 'granted' ? 'granted' : real
      }
    })
  }
}

export function installPermissionStates(): void {
  const eventName = `browserr-permissions-${Math.random().toString(36).slice(2)}`
  const send = async (): Promise<void> => {
    const states = await ipcRenderer.invoke(IPC.pagePermissionStates).catch(() => null)
    document.dispatchEvent(new CustomEvent(`${eventName}-states`, { detail: JSON.stringify(states) }))
  }
  // You answered a question from this page (see permissions.ts).
  ipcRenderer.on(IPC.pagePermissionsChanged, () => void send())
  document.addEventListener(
    `${eventName}-ask`,
    (e) => {
      e.stopImmediatePropagation()
      void send()
    },
    true
  )
  try {
    contextBridge.executeInMainWorld({ func: reportPrompt, args: [eventName] })
  } catch (err) {
    console.warn('[browserr] could not report permission states', err)
  }
  // Early, for Notification.permission, which pages read right away.
  void send()
}
