import { Archive, ArrowLeft, Check, Copy, LogOut, Play, RefreshCw, SendHorizontal, SmilePlus, UserPlus, Users, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { REACTIONS } from '@shared/constants'
import type { ShareDraft } from '@shared/types'
import { findLinks, hostOf, prettyUrl, URL_RE } from '@shared/url'
import { formatTimestamp } from '@shared/youtube'
import {
  cancelInvite,
  deleteMessage,
  formatJoinCode,
  invite,
  isUnread,
  leaveRoom,
  markRoomRead,
  react,
  resetJoinCode,
  sendMessage,
  watchMessages,
  type InviteResult,
  type Message,
  type Profile,
  type Room
} from '../../social/api'
import { directPartner, displayName, roomTitle, useSocial } from '../../social/SocialProvider'
import { Avatar, RoomAvatar } from '../../ui/Avatar'
import { copyText, MENU_SEPARATOR, popupMenu, selectionIn } from '../../ui/menu'
import { cx, siteIcon, timeAgo } from '../../ui/util'
import { linksInMessage, pageKey, useLinks } from '../tabs/links'

/** Consecutive messages from one person closer together than this share a header. */
const GROUP_GAP_MS = 5 * 60 * 1000

interface Props {
  room: Room
  onBack: () => void
}

export function RoomView({ room, onBack }: Props): ReactNode {
  const { user, setViewingRoom } = useSocial()
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Captured on open, so the "new" divider doesn't jump once we mark the room read.
  const [readBefore] = useState(() => (user ? room.readAt[user.uid] : null) ?? null)
  const uid = user?.uid

  useEffect(() => watchMessages(room.id, setMessages, () => setMessages([])), [room.id])

  useEffect(() => {
    setViewingRoom(room.id)
    return () => setViewingRoom(null)
  }, [room.id])

  // Reading the room while the window has focus marks it read.
  const unread = uid ? isUnread(room, uid) : false
  useEffect(() => {
    if (!uid || !unread) return
    const mark = (): void => {
      if (document.hasFocus()) void markRoomRead(room.id, uid).catch(() => {})
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [room.id, uid, unread])

  if (!user) return null

  return (
    <div className="room-view">
      <RoomHeader room={room} onBack={onBack} onDetails={() => setDetailsOpen((o) => !o)} detailsOpen={detailsOpen} />
      {detailsOpen ? (
        <RoomDetails room={room} onLeft={onBack} />
      ) : (
        <>
          <MessageList room={room} messages={messages} readBefore={readBefore} onInvite={() => setDetailsOpen(true)} />
          <Composer roomId={room.id} />
        </>
      )}
    </div>
  )
}

function RoomHeader({ room, onBack, onDetails, detailsOpen }: {
  room: Room
  onBack: () => void
  onDetails: () => void
  detailsOpen: boolean
}): ReactNode {
  const { user, people } = useSocial()
  if (!user) return null
  const partner = directPartner(room, user.uid)
  return (
    <div className="room-head">
      <button className="icon-btn small" title="Inbox" onClick={onBack}>
        <ArrowLeft size={16} />
      </button>
      <RoomAvatar room={room} me={user.uid} people={people} size={26} />
      <div className="room-head-name">
        <strong>{roomTitle(room, user.uid, people)}</strong>
        {partner ? (
          <span>{displayName(people[partner])}</span>
        ) : (
          <span>
            {room.members.length} {room.members.length === 1 ? 'member' : 'members'}
            {room.invited.length + room.invitedEmails.length > 0 &&
              ` · ${room.invited.length + room.invitedEmails.length} invited`}
          </span>
        )}
      </div>
      {!partner && (
        <button
          className={cx('icon-btn small', detailsOpen && 'pressed')}
          title="Members and invites"
          onClick={onDetails}
        >
          <Users size={16} />
        </button>
      )}
    </div>
  )
}

// ---- messages ----

function MessageList({ room, messages, readBefore, onInvite }: {
  room: Room
  messages: Message[] | null
  readBefore: Date | null
  onInvite: () => void
}): ReactNode {
  const { user, people } = useSocial()
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const uid = user!.uid

  // Stay at the bottom as messages arrive, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Decided once, from what was unread when the room opened; later arrivals don't move it.
  const firstNew = useRef<string | null | undefined>(undefined)
  if (messages && firstNew.current === undefined) {
    firstNew.current =
      messages.find((m) => m.from !== uid && m.createdAt && (!readBefore || m.createdAt > readBefore))?.id ?? null
  }

  if (!messages) {
    return (
      <div className="messages">
        <div className="panel-empty">
          <span className="spinner" />
        </div>
      </div>
    )
  }

  const last = messages[messages.length - 1]
  const seenBy =
    last && last.from === uid && last.createdAt
      ? room.members.filter((m) => m !== uid && (room.readAt[m]?.getTime() ?? 0) >= last.createdAt!.getTime())
      : []

  return (
    <div
      ref={scroller}
      className="messages"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {messages.length === 0 && (
        <div className="panel-empty">
          <h3>Say hi 👋</h3>
          <p>
            Messages and links sent to <strong>{roomTitle(room, uid, people)}</strong> show up here.
            {room.kind === 'group' && room.members.length === 1 && ' Invite some friends to get started.'}
          </p>
          {room.kind === 'group' && room.members.length === 1 && (
            <button className="primary-btn compact" onClick={onInvite}>
              <UserPlus size={14} />
              Invite people
            </button>
          )}
        </div>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const grouped =
          prev &&
          prev.from === m.from &&
          prev.createdAt &&
          m.createdAt &&
          m.createdAt.getTime() - prev.createdAt.getTime() < GROUP_GAP_MS &&
          m.id !== firstNew.current
        return (
          <Fragment key={m.id}>
            {m.id === firstNew.current && <div className="new-divider">New</div>}
            <MessageItem roomId={room.id} message={m} person={people[m.from]} mine={m.from === uid} grouped={!!grouped} />
          </Fragment>
        )
      })}
      {seenBy.length > 0 && (
        <div className="seen-by">Seen by {seenBy.map((m) => displayName(people[m])).join(', ')}</div>
      )}
    </div>
  )
}

function MessageItem({ roomId, message: m, person, mine, grouped }: {
  roomId: string
  message: Message
  person: Profile | null | undefined
  mine: boolean
  grouped: boolean
}): ReactNode {
  const { user, people } = useSocial()
  const { messageArchive, unarchiveMessage, open } = useLinks()
  const [picking, setPicking] = useState(false)
  const uid = user!.uid
  const mineReaction = m.reactions[uid] ?? null
  // Links you closed with × in your tab groups. Only you see this.
  const archive = messageArchive(roomId, m.id)
  const allArchived = archive.total > 0 && archive.archived === archive.total

  const counts = new Map<string, string[]>()
  for (const [who, r] of Object.entries(m.reactions)) counts.set(r, [...(counts.get(r) ?? []), who])

  const setReaction = (r: string | null): void => {
    setPicking(false)
    void react(roomId, m.id, uid, r).catch(() => {})
  }

  const remove = (): void => {
    if (confirm('Delete this message for everyone?')) void deleteMessage(roomId, m.id).catch(() => {})
  }

  // Right-click: whatever you selected, the link you clicked (or the message's card), the text, reactions.
  const showMenu = (e: React.MouseEvent<HTMLElement>): void => {
    e.preventDefault()
    const target = e.target as Element
    const selected = selectionIn(e.currentTarget)
    const anchor = target.closest('a')?.getAttribute('href')
    const url = anchor ?? m.url ?? findLinks(m.text ?? '')[0] ?? null
    const title = url === m.url && m.title ? m.title : url ? prettyUrl(url) : ''
    void popupMenu([
      ...(selected ? [{ role: 'copy' as const }, MENU_SEPARATOR] : []),
      ...(url
        ? [
            { label: 'Open link', run: () => open(url) },
            { label: 'Open link in a new tab', run: () => open(url, { background: true }) },
            { label: 'Send link to a friend…', run: () => window.browserr.share.openPickerForLink(url, title) },
            { label: 'Copy link address', run: () => copyText(url) },
            MENU_SEPARATOR
          ]
        : []),
      ...(m.text ? [{ label: 'Copy text', run: () => copyText(m.text!) }] : []),
      {
        label: 'React',
        submenu: [
          ...REACTIONS.map((r) => ({ label: r, type: 'checkbox' as const, checked: mineReaction === r, run: () => setReaction(mineReaction === r ? null : r) })),
          ...(mineReaction ? [MENU_SEPARATOR, { label: 'Remove Reaction', run: () => setReaction(null) }] : [])
        ]
      },
      ...(archive.archived > 0 ? [{ label: archive.archived > 1 ? 'Restore archived links' : 'Restore archived link', run: () => unarchiveMessage(roomId, m.id) }] : []),
      ...(mine ? [MENU_SEPARATOR, { label: 'Delete Message…', run: remove }] : [])
    ])
  }

  return (
    <div
      className={cx('message', mine && 'mine', grouped && 'grouped', allArchived && 'archived')}
      onMouseLeave={() => setPicking(false)}
      onContextMenu={showMenu}
    >
      {!mine && <div className="message-avatar">{!grouped && <Avatar profile={person} size={26} />}</div>}
      <div className="message-body">
        {!grouped && (
          <div className="message-meta" title={m.createdAt?.toLocaleString()}>
            {!mine && <strong>{person?.displayName ?? displayName(person)}</strong>}
            <span>{timeAgo(m.createdAt)}</span>
          </div>
        )}
        <div className="bubble">
          {m.url && <LinkCard roomId={roomId} message={m} />}
          {m.text && <p className="message-text">{linkify(m.text, (url) => linkKeyIn(roomId, m, url))}</p>}
          <div className="message-tools">
            <button className="icon-btn small" title="React" onClick={() => setPicking((p) => !p)}>
              <SmilePlus size={14} />
            </button>
            {mine && (
              <button
                className="icon-btn small"
                title="Delete"
                onClick={remove}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {picking && (
            <div className="reaction-picker">
              {REACTIONS.map((r) => (
                <button key={r} className={cx('reaction', mineReaction === r && 'on')} onClick={() => setReaction(mineReaction === r ? null : r)}>
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
        {archive.archived > 0 && (
          <div className="message-archived" title="Closed from your tab groups. Only you see this.">
            <Archive size={11} />
            {allArchived ? 'Archived' : `${archive.archived} of ${archive.total} links archived`}
            <button className="link-btn" onClick={() => unarchiveMessage(roomId, m.id)}>
              Restore
            </button>
          </div>
        )}
        {counts.size > 0 && (
          <div className="reaction-chips">
            {[...counts].map(([r, who]) => (
              <button
                key={r}
                className={cx('reaction-chip', who.includes(uid) && 'on')}
                title={who.map((w) => (w === uid ? 'You' : displayName(people[w]))).join(', ')}
                onClick={() => setReaction(mineReaction === r ? null : r)}
              >
                {r}
                {who.length > 1 && <span>{who.length}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The key of the shared link for `url` in a message, so a tab opened from it shows who sent it. */
function linkKeyIn(roomId: string, m: Message, url: string): string | undefined {
  const page = pageKey(url)
  return linksInMessage(roomId, m).find((l) => pageKey(l.url) === page)?.key
}

function LinkCard({ roomId, message: m }: { roomId: string; message: Message }): ReactNode {
  const [thumbFailed, setThumbFailed] = useState(false)
  const url = m.url!
  const open = (background: boolean): void => window.browserr.openUrl(url, background, `${roomId}/${m.id}`)

  return (
    <div
      className="link-card"
      role="button"
      tabIndex={0}
      title={url}
      onClick={(e) => open(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && open(true)}
      onKeyDown={(e) => e.key === 'Enter' && open(false)}
    >
      {m.thumbnail && !thumbFailed && (
        <div className="link-thumb">
          <img src={m.thumbnail} alt="" draggable={false} onError={() => setThumbFailed(true)} />
          {m.timestampSec != null && m.timestampSec > 0 && (
            <span className="share-time">
              <Play size={9} fill="currentColor" />
              {formatTimestamp(m.timestampSec)}
            </span>
          )}
        </div>
      )}
      <div className="link-text">
        <strong>{m.title || url}</strong>
        <span>
          <img src={siteIcon(url, 32)} alt="" draggable={false} />
          {hostOf(url)}
        </span>
      </div>
    </div>
  )
}

function linkify(text: string, keyFor: (url: string) => string | undefined): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        onClick={(e) => {
          e.preventDefault()
          window.browserr.openUrl(part, e.metaKey || e.ctrlKey, keyFor(part))
        }}
      >
        {part}
      </a>
    ) : (
      part
    )
  )
}

/** How long to wait for a link's preview when you hit send before it's typed. */
const PREVIEW_WAIT_MS = 4000
const PREVIEW_DEBOUNCE_MS = 350

/** Fetches (once per URL) the title and thumbnail a link gets as a card, like the send picker. */
function usePreviews(): (url: string) => Promise<ShareDraft | null> {
  const cache = useRef(new Map<string, Promise<ShareDraft | null>>())
  return (url) => {
    let p = cache.current.get(url)
    if (!p) {
      p = window.browserr.share.preview(url).catch(() => null)
      cache.current.set(url, p)
    }
    return p
  }
}

function Composer({ roomId }: { roomId: string }): ReactNode {
  const { user } = useSocial()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const getPreview = usePreviews()
  // The first link in the message becomes its card; × on the preview sends it as plain text.
  const link = findLinks(text)[0] ?? null
  const [preview, setPreview] = useState<{ url: string; draft: ShareDraft | null; loading: boolean } | null>(null)
  const [noCard, setNoCard] = useState<string | null>(null)
  const wantsCard = !!link && noCard !== link

  useEffect(() => {
    if (!link || !wantsCard) {
      setPreview(null)
      return
    }
    let live = true
    setPreview((p) => (p?.url === link ? p : { url: link, draft: null, loading: true }))
    const timer = setTimeout(() => {
      void getPreview(link).then((draft) => live && setPreview({ url: link, draft, loading: false }))
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [link, wantsCard])

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  const send = async (): Promise<void> => {
    if (!user || !text.trim() || sending) return
    setSending(true)
    setError('')
    try {
      const draft = link && wantsCard ? await Promise.race([getPreview(link), wait(PREVIEW_WAIT_MS)]) : null
      if (draft) {
        // A message that's only the link needs no text under its card.
        const note = text.trim() === link ? null : text
        await sendMessage(roomId, user.uid, note, {
          url: draft.url,
          title: draft.title,
          thumbnail: draft.thumbnail,
          timestampSec: draft.timestampSec
        })
      } else {
        await sendMessage(roomId, user.uid, text)
      }
      setText('')
      setNoCard(null)
    } catch {
      setError("Couldn't send. Check your connection and try again.")
    } finally {
      setSending(false)
      input.current?.focus()
    }
  }

  return (
    <div className="composer-wrap">
      {error && <p className="form-error">{error}</p>}
      {preview && (preview.loading || preview.draft) && (
        <div className="composer-preview">
          {preview.draft?.thumbnail ? (
            <img className="composer-preview-thumb" src={preview.draft.thumbnail} alt="" draggable={false} />
          ) : (
            <img className="composer-preview-site" src={siteIcon(preview.url, 64)} alt="" draggable={false} />
          )}
          <span className="composer-preview-text">
            <strong>{preview.loading ? 'Getting a preview…' : preview.draft!.title}</strong>
            <span>{hostOf(preview.url)}</span>
          </span>
          <button className="icon-btn small" title="Send without a preview" onClick={() => setNoCard(preview.url)}>
            <X size={14} />
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={input}
          autoFocus
          rows={1}
          value={text}
          maxLength={2000}
          placeholder="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="icon-btn small send" type="submit" title="Send" disabled={!text.trim() || sending}>
          <SendHorizontal size={16} />
        </button>
      </form>
    </div>
  )
}

// ---- members and invites ----

const INVITE_TEXT: Record<InviteResult, string> = {
  invited: 'Invited! They can join from their Rooms tab.',
  'already-member': "They're already in this room.",
  'already-invited': 'They already have an invite.',
  'not-found': 'No one has that username. To invite someone new, use their email.',
  self: "That's you!",
  full: 'This room is full.'
}

function RoomDetails({ room, onLeft }: { room: Room; onLeft: () => void }): ReactNode {
  const { user, people, friends } = useSocial()
  const [who, setWho] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!user) return null
  const me = { uid: user.uid, email: user.email }

  const doInvite = async (input: string): Promise<void> => {
    const value = input.trim().replace(/^@/, '')
    if (!value || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await invite(room, me, value)
      const byEmail = result === 'invited' && value.includes('@')
      setMessage({
        text: byEmail ? "Invited! They'll see it when they sign in to Tabs with that email." : INVITE_TEXT[result],
        ok: result === 'invited'
      })
      if (result === 'invited') setWho('')
    } catch {
      setMessage({ text: 'Something went wrong. Try again.', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const suggestions = friends.filter((f) => f.profile && !room.members.includes(f.uid) && !room.invited.includes(f.uid))

  const copyCode = (): void => {
    void navigator.clipboard.writeText(formatJoinCode(room.joinCode))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="room-details">
      <section>
        <h4>Invite</h4>
        <form
          className="add-friend"
          onSubmit={(e) => {
            e.preventDefault()
            void doInvite(who)
          }}
        >
          <div className="input-prefix">
            <input
              autoFocus
              value={who}
              placeholder="Username or email"
              spellCheck={false}
              onChange={(e) => setWho(e.target.value)}
            />
          </div>
          <button className="primary-btn compact" type="submit" disabled={busy || !who.trim()}>
            <UserPlus size={15} />
            Invite
          </button>
        </form>
        {message && <p className={message.ok ? 'form-ok' : 'form-error'}>{message.text}</p>}
        {suggestions.length > 0 && (
          <div className="invite-suggestions">
            {suggestions.map((f) => (
              <button key={f.uid} className="invite-chip" disabled={busy} onClick={() => void doInvite(f.profile!.username)}>
                <Avatar profile={f.profile} size={18} />@{f.profile!.username}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4>Join code</h4>
        <div className="join-code">
          <code>{formatJoinCode(room.joinCode)}</code>
          <button className="icon-btn small" title="Copy code" onClick={copyCode}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            className="icon-btn small"
            title="New code (the old one stops working)"
            onClick={() => {
              if (confirm('Make a new code? The current one will stop working.')) void resetJoinCode(room).catch(() => {})
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <p className="muted">Anyone with this code can join.</p>
      </section>

      <section>
        <h4>Members · {room.members.length}</h4>
        {room.members.map((m) => (
          <PersonRow key={m} profile={people[m]} suffix={m === user.uid ? '(you)' : undefined} />
        ))}
      </section>

      {room.invited.length + room.invitedEmails.length > 0 && (
        <section>
          <h4>Invited</h4>
          {room.invited.map((m) => (
            <PersonRow key={m} profile={people[m]}>
              <button className="link-btn" onClick={() => void cancelInvite(room.id, { uid: m }).catch(() => {})}>
                Cancel
              </button>
            </PersonRow>
          ))}
          {room.invitedEmails.map((email) => (
            <div key={email} className="friend-row">
              <Avatar profile={null} size={32} />
              <div className="friend-name">
                <strong>{email}</strong>
                <span>Not joined yet</span>
              </div>
              <div className="friend-actions">
                <button className="link-btn" onClick={() => void cancelInvite(room.id, { email }).catch(() => {})}>
                  Cancel
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <button
        className="leave-btn"
        onClick={() => {
          const last = room.members.length <= 1
          if (!confirm(last ? `You're the last one here. Leaving deletes “${room.name}”.` : `Leave “${room.name}”?`)) return
          void leaveRoom(room, user.uid).then(onLeft, () => alert("Couldn't leave the room. Try again."))
        }}
      >
        <LogOut size={14} />
        Leave room
      </button>
    </div>
  )
}

function PersonRow({ profile, suffix, children }: { profile: Profile | null | undefined; suffix?: string; children?: ReactNode }): ReactNode {
  return (
    <div className="friend-row">
      <Avatar profile={profile} size={32} />
      <div className="friend-name">
        <strong>
          {profile?.displayName ?? '…'} {suffix && <span className="muted">{suffix}</span>}
        </strong>
        <span>{displayName(profile)}</span>
      </div>
      {children && <div className="friend-actions">{children}</div>}
    </div>
  )
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}
