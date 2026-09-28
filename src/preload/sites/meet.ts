// Google Meet's mic and camera, for the tab list's buttons (see call-controls.ts). Meet's own buttons carry
// data-is-muted, and their icons (Material ligatures: mic, mic_off, videocam, videocam_off) tell them apart
// in any language. The same buttons are on the screen before joining, so you can mute yourself there too.
//
// And who else is in the call, for the faces on the tab. Meet's class names are scrambled and change, so this
// goes by what stays: each person's tile carries data-participant-id, their photo comes from googleusercontent.com,
// and their camera is a <video> in the tile, which a still is drawn from while it's on. Only the tiles Meet has in
// the page are seen: in a big call, the people it's showing.
import type { CallDevice, CallPerson } from '@shared/types'
import type { PageSite } from './index'

const ICONS: Record<CallDevice, RegExp> = { mic: /^mic(_off)?$/, camera: /^videocam(_off)?$/ }

function button(device: CallDevice): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>('[data-is-muted]')].filter((b) => ICONS[device].test(b.textContent?.trim() ?? ''))
  // Prefer the one on screen, if Meet keeps a hidden copy.
  return matches.find((b) => b.getClientRects().length) ?? matches[0] ?? null
}

const isOn = (b: HTMLElement): boolean => b.dataset.isMuted === 'false'

const TILE = '[data-participant-id]'
/**
 * How long a still from someone's camera is kept before it's drawn again. A little under how often call-controls.ts
 * reads the people again, so each of those reads draws a new one.
 */
const STILL_MS = 4000
/** The stills' size in pixels: the faces on the tab are 16px, and twice that on a Retina screen. */
const STILL_SIZE = 40

/** Each tile's name, once read: a tile's person doesn't change. */
const names = new WeakMap<Element, string>()
/** Your own tiles, once seen showing your camera, so they're still left out after you turn it off. */
const yours = new Set<string>()
const stills = new Map<string, { at: number; picture: string }>()
let canvas: HTMLCanvasElement | null = null

/** The tile's first text that isn't an icon (a Material ligature, such as "mic_off") or hidden from screen readers. */
function nameOf(tile: HTMLElement): string {
  const known = names.get(tile)
  if (known) return known
  const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    const el = node.parentElement
    if (!text || !el || el.closest('[aria-hidden="true"]') || /icons|symbols/i.test(getComputedStyle(el).fontFamily)) continue
    names.set(tile, text)
    return text
  }
  return ''
}

const cameraTracks = (video: HTMLVideoElement): MediaStreamTrack[] => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [])

/**
 * Your own camera belongs to a group of devices (its groupId); the others' come over the call and don't. Chromium
 * gives those a deviceId too, so that doesn't tell them apart.
 */
const showsYourCamera = (tile: HTMLElement): boolean =>
  [...tile.querySelectorAll('video')].some((v) => cameraTracks(v).some((t) => !!t.getSettings().groupId))

/** Your tile, if Meet marks it the way it seems to: data-self-name holds what it calls you ("You"), and your tile shows that. */
function isYourName(tile: HTMLElement, name: string): boolean {
  const marked = tile.matches('[data-self-name]') ? tile : tile.querySelector('[data-self-name]')
  return !!marked && marked.getAttribute('data-self-name') === name
}

/** A still from the person's camera while it's on and showing, else null. */
function still(id: string, tile: HTMLElement): string | null {
  const video = [...tile.querySelectorAll('video')].find(
    (v) =>
      v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      v.videoWidth > 0 &&
      v.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      // A camera that's been turned off leaves its track muted: no more frames.
      cameraTracks(v).every((t) => t.readyState === 'live' && !t.muted)
  )
  if (!video) {
    stills.delete(id)
    return null
  }
  const last = stills.get(id)
  if (last && Date.now() - last.at < STILL_MS) return last.picture
  canvas ??= document.createElement('canvas')
  canvas.width = canvas.height = STILL_SIZE
  const context = canvas.getContext('2d')
  if (!context) return null
  // The middle of the picture, squared off, where the face usually is.
  const side = Math.min(video.videoWidth, video.videoHeight)
  context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, STILL_SIZE, STILL_SIZE)
  let picture: string
  try {
    picture = canvas.toDataURL('image/jpeg', 0.75)
  } catch {
    return last?.picture ?? null
  }
  stills.set(id, { at: Date.now(), picture })
  return picture
}

const photoOf = (tile: HTMLElement): string | null => tile.querySelector<HTMLImageElement>('img[src*="googleusercontent.com"]')?.src ?? null

function people(): CallPerson[] {
  const out: CallPerson[] = []
  const ids = new Set<string>()
  const seenNames = new Set<string>()
  for (const tile of document.querySelectorAll<HTMLElement>(TILE)) {
    // Meet may mark elements inside a tile too; the outermost is the tile.
    if (tile.parentElement?.closest(TILE)) continue
    const id = tile.dataset.participantId
    const name = nameOf(tile)
    if (!id || !name || ids.has(id)) continue
    ids.add(id)
    if (showsYourCamera(tile)) yours.add(id)
    if (yours.has(id) || isYourName(tile, name)) continue
    // Someone in twice (from their laptop and their phone) is one face.
    if (seenNames.has(name)) continue
    seenNames.add(name)
    out.push({ name, picture: still(id, tile) ?? photoOf(tile) })
  }
  for (const id of stills.keys()) if (!ids.has(id)) stills.delete(id)
  return out
}

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
    people,
    attributes: ['data-is-muted', 'data-participant-id', 'src']
  }
}
