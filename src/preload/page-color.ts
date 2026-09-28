import { ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import { oncePerFrame } from './frame'

/** How far down from the top an element can start and still count as the top of the page (what the browser reads). */
const TOP_BAND = 16
/** The longest a transition or animation at the top keeps the colors being read every frame (some never end). */
const WATCH_MS = 2000

/**
 * Tells the browser when the top of the page may have changed color: when it first paints, as it scrolls, and
 * while something along its top animates (sites that fade their header to a new color once you've scrolled, like
 * GitHub, often do it after the scrolling stops). The toolbar takes on that color, so it follows the page
 * without polling for it.
 */
export function installPageColorHints(): void {
  let painted = false
  new PerformanceObserver((list) => {
    if (painted || !list.getEntries().length) return
    painted = true
    ipcRenderer.send(IPC.pageRepainted, true)
  }).observe({ type: 'paint', buffered: true })

  const hint = (): void => ipcRenderer.send(IPC.pageRepainted, false)

  // At most once a frame while scrolling, and once more where it stops. Sent a frame late, so the frame
  // with the new scroll position is on screen by the time the browser reads it.
  const soon = oncePerFrame(hint, { late: true })
  // Capturing, so scrolling inside a page's own scroll area (common in web apps) counts too.
  addEventListener('scroll', soon, { capture: true, passive: true })
  addEventListener('scrollend', soon, { capture: true, passive: true })

  // Transitions and animations on anything along the top: every frame while one runs, and once more after.
  const running = new Map<EventTarget, number>()
  let watchUntil = 0
  let watching = false
  const atTop = (target: EventTarget | null): target is Element => {
    if (!(target instanceof Element)) return false
    const r = target.getBoundingClientRect()
    return r.top < TOP_BAND && r.bottom > 0 && r.width > 0
  }
  const watch = (): void => {
    watchUntil = performance.now() + WATCH_MS
    if (watching) return
    watching = true
    const tick = (): void => {
      hint()
      if (running.size && performance.now() < watchUntil) return void requestAnimationFrame(tick)
      watching = false
      running.clear()
      soon()
    }
    requestAnimationFrame(tick)
  }
  const started = (e: Event): void => {
    if (!atTop(e.target)) return
    running.set(e.target, (running.get(e.target) ?? 0) + 1)
    watch()
  }
  const ended = (e: Event): void => {
    const left = (running.get(e.target!) ?? 0) - 1
    if (left > 0) running.set(e.target!, left)
    else running.delete(e.target!)
  }
  for (const type of ['transitionrun', 'animationstart'] as const) addEventListener(type, started, { capture: true, passive: true })
  for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'] as const) {
    addEventListener(type, ended, { capture: true, passive: true })
  }
}
