// Google Meet's mic and camera, for the tab list's buttons (see call-controls.ts). Meet's own buttons carry
// data-is-muted, and their icons (Material ligatures: mic, mic_off, videocam, videocam_off) tell them apart
// in any language. The same buttons are on the screen before joining, so you can mute yourself there too.
import type { CallDevice } from '@shared/types'
import type { PageSite } from './index'

const ICONS: Record<CallDevice, RegExp> = { mic: /^mic(_off)?$/, camera: /^videocam(_off)?$/ }

function button(device: CallDevice): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>('[data-is-muted]')].filter((b) => ICONS[device].test(b.textContent?.trim() ?? ''))
  // Prefer the one on screen, if Meet keeps a hidden copy.
  return matches.find((b) => b.getClientRects().length) ?? matches[0] ?? null
}

const isOn = (b: HTMLElement): boolean => b.dataset.isMuted === 'false'

export const meet: PageSite = {
  domains: ['meet.google.com'],
  call: {
    read() {
      const mic = button('mic')
      if (!mic) return null
      const camera = button('camera')
      return { mic: isOn(mic), camera: camera ? isOn(camera) : null }
    },
    toggle(device) {
      button(device)?.click()
    },
    attributes: ['data-is-muted']
  }
}
