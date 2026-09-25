import { Check, Clock, Search, Send, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ShareDraft } from '@shared/types'
import { hostOf } from '@shared/url'
import { formatTimestamp, shareUrl } from '@shared/youtube'
import { sendShare, signInWithGoogle } from '../social/api'
import { useSocial, type Friend } from '../social/SocialProvider'
import { Avatar } from '../ui/Avatar'
import { cx, siteIcon } from '../ui/util'

const LAST_RECIPIENT_KEY = 'browserr.lastRecipient'
const CLOSE_DELAY_MS = 650
/** Don't offer "start at 0:03": that's just the beginning. */
const MIN_TIMESTAMP_SEC = 5

export function SendPicker({ draft }: { draft: ShareDraft }): ReactNode {
  const { authReady, user, profile, friends } = useSocial()
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

  const ordered = useMemo(() => {
    const last = localStorage.getItem(LAST_RECIPIENT_KEY)
    return [...friends].sort((a, b) => Number(b.uid === last) - Number(a.uid === last))
  }, [friends])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '')
    if (!q) return ordered
    return ordered.filter(
      (f) => f.profile?.username.includes(q) || f.profile?.displayName.toLowerCase().includes(q)
    )
  }, [ordered, query])

  useEffect(() => setSelected(0), [query])

  const hasTimestamp = (draft.timestampSec ?? 0) >= MIN_TIMESTAMP_SEC

  async function send(friend: Friend, keepOpen: boolean): Promise<void> {
    if (!user || sending) return
    setSending(friend.uid)
    setError('')
    try {
      await sendShare(user.uid, friend.uid, {
        url: shareUrl(draft.url, draft.timestampSec, withTime && hasTimestamp),
        title: draft.title,
        thumbnail: draft.thumbnail,
        timestampSec: withTime && hasTimestamp ? draft.timestampSec : null,
        note: note || null
      })
      localStorage.setItem(LAST_RECIPIENT_KEY, friend.uid)
      setSentTo((prev) => [...prev, friend.uid])
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
  } else if (!profile || friends.length === 0) {
    content = (
      <div className="picker-empty">
        <p>{profile ? 'Add a friend first. They need Browserr too.' : 'Pick a username to get started.'}</p>
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
          {filtered.map((f, i) => {
            const done = sentTo.includes(f.uid)
            return (
              <button
                key={f.uid}
                role="option"
                aria-selected={i === selected}
                className={cx('picker-friend', i === selected && 'selected', done && 'done')}
                onMouseEnter={() => setSelected(i)}
                onClick={(e) => void send(f, e.shiftKey)}
              >
                <Avatar profile={f.profile} size={30} />
                <span className="picker-friend-name">
                  <strong>{f.profile?.displayName ?? '…'}</strong>
                  <span>@{f.profile?.username}</span>
                </span>
                {sending === f.uid ? <span className="spinner" /> : done ? <Check size={16} className="sent-check" /> : <Send size={14} className="send-hint" />}
              </button>
            )
          })}
          {filtered.length === 0 && <p className="muted picker-none">No friends match “{query}”.</p>}
        </div>
        <input
          className="picker-note"
          value={note}
          maxLength={500}
          placeholder="Add a note (optional)"
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
            <strong>{draft.title}</strong>
            <span>{hostOf(draft.url)}</span>
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
