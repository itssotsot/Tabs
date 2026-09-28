import type { TabMedia } from './types'

/** Seconds into the tab's video now: where it was read, moved on since at its rate. */
export function mediaPosition(media: TabMedia, now = Date.now()): number {
  const time = media.time + ((now - media.at) / 1000) * media.rate
  return media.duration === null ? time : Math.min(time, media.duration)
}

/** 65 -> "1:05", 3725 -> "1:02:05". */
export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** A start time as links write it (`90`, `90s`, `1m30s`, `1h2m`), in seconds. */
export function secondsParam(value: string | null): number | null {
  if (!value) return null
  if (/^\d+s?$/.test(value)) return parseInt(value, 10) || null
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!m || !m[0]) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || null
}
