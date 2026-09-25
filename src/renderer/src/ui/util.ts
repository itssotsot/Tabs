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
