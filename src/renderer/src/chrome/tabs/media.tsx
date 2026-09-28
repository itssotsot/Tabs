import { Mic, MicOff, MonitorUp, Pause, Play, Video, VideoOff, Volume2, VolumeX } from 'lucide-react'
import { useState, type PointerEvent, type ReactNode } from 'react'
import { colorFor } from '@shared/colors'
import type { CallPerson, TabMedia, TabState } from '@shared/types'
import { formatTimestamp, mediaPosition } from '@shared/media'
import { cx, useFailingIcon } from '../../ui/util'

/** The tab shows a progress bar, so it's drawn a little taller in lists (`has-media`). */
export function hasMediaBar(tab: TabState): boolean {
  return !!tab.media && tab.media.duration !== null
}

/**
 * Mute for a tab that's playing sound (or muted), or in a call: a call goes quiet between people talking, and
 * its sound should be one click away all the same. With `animated`, it stays in the page while there's nothing
 * to mute, shrunk away, so it can grow in and out (see .tab-audio.gone).
 */
export function MuteButton({ tab, animated }: { tab: TabState; animated?: boolean }): ReactNode {
  const shown = tab.audible || tab.muted || !!tab.call || !!tab.capture?.microphone
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

/**
 * Which of your devices the tab is using: its camera, microphone or screen. The call buttons already show the
 * camera and microphone they switch. The address bar's sign has the way to stop them.
 */
export function CaptureSigns({ tab }: { tab: TabState }): ReactNode {
  const { capture, call } = tab
  if (!capture) return null
  const camera = capture.camera && (call?.camera ?? null) === null
  const microphone = capture.microphone && (call?.mic ?? null) === null
  if (!camera && !microphone && !capture.screen) return null
  const using = [camera && 'camera', microphone && 'microphone', capture.screen && 'screen'].filter(Boolean).join(' and ')
  return (
    <span className="tab-capture" title={`Using your ${using}`}>
      {camera && <Video size={12} />}
      {microphone && <Mic size={12} />}
      {capture.screen && <MonitorUp size={12} />}
    </span>
  )
}

/**
 * Mic and camera for the tab's call, to mute yourself from any tab. With the call's own controls (Meet), the call
 * shows you muted; otherwise Tabs mutes the device itself, and the site doesn't know. `micOnly` for pinned tabs.
 */
export function CallButtons({ tab, micOnly }: { tab: TabState; micOnly?: boolean }): ReactNode {
  const { call } = tab
  if (!call) return null
  const quietly = call.by === 'tabs' ? " (the site won't show it)" : ''
  return (
    <>
      {call.mic !== null && (
        <button
          className={cx('tab-call', !call.mic && 'off')}
          title={(call.mic ? 'Mute microphone' : 'Unmute microphone') + quietly}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.browserr.tabs.call(tab.id, 'mic')}
        >
          {call.mic ? <Mic size={13} /> : <MicOff size={13} />}
        </button>
      )}
      {!micOnly && call.camera !== null && (
        <button
          className={cx('tab-call', !call.camera && 'off')}
          title={(call.camera ? 'Turn off camera' : 'Turn on camera') + quietly}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => window.browserr.tabs.call(tab.id, 'camera')}
        >
          {call.camera ? <Video size={13} /> : <VideoOff size={13} />}
        </button>
      )}
    </>
  )
}

/** How many faces the tab shows of the people in its call; past that, two faces and a count. */
const FACES = 3
const names = new Intl.ListFormat('en', { type: 'conjunction' })

/** The others in the tab's call (Google Meet): a few faces, and how many more. Their names are in the tooltip. */
export function CallPeople({ tab }: { tab: TabState }): ReactNode {
  const people = tab.call?.people
  if (!people?.length) return null
  const faces = people.length > FACES ? people.slice(0, FACES - 1) : people
  const more = people.length - faces.length
  const named = people.length > FACES ? [...people.slice(0, FACES).map((p) => p.name), `${people.length - FACES} more`] : people.map((p) => p.name)
  return (
    <span className="tab-people" title={`In the call: ${names.format(named)}`}>
      {faces.map((p, i) => (
        <CallFace key={`${i}:${p.name}`} person={p} />
      ))}
      {more > 0 && <span className="tab-face tab-face-more">+{more}</span>}
    </span>
  )
}

function CallFace({ person }: { person: CallPerson }): ReactNode {
  const [failing, onError] = useFailingIcon(person.picture)
  if (person.picture && !failing) {
    return <img className="tab-face" src={person.picture} alt="" referrerPolicy="no-referrer" draggable={false} onError={onError} />
  }
  return (
    <span className="tab-face tab-face-letter" style={{ background: colorFor(person.name) }}>
      {person.name.charAt(0).toUpperCase()}
    </span>
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
  const [start] = useState(() => mediaPosition(media))
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
