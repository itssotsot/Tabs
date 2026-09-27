// Lets the tab strip show and control a site's video: play/pause and where it is.
import { ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import type { MediaCommand, TabMedia } from '@shared/types'

/** Sites whose main player the tab can control, and which videos are that player (not hover previews). */
const PLAYERS: { host: RegExp; video: string }[] = [{ host: /(^|\.)youtube\.com$/, video: '#movie_player video, #shorts-player video' }]

/** While playing, the strip moves the progress on its own; this often it's corrected for drift. */
const RESYNC_MS = 10_000

export function installMediaControls(): void {
  const player = PLAYERS.find((p) => p.host.test(location.hostname))
  if (!player) return

  let video: HTMLVideoElement | null = null
  /** The video has played since it last loaded; until then there's nothing to control. */
  let started = false
  let lastSent = 0
  let sentNothing = true

  const read = (): TabMedia | null => {
    const v = video
    if (!v || !started || !v.isConnected) return null
    // A paused video the page no longer shows (YouTube keeps its player, hidden, on other pages) is done with.
    if (v.paused && !v.getClientRects().length) return null
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

  const isPlayer = (target: EventTarget | null): target is HTMLVideoElement =>
    target instanceof HTMLVideoElement && target.matches(player.video)

  // Media events don't bubble, so listen while they're on their way down.
  document.addEventListener(
    'play',
    (e) => {
      if (!isPlayer(e.target)) return
      video = e.target
      started = true
      report()
    },
    true
  )
  for (const type of ['playing', 'pause', 'waiting', 'seeked', 'ratechange', 'durationchange', 'ended']) {
    document.addEventListener(type, (e) => e.target === video && report(), true)
  }
  document.addEventListener(
    'emptied',
    (e) => {
      if (e.target !== video) return
      started = false
      report()
    },
    true
  )
  document.addEventListener('timeupdate', (e) => e.target === video && Date.now() - lastSent > RESYNC_MS && report(), true)
  // Moving to another page of the site may hide the player. Timers, not frames: background tabs get no frames.
  document.addEventListener('yt-navigate-finish', () => setTimeout(report, 500))

  ipcRenderer.on(IPC.pageMediaCommand, (_e, command: MediaCommand) => {
    const v = video
    if (!v || !started) return
    if (command.type === 'toggle') {
      if (v.paused || v.ended) void v.play().catch(() => {})
      else v.pause()
    } else if (command.type === 'seek' && Number.isFinite(command.time)) {
      v.currentTime = Math.max(0, Math.min(command.time, Number.isFinite(v.duration) ? v.duration : command.time))
    }
  })
}
