import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/api'

const RELEASE_EVENT = 'browserr:release-media'

/**
 * Runs in the page's own world. Its `play()` calls wait until the tab is shown, then go
 * ahead, so the page's player never sees a pause (YouTube pauses itself again if it does).
 */
function deferPlayback(releaseEvent: string): void {
  const proto = HTMLMediaElement.prototype
  const play = proto.play
  const pause = proto.pause
  const waiting = new Map<HTMLMediaElement, () => void>()

  proto.play = function (this: HTMLMediaElement) {
    return new Promise<void>((resolve, reject) => {
      waiting.set(this, () => play.call(this).then(resolve, reject))
    })
  }
  // Pausing before the tab is shown cancels the wait, as it would cancel a real play().
  proto.pause = function (this: HTMLMediaElement) {
    waiting.delete(this)
    return pause.call(this)
  }

  window.addEventListener(
    releaseEvent,
    () => {
      proto.play = play
      proto.pause = pause
      for (const [media, start] of waiting) if (media.isConnected) start()
      waiting.clear()
    },
    { once: true }
  )
}

/** In a tab opened in the background, videos (like a YouTube link) wait until you switch to it. */
export function installBackgroundMediaHold(): void {
  // Synchronous on purpose: the page may start a video as soon as its scripts run.
  if (ipcRenderer.sendSync(IPC.pageHoldMedia) !== true) return
  try {
    contextBridge.executeInMainWorld({ func: deferPlayback, args: [RELEASE_EVENT] })
  } catch (err) {
    console.warn('[browserr] could not hold background media', err)
  }

  // Media with the `autoplay` attribute starts without calling play(): pause it and start it later.
  let holding = true
  const autoplayed = new Set<HTMLMediaElement>()
  const onPlay = (e: Event): void => {
    if (!holding || !(e.target instanceof HTMLMediaElement)) return
    autoplayed.add(e.target)
    e.target.pause()
  }
  // `play` doesn't bubble, so listen while it's on its way down.
  document.addEventListener('play', onPlay, true)

  ipcRenderer.once(IPC.pageReleaseMedia, () => {
    holding = false
    document.removeEventListener('play', onPlay, true)
    window.dispatchEvent(new Event(RELEASE_EVENT))
    for (const media of autoplayed) if (media.isConnected && media.paused) void media.play().catch(() => {})
  })
}
