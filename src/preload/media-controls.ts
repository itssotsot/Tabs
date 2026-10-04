// Lets the tab strip show and control a page's video or audio: play/pause and where it is.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import type { MediaCommand, TabMedia } from '@shared/types'
import type { PageSite } from './sites'

/** While playing, the strip moves the progress on its own; this often it's corrected for drift. */
const RESYNC_MS = 10_000
/** Anything shorter is a sound effect, not something to control. */
const MIN_DURATION_SEC = 5
/** Events that change what the strip shows, besides the ones handled on their own below. */
const STATE_EVENTS = ['playing', 'pause', 'waiting', 'seeked', 'ratechange', 'durationchange', 'ended']

/**
 * Runs in the page's world. Media events don't leave a shadow root (Reddit's player is in one), and media the
 * page never adds to it (Spotify's player) has nowhere to send them, so the preload sees neither. When such
 * media first plays, this hands it over: out of a shadow root with an event that leaves it, and from off the
 * page as an event's relatedTarget.
 */
function handOverHiddenMedia(eventName: string): void {
  const play = HTMLMediaElement.prototype.play
  const handedOver = new WeakSet<HTMLMediaElement>()
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!handedOver.has(this) && this.getRootNode() !== document) {
      handedOver.add(this)
      if (this.isConnected) this.dispatchEvent(new Event(eventName, { bubbles: true, composed: true }))
      else document.dispatchEvent(new MouseEvent(eventName, { relatedTarget: this }))
    }
    return play.call(this)
  }
}

/**
 * The player is whatever plays with sound: muted media are previews, backgrounds and feeds until they're
 * unmuted, and a call's live streams are no player. A site can pick its player instead, and seek it its own way
 * (see PageSite).
 */
export function installMediaControls(site?: PageSite): void {
  let video: HTMLMediaElement | null = null
  /** The video has played since it last loaded; until then there's nothing to control. */
  let started = false
  let lastSent = 0
  let sentNothing = true
  /** Media that plays without ever being on the page, unlike media that was and has been taken off. */
  const offPage = new WeakSet<HTMLMediaElement>()

  const read = (): TabMedia | null => {
    const v = video
    if (!v || !started || (!v.isConnected && !offPage.has(v))) return null
    if (Number.isFinite(v.duration) && v.duration < MIN_DURATION_SEC) return null
    // A paused video the page no longer shows (YouTube keeps its player, hidden, on other pages) is done with.
    if (v.paused && v.isConnected && v instanceof HTMLVideoElement && !v.getClientRects().length) return null
    const moving = !v.paused && !v.ended && v.readyState > 2
    return {
      paused: v.paused || v.ended,
      time: v.currentTime,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
      rate: moving ? v.playbackRate : 0,
      at: Date.now()
    }
  }

  const report = (): void => {
    const media = read()
    if (!media && sentNothing) return
    sentNothing = !media
    lastSent = Date.now()
    ipcRenderer.send(IPC.pageMediaState, media)
  }

  const isPlayer = (target: EventTarget | null): target is HTMLMediaElement =>
    target instanceof HTMLMediaElement &&
    // A live stream is a call (the others' voices and cameras, or your own camera), not something to pause or seek.
    !(target.srcObject instanceof MediaStream) &&
    (site?.player ? target.matches(site.player) : !target.muted && target.volume > 0)

  const pick = (target: EventTarget | null): void => {
    if (!isPlayer(target)) return
    video = target
    started = true
    report()
  }

  /** Follows the media events that reach `target`: the document's, or one element's that it never sees. */
  const follow = (target: EventTarget): void => {
    // Media events don't bubble, so listen while they're on their way down.
    target.addEventListener('play', (e) => pick(e.target), true)
    // Unmuting a video that plays muted (as feeds do) makes it the player.
    target.addEventListener(
      'volumechange',
      (e) => {
        if (e.target !== video && e.target instanceof HTMLMediaElement && !e.target.paused) pick(e.target)
      },
      true
    )
    for (const type of STATE_EVENTS) target.addEventListener(type, (e) => e.target === video && report(), true)
    target.addEventListener(
      'emptied',
      (e) => {
        if (e.target !== video) return
        started = false
        report()
      },
      true
    )
    target.addEventListener('timeupdate', (e) => e.target === video && Date.now() - lastSent > RESYNC_MS && report(), true)
  }
  follow(document)

  const handOver = `browserr-media-${Math.random().toString(36).slice(2)}`
  document.addEventListener(
    handOver,
    (e) => {
      e.stopImmediatePropagation()
      const media = e instanceof MouseEvent ? e.relatedTarget : e.composedPath()[0]
      if (!(media instanceof HTMLMediaElement)) return
      if (!media.isConnected) offPage.add(media)
      follow(media)
    },
    true
  )
  try {
    contextBridge.executeInMainWorld({ func: handOverHiddenMedia, args: [handOver] })
  } catch (err) {
    console.warn('[browserr] could not find hidden media', err)
  }

  // Moving to another page of a single-page site may hide the player. Timers, not frames: background tabs get no frames.
  const { navigation } = window as Window & { navigation?: EventTarget }
  navigation?.addEventListener('currententrychange', () => setTimeout(report, 500))

  ipcRenderer.on(IPC.pageMediaCommand, (_e, command: MediaCommand) => {
    const v = video
    if (!v || !started) return
    if (command.type === 'toggle') {
      if (v.paused || v.ended) void v.play().catch(() => {})
      else v.pause()
    } else if (command.type === 'seek' && Number.isFinite(command.time)) {
      const time = Math.max(0, Math.min(command.time, Number.isFinite(v.duration) ? v.duration : command.time))
      if (site?.seek) site.seek(time)
      else v.currentTime = time
    }
  })
}
