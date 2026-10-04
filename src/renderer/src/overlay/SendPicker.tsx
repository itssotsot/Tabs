import { Check, Clock, Search, Send, UserPlus } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { OmniboxAnchor, ShareDraft } from '@shared/types'
import { shareUrl } from '@shared/links'
import { formatTimestamp } from '@shared/media'
import { sendMessage, signInWithGoogle, type Room } from '../social/api'
import { displayName, roomTitle, useSocial } from '../social/SocialProvider'
import { RoomAvatar } from '../ui/Avatar'
import { cx } from '../ui/util'

const LAST_ROOM_KEY = 'browserr.lastRoom'
const CLOSE_DELAY_MS = 650
/** Don't offer "start at 0:03": that's just the beginning. */
const MIN_TIMESTAMP_SEC = 5
/** Sliding out from behind the bar: fast at first, settling gently. */
const SLIDE_OUT: KeyframeAnimationOptions = { duration: 280, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }
/** Sliding back behind it: eased at both ends. */
const SLIDE_IN: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The tray slides; the bar's shadow on it moves the other way at the same time, so it stays put under the bar.
 * `hidden` is the tray tucked up behind the bar (anything above the bar's bottom edge is clipped away).
 */
function slide(tray: HTMLElement, shadow: HTMLElement | null, to: 'shown' | 'hidden', options: KeyframeAnimationOptions): Animation {
  const tucked = tray.offsetHeight
  // From wherever they are now, which is mid-way if the other slide is still running.
  const now = (el: HTMLElement): Keyframe => ({ transform: getComputedStyle(el).transform })
  const at = (offset: number): Keyframe => ({ transform: `translateY(${offset}px)` })
  const [trayFrom, shadowFrom] = to === 'shown' ? [at(-tucked), at(tucked)] : [now(tray), shadow ? now(shadow) : at(0)]
  const [trayTo, shadowTo] = to === 'shown' ? [at(0), at(0)] : [at(-tucked), at(tucked)]
  shadow?.animate([shadowFrom, shadowTo], options)
  return tray.animate([trayFrom, trayTo], options)
}

interface Props {
  draft: ShareDraft
  more?: ShareDraft[]
  anchor: OmniboxAnchor | null
  /** The window's width when the picker opened, to tell when the overlay has grown to cover it. */
  windowWidth: number
}

/**
 * Sends `draft` (and `more`, when sending a whole tab group) to a chat. With an `anchor` it's a tray that slides
 * out from behind the address bar, the bar's shadow falling on it, and slides back behind it when it closes.
 *
 * To stay on the bar as the window is resized, with no lag, it doesn't place itself: it lays out an invisible
 * copy of the toolbar, with the same styles and the same room for the buttons either side, and sits inside the
 * copy's bar. A resize moves both bars in the same layout.
 */
export function SendPicker({ draft, more = [], anchor, windowWidth }: Props): ReactNode {
  const { authReady, user, profile, rooms, people } = useSocial()
  const api = window.browserr.overlay
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState(0)
  const [withTime, setWithTime] = useState((draft.timestampSec ?? 0) >= MIN_TIMESTAMP_SEC)
  const [sentTo, setSentTo] = useState<string[]>([])
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const closing = useRef(false)

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useLayoutEffect(() => {
    const el = pickerRef.current
    if (!el || !anchor) return
    // Until the overlay covers the window, the toolbar copy isn't laid out like the real one, so it waits, hidden.
    const ready = (): boolean => window.innerWidth >= windowWidth - 1
    // The whole tray, at its full size, slides down out from behind the bar.
    const start = (): void => {
      el.style.visibility = ''
      if (!reducedMotion()) slide(el, shadowRef.current, 'shown', SLIDE_OUT)
    }
    const onResize = (): void => {
      if (!ready()) return
      window.removeEventListener('resize', onResize)
      start()
    }
    if (ready()) start()
    else {
      el.style.visibility = 'hidden'
      window.addEventListener('resize', onResize)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      for (const a of el.getAnimations({ subtree: true })) a.cancel()
    }
  }, [])

  function close(): void {
    if (closing.current) return
    closing.current = true
    const el = pickerRef.current
    if (!el || !anchor || reducedMotion()) return api.close()
    slide(el, shadowRef.current, 'hidden', SLIDE_IN).finished.then(
      () => api.close(),
      () => api.close()
    )
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the cursor in the search box whenever the picker gets focus.
  useEffect(() => {
    // Without scrolling: while the tray is still coming out, that would scroll it to show the box.
    const focus = (): void => searchRef.current?.focus({ preventScroll: true })
    focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])

  // `rooms` is already most-recently-active first; the room we last sent to goes on top.
  const ordered = useMemo(() => {
    const last = localStorage.getItem(LAST_ROOM_KEY)
    return [...rooms].sort((a, b) => Number(b.id === last) - Number(a.id === last))
  }, [rooms])

  const memberNames = (room: Room): string =>
    room.members
      .filter((m) => m !== user?.uid)
      .map((m) => displayName(people[m]))
      .join(', ') || 'Just you'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '')
    if (!q) return ordered
    return ordered.filter(
      (r) =>
        roomTitle(r, user?.uid ?? '', people).toLowerCase().includes(q) ||
        r.members.some((m) => people[m]?.username.includes(q) || people[m]?.displayName.toLowerCase().includes(q))
    )
  }, [ordered, query, people])

  useEffect(() => setSelected(0), [query])

  const drafts = [draft, ...more]
  // Several links go without timestamps: one checkbox can't speak for all of them.
  const hasTimestamp = !more.length && (draft.timestampSec ?? 0) >= MIN_TIMESTAMP_SEC

  async function send(room: Room, keepOpen: boolean): Promise<void> {
    if (!user || sending) return
    setSending(room.id)
    setError('')
    try {
      // One message per link, in tab order; the note goes with the first.
      for (const [i, d] of drafts.entries()) {
        await sendMessage(room.id, user.uid, i === 0 ? note || null : null, {
          url: shareUrl(d.url, withTime && hasTimestamp ? d.timestampSec : null),
          title: d.title,
          thumbnail: d.thumbnail,
          timestampSec: withTime && hasTimestamp ? d.timestampSec : null
        })
      }
      localStorage.setItem(LAST_ROOM_KEY, room.id)
      setSentTo((prev) => [...prev, room.id])
      if (!keepOpen) closeTimer.current = window.setTimeout(close, CLOSE_DELAY_MS)
    } catch {
      setError("Couldn't send. Check your connection and try again.")
    } finally {
      setSending(null)
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!filtered.length) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSelected((s) => (s + delta + filtered.length) % filtered.length)
    } else if (e.key === 'Enter' && filtered[selected]) {
      e.preventDefault()
      void send(filtered[selected], e.shiftKey)
    }
  }

  let content: ReactNode
  if (!authReady || (user && profile === undefined)) {
    content = (
      <div className="picker-empty">
        <span className="spinner" />
      </div>
    )
  } else if (!user) {
    content = (
      <div className="picker-empty">
        <p>Sign in to send links to your friends.</p>
        <button
          className="primary-btn"
          disabled={signingIn}
          onClick={async () => {
            setSigningIn(true)
            try {
              await signInWithGoogle()
            } catch {
              setError('Sign-in failed. Try again.')
            } finally {
              setSigningIn(false)
            }
          }}
        >
          {signingIn ? 'Finish signing in in your browser…' : 'Sign in with Google'}
        </button>
      </div>
    )
  } else if (!profile || rooms.length === 0) {
    content = (
      <div className="picker-empty">
        <p>{profile ? 'Add a friend first. They need Tabs too.' : 'Pick a username to get started.'}</p>
        <button className="primary-btn" onClick={() => api.openPanel('friends')}>
          <UserPlus size={15} />
          {profile ? 'Add friends' : 'Set up your profile'}
        </button>
      </div>
    )
  } else {
    content = (
      <>
        <div className="picker-search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={query}
            placeholder={more.length ? `Send ${drafts.length} links to…` : 'Send to…'}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="picker-friends" role="listbox">
          {filtered.map((room, i) => {
            const done = sentTo.includes(room.id)
            return (
              <button
                key={room.id}
                role="option"
                aria-selected={i === selected}
                className={cx('picker-friend', i === selected && 'selected', done && 'done')}
                onMouseEnter={() => setSelected(i)}
                onClick={(e) => void send(room, e.shiftKey)}
              >
                <RoomAvatar room={room} me={user.uid} people={people} size={30} />
                <span className="picker-friend-name">
                  <strong>{roomTitle(room, user.uid, people)}</strong>
                  <span>{memberNames(room)}</span>
                </span>
                {sending === room.id ? <span className="spinner" /> : done ? <Check size={16} className="sent-check" /> : <Send size={14} className="send-hint" />}
              </button>
            )
          })}
          {filtered.length === 0 && <p className="muted picker-none">No rooms match “{query}”.</p>}
        </div>
        <input
          className="picker-note"
          value={note}
          maxLength={500}
          placeholder="Add a message (optional)"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {hasTimestamp && (
          <label className="picker-time">
            <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} />
            <Clock size={12} />
            Start at {formatTimestamp(draft.timestampSec!)}
          </label>
        )}
      </>
    )
  }

  const body = (
    <div className="picker-body">
      {content}
      {error && <p className="form-error picker-error">{error}</p>}
      <div className="picker-hints">
        <span>
          <kbd>↵</kbd> send
        </span>
        <span>
          <kbd>⇧↵</kbd> send &amp; keep open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  )
  const closeOnSelf = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) close()
  }

  if (!anchor) {
    return (
      <div className="picker-backdrop clear" onMouseDown={closeOnSelf}>
        <div ref={pickerRef} className="picker">
          {body}
        </div>
      </div>
    )
  }
  return (
    <div className="picker-backdrop clear" onMouseDown={closeOnSelf}>
      {/* The toolbar copy: nothing in it but room for the buttons, and the bar the picker sits in. */}
      <div className={cx('picker-layer', anchor.chromeClass)}>
        <div style={{ flex: 'none', width: anchor.left }} />
        <div className="chrome-main">
          <div style={{ flex: 'none', height: anchor.top }} />
          <div className="toolbar" style={{ width: anchor.width }}>
            {anchor.before > 0 && <div style={{ flex: 'none', width: anchor.before }} />}
            <div className="omnibox">
              <div className="picker-tray" style={{ '--panel-bg': anchor.background, '--panel-fg': anchor.foreground } as CSSProperties}>
                <div ref={pickerRef} className="picker anchored" style={{ maxHeight: `calc(100vh - ${anchor.top + 64}px)` }}>
                  {/* The bar's shadow, falling on the tray as if it comes out from under the bar. */}
                  <div ref={shadowRef} className="picker-bar-shadow" />
                  {body}
                </div>
              </div>
            </div>
            {anchor.after > 0 && <div style={{ flex: 'none', width: anchor.after }} />}
          </div>
        </div>
      </div>
    </div>
  )
}
