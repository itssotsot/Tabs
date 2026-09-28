// Which of your devices the page is using (for the tab's camera, microphone and screen signs, and their
// Stop), and your choice of devices applied to what it asks for.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import type { CaptureDevice, DeviceChoice, TabCapture } from '@shared/types'

/**
 * Runs in the page's world, so it sees every stream the page gets. Tells the preload what's in use with
 * `eventName` events (a JSON TabCapture), stops a device on `${eventName}-stop`, silences one on
 * `${eventName}-silence` (Tabs' own mute, for calls it can't press the buttons of), and asks for your devices with
 * `${eventName}-devices` the first time the page wants one. Must be self-contained: it's serialized as a string.
 */
function watchCapture(eventName: string): void {
  if (!('mediaDevices' in navigator)) return // Only secure pages can have any.

  const live = new Map<MediaStreamTrack, CaptureDevice>()
  let sent = ''
  const report = (): void => {
    const state: TabCapture = { camera: false, microphone: false, screen: false }
    for (const device of live.values()) state[device] = true
    const json = JSON.stringify(state)
    if (json === sent) return
    sent = json
    document.dispatchEvent(new CustomEvent(eventName, { detail: json }))
  }
  const forget = (track: MediaStreamTrack): void => {
    if (live.delete(track)) report()
  }
  // Tabs' own mute: the page keeps its tracks, which send silence (or black). Only tracks Tabs turned off come back
  // on, not ones the page turned off itself.
  const silenced = { camera: false, microphone: false, screen: false }
  const offByTabs = new WeakSet<MediaStreamTrack>()
  const silence = (track: MediaStreamTrack, device: CaptureDevice): void => {
    if (!silenced[device] || !track.enabled) return
    track.enabled = false
    offByTabs.add(track)
  }
  const follow = (track: MediaStreamTrack, device: CaptureDevice): void => {
    if (live.has(track) || track.readyState === 'ended') return
    live.set(track, device)
    silence(track, device)
    track.addEventListener('ended', () => forget(track))
  }
  document.addEventListener(`${eventName}-silence`, (e) => {
    const { device, off } = JSON.parse(String((e as CustomEvent).detail)) as { device: CaptureDevice; off: boolean }
    silenced[device] = off
    for (const [track, d] of live) {
      if (d !== device) continue
      if (off) silence(track, d)
      else if (offByTabs.has(track)) {
        offByTabs.delete(track)
        track.enabled = true
      }
    }
  })

  const stopTrack = MediaStreamTrack.prototype.stop
  MediaStreamTrack.prototype.stop = function (this: MediaStreamTrack) {
    stopTrack.call(this)
    forget(this)
  }
  const cloneTrack = MediaStreamTrack.prototype.clone
  MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack) {
    const copy = cloneTrack.call(this)
    const device = live.get(this)
    if (device) follow(copy, device)
    return copy
  }
  const cloneStream = MediaStream.prototype.clone
  MediaStream.prototype.clone = function (this: MediaStream) {
    const copy = cloneStream.call(this)
    const originals = this.getTracks()
    copy.getTracks().forEach((track, i) => {
      const device = live.get(originals[i])
      if (device) follow(track, device)
    })
    report()
    return copy
  }

  // Your devices, asked for when the page first wants one. `fresh` asks again: you may have just picked others
  // (the question under the address bar comes while the page waits for its stream).
  let devices: Promise<DeviceChoice | null> | null = null
  const yourDevices = (fresh = false): Promise<DeviceChoice | null> =>
    (devices = (!fresh && devices) || new Promise((resolve) => {
      const reply = `${eventName}-devices-reply`
      document.addEventListener(reply, (e) => resolve(JSON.parse(String((e as CustomEvent).detail))), { once: true })
      document.dispatchEvent(new CustomEvent(`${eventName}-devices`))
      setTimeout(() => resolve(null), 1000)
    }))
  /** A device's id on this page, found by name. Names are only known once the page may use that kind of device. */
  const idOf = async (kind: MediaDeviceKind, name: string | null): Promise<string | null> => {
    if (!name) return null
    const list = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    return list.find((d) => d.kind === kind && d.label === name)?.deviceId || null
  }
  type Constraint = boolean | MediaTrackConstraints | undefined
  const picksOwn = (c: Constraint): boolean => typeof c === 'object' && c.deviceId !== undefined
  const withDevice = (c: Constraint, id: string, exact = false): MediaTrackConstraints => ({
    ...(typeof c === 'object' ? c : {}),
    deviceId: exact ? { exact: id } : { ideal: id }
  })

  const getUserMedia = MediaDevices.prototype.getUserMedia
  MediaDevices.prototype.getUserMedia = async function (this: MediaDevices, constraints?: MediaStreamConstraints) {
    const asksForDevice = !!(constraints?.video || constraints?.audio)
    const mine = asksForDevice ? await yourDevices() : null
    const wanted = { ...constraints }
    // The page's own choice (a call's device menu) wins; otherwise yours.
    if (mine?.camera && wanted.video && !picksOwn(wanted.video)) {
      const id = await idOf('videoinput', mine.camera)
      if (id) wanted.video = withDevice(wanted.video, id)
    }
    if (mine?.microphone && wanted.audio && !picksOwn(wanted.audio)) {
      const id = await idOf('audioinput', mine.microphone)
      if (id) wanted.audio = withDevice(wanted.audio, id)
    }
    const stream = await getUserMedia.call(this, wanted)
    const now = asksForDevice ? await yourDevices(true) : null

    // The first time, names weren't known yet: if the page got another camera or microphone than yours, swap it.
    for (const [kind, input, name] of [
      ['video', 'videoinput', now?.camera],
      ['audio', 'audioinput', now?.microphone]
    ] as const) {
      const track = stream.getTracks().find((t) => t.kind === kind)
      if (!name || !track || track.label === name || picksOwn(constraints?.[kind])) continue
      const id = await idOf(input, name)
      if (!id) continue
      const other = await getUserMedia.call(this, { [kind]: withDevice(constraints?.[kind], id, true) }).catch(() => null)
      const swapped = other?.getTracks()[0]
      if (!swapped) continue
      stopTrack.call(track)
      stream.removeTrack(track)
      stream.addTrack(swapped)
    }

    for (const track of stream.getTracks()) follow(track, track.kind === 'video' ? 'camera' : 'microphone')
    report()
    return stream
  }
  const getDisplayMedia = MediaDevices.prototype.getDisplayMedia
  MediaDevices.prototype.getDisplayMedia = async function (this: MediaDevices, options?: DisplayMediaStreamOptions) {
    const stream = await getDisplayMedia.call(this, options)
    for (const track of stream.getTracks()) follow(track, 'screen')
    report()
    return stream
  }

  // Your speakers, for what the page plays, once its media or audio starts.
  const speakerId = async (): Promise<string | null> => idOf('audiooutput', (await yourDevices())?.speaker ?? null)
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!this.sinkId) {
      void speakerId().then((id) => {
        if (id && !this.sinkId) void this.setSinkId(id).catch(() => {})
      })
    }
    return play.call(this)
  }
  if (typeof AudioContext === 'function' && 'setSinkId' in AudioContext.prototype) {
    const setSinkId = (AudioContext.prototype as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId
    window.AudioContext = new Proxy(AudioContext, {
      construct(target, args: [AudioContextOptions?], newTarget) {
        const context = Reflect.construct(target, args, newTarget) as AudioContext
        if (!(args[0] as { sinkId?: unknown } | undefined)?.sinkId) {
          void speakerId().then((id) => {
            if (id) void setSinkId.call(context, id).catch(() => {})
          })
        }
        return context
      }
    })
  }

  // Stop, from the tab list or the address bar: as if the device was unplugged, which pages handle.
  document.addEventListener(`${eventName}-stop`, (e) => {
    const device = (e as CustomEvent).detail as CaptureDevice
    for (const [track, d] of [...live]) {
      if (d !== device) continue
      stopTrack.call(track)
      live.delete(track)
      track.dispatchEvent(new Event('ended'))
    }
    report()
  })
}

