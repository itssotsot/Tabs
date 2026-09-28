import { useEffect, useState } from 'react'

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function timeAgo(date: Date | null): string {
  if (!date) return 'just now'
  const sec = Math.round((Date.now() - date.getTime()) / 1000)
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Small site icon for places where we don't have the page's own favicon. */
export function siteIcon(url: string, size = 32): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=${size}`
  } catch {
    return ''
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

/** "⌘⇧S" on macOS, "Ctrl+Shift+S" elsewhere. */
export function shortcut(mac: string, other: string): string {
  return window.browserr?.platform === 'darwin' ? mac : other
}

/**
 * Windows starts autoscroll when the middle button goes down over a scrollable list, which
 * swallows the middle-click that closes or opens a tab. auxclick still fires after this.
 */
export function disableMiddleClickAutoscroll(): void {
  document.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault()
  })
}

/** How long after a failed icon it's tried again, then again, and so on, less often each time. */
const ICON_RETRY_MS = [3_000, 15_000, 60_000, 5 * 60_000]

/**
 * Whether the icon at `src` failed to load. It's then tried again out of sight, soon and then less often, and as
 * soon as the network is back, and shown once it loads. Failing is often just for a moment (Tabs opened before
 * the network was up, as after the Mac wakes), and a sleeping tab never asks for its icon again.
 */
export function useFailingIcon(src: string | null | undefined): [failing: boolean, onError: () => void] {
  const [failed, setFailed] = useState<string | null>(null)
  const failing = !!src && failed === src
  useEffect(() => {
    if (!failing || !src) return
    let stopped = false
    let tries = 0
    let timer: number | undefined
    const attempt = (): void => {
      window.clearTimeout(timer)
      const probe = new Image()
      probe.onload = () => !stopped && setFailed(null)
      probe.onerror = () => {
        if (!stopped) timer = window.setTimeout(attempt, ICON_RETRY_MS[Math.min(tries++, ICON_RETRY_MS.length - 1)])
      }
      probe.src = src
    }
    timer = window.setTimeout(attempt, ICON_RETRY_MS[tries++])
    window.addEventListener('online', attempt)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener('online', attempt)
    }
  }, [failing, src])
  return [failing, () => setFailed(src ?? null)]
}
