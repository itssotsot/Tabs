import { Check, Clock, Search, Send, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ShareDraft } from '@shared/types'
import { hostOf } from '@shared/url'
import { formatTimestamp, shareUrl } from '@shared/youtube'
import { sendMessage, signInWithGoogle, type Room } from '../social/api'
import { displayName, roomTitle, useSocial } from '../social/SocialProvider'
import { RoomAvatar } from '../ui/Avatar'
import { cx, siteIcon } from '../ui/util'

const LAST_ROOM_KEY = 'browserr.lastRoom'
const CLOSE_DELAY_MS = 650
/** Don't offer "start at 0:03": that's just the beginning. */
const MIN_TIMESTAMP_SEC = 5

/** Sends `draft` (and `more`, when sending a whole tab group) to a chat. */
export function SendPicker({ draft, more = [] }: { draft: ShareDraft; more?: ShareDraft[] }): ReactNode {
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
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') api.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the cursor in the search box whenever the picker gets focus.
  useEffect(() => {
    const focus = (): void => searchRef.current?.focus()
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
          url: shareUrl(d.url, d.timestampSec, withTime && hasTimestamp),
          title: d.title,
          thumbnail: d.thumbnail,
          timestampSec: withTime && hasTimestamp ? d.timestampSec : null
        })
      }
      localStorage.setItem(LAST_ROOM_KEY, room.id)
      setSentTo((prev) => [...prev, room.id])
      if (!keepOpen) closeTimer.current = window.setTimeout(() => api.close(), CLOSE_DELAY_MS)
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
            placeholder="Send to…"
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
      </>
    )
  }

  return (
    <div className="picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && api.close()}>
      <div className="picker">
        <div className="picker-preview">
          <div className="picker-thumb">
            {draft.thumbnail ? <img src={draft.thumbnail} alt="" /> : <img className="site" src={siteIcon(draft.url, 64)} alt="" />}
          </div>
          <div className="picker-preview-text">
            <strong>{more.length ? `${drafts.length} links` : draft.title}</strong>
            <span className={cx(more.length > 0 && 'picker-titles')} title={more.length ? drafts.map((d) => d.title).join('\n') : undefined}>
              {more.length ? drafts.map((d) => d.title).join(' · ') : hostOf(draft.url)}
            </span>
            {hasTimestamp && (
              <label className="picker-time">
                <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} />
                <Clock size={12} />
                Start at {formatTimestamp(draft.timestampSec!)}
              </label>
            )}
          </div>
        </div>
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
    </div>
  )
}