export function installCapture(): void {
  const eventName = `browserr-capture-${Math.random().toString(36).slice(2)}`
  const quietly = (e: Event): void => e.stopImmediatePropagation()

  document.addEventListener(
    eventName,
    (e) => {
      quietly(e)
      ipcRenderer.send(IPC.pageCapture, JSON.parse(String((e as CustomEvent).detail)))
    },
    true
  )
  document.addEventListener(
    `${eventName}-devices`,
    async (e) => {
      quietly(e)
      const devices = (await ipcRenderer.invoke(IPC.pageDevices).catch(() => null)) as DeviceChoice | null
      document.dispatchEvent(new CustomEvent(`${eventName}-devices-reply`, { detail: JSON.stringify(devices) }))
    },
    true
  )
  ipcRenderer.on(IPC.pageCaptureStop, (_e, device: CaptureDevice) => {
    document.dispatchEvent(new CustomEvent(`${eventName}-stop`, { detail: device }))
  })
  ipcRenderer.on(IPC.pageCaptureSilence, (_e, device: CaptureDevice, off: boolean) => {
    document.dispatchEvent(new CustomEvent(`${eventName}-silence`, { detail: JSON.stringify({ device, off: off === true }) }))
  })

  try {
    contextBridge.executeInMainWorld({ func: watchCapture, args: [eventName] })
  } catch (err) {
    console.warn('[browserr] could not follow camera and microphone use', err)
  }
}
