import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useState, type PointerEvent, type ReactNode } from 'react'
import type { TabMedia, TabState } from '@shared/types'
import { formatTimestamp } from '@shared/youtube'
import { cx } from '../../ui/util'

/** Where the video is now, going on from the page's last report. */
function positionOf(media: TabMedia): number {
  const time = media.time + ((Date.now() - media.at) / 1000) * media.rate
  return media.duration === null ? time : Math.min(time, media.duration)
}

/** The tab shows a progress bar, so it's drawn a little taller in lists (`has-media`). */
export function hasMediaBar(tab: TabState): boolean {
  return !!tab.media && tab.media.duration !== null
}

/**
 * Mute for a tab that's playing sound (or muted). With `animated`, it stays in the page while there's
 * nothing to mute, shrunk away, so it can grow in and out (see .tab-audio.gone).
 */
export function MuteButton({ tab, animated }: { tab: TabState; animated?: boolean }): ReactNode {
  const shown = tab.audible || tab.muted
  if (!shown && !animated) return null
  return (
    <button
      className={cx('tab-audio', !shown && 'gone')}
      title={tab.muted ? 'Unmute tab' : 'Mute tab'}
      tabIndex={shown ? undefined : -1}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => window.browserr.tabs.toggleMute(tab.id)}
    >
      {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
    </button>
  )
}

/** Play/pause for the tab's video, on sites whose player the tab can control. */
export function MediaButton({ tab }: { tab: TabState }): ReactNode {
  const { media } = tab
  if (!media) return null
  return (
    <button
      className={cx('tab-media', media.paused && 'paused')}
      title={media.paused ? 'Play' : 'Pause'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => window.browserr.tabs.media(tab.id, { type: 'toggle' })}
    >
      {media.paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
    </button>
  )
}

interface Scrub {
  fraction: number
  dragging: boolean
  /** The report it started from: once a newer one comes in, the page has caught up. */
  at: number
}

/** How far into its video the tab is, along its bottom edge. Click or drag it to seek. */
export function MediaProgress({ tab }: { tab: TabState }): ReactNode {
  const [scrub, setScrub] = useState<Scrub | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const { media } = tab
  // Live streams have no end to measure against.
  if (!media || media.duration === null) return null
  const duration = media.duration
  // After a seek, stay where it was dropped until the page reports the new position.
  const scrubbing = scrub && (scrub.dragging || scrub.at === media.at) ? scrub.fraction : null
  const pointed = scrub?.dragging ? scrub.fraction : hover

  const fractionAt = (e: PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }

  return (
    <div
      className={cx('media-bar', scrub?.dragging && 'scrubbing')}
      // An empty title keeps the tab's tooltip from covering the time.
      title=""
      // Not a click on the tab: no switching to it, and no dragging it around the strip.
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        setScrub({ fraction: fractionAt(e), dragging: true, at: media.at })
      }}
      onPointerMove={(e) => {
        const fraction = fractionAt(e)
        setHover(fraction)
        setScrub((s) => (s?.dragging ? { ...s, fraction } : s))
      }}
      onPointerUp={(e) => {
        if (!scrub?.dragging) return
        const fraction = fractionAt(e)
        window.browserr.tabs.media(tab.id, { type: 'seek', time: fraction * duration })
        setScrub({ fraction, dragging: false, at: media.at })
      }}
      onPointerCancel={() => setScrub(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="media-track">
        {scrubbing !== null ? (
          <div className="media-fill" style={{ transform: `scaleX(${scrubbing})` }} />
        ) : (
          <MediaFill key={media.at} media={media} duration={duration} />
        )}
      </div>
      {pointed !== null && (
        <span className="media-time" style={{ left: `${pointed * 100}%` }}>
          {formatTimestamp(pointed * duration)}
        </span>
      )}
    </div>
  )
}

/** The played part, moved along by a CSS animation so the strip doesn't re-render while the video plays. */
function MediaFill({ media, duration }: { media: TabMedia; duration: number }): ReactNode {
  // Worked out once: the animation carries on from here, and each new report remounts this.
  const [start] = useState(() => positionOf(media))
  const rate = media.rate || 1
  return (
    <div
      className="media-fill moving"
      style={{
        animationDuration: `${duration / rate}s`,
        animationDelay: `${-start / rate}s`,
        animationPlayState: media.rate ? 'running' : 'paused'
      }}
    />
  )
}
