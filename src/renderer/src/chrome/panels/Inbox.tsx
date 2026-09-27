import { LogIn, MessagesSquare, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { acceptInvite, createRoom, declineInvite, isUnread, joinWithCode, type Room } from '../../social/api'
import { directPartner, displayName, roomTitle, useSocial } from '../../social/SocialProvider'
import { RoomAvatar } from '../../ui/Avatar'
import { cx, shortcut, timeAgo } from '../../ui/util'
import { RoomView } from './RoomView'

interface Props {
  roomId: string | null
  onRoom: (roomId: string | null) => void
}

/** Direct chats with friends and group rooms, most recent first. */
export function InboxPanel({ roomId, onRoom }: Props): ReactNode {
  const { user, rooms } = useSocial()
  if (!user) return null
  const room = roomId ? rooms.find((r) => r.id === roomId) : undefined
  // Right after joining (or befriending), the room may not have arrived yet; show the list until it does.
  if (room) return <RoomView key={room.id} room={room} onBack={() => onRoom(null)} />
  return <RoomList onOpen={onRoom} />
}

function RoomList({ onOpen }: { onOpen: (roomId: string) => void }): ReactNode {
  const { user, rooms, invites, people } = useSocial()
  const [mode, setMode] = useState<'create' | 'join' | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!user) return null

  const toggle = (next: 'create' | 'join'): void => {
    setMode((m) => (m === next ? null : next))
    setValue('')
    setError('')
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'create') {
        onOpen(await createRoom(user.uid, value))
        setMode(null)
      } else {
        const result = await joinWithCode(user.uid, user.email, value)
        if (result.ok) {
          onOpen(result.roomId)
          setMode(null)
        } else {
          setError(result.reason === 'not-found' ? 'No room has that code.' : "Couldn't join. The room may be full.")
        }
      }
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const respond = async (room: Room, accept: boolean): Promise<void> => {
    try {
      if (accept) {
        await acceptInvite(room.id, user.uid, user.email)
        onOpen(room.id)
      } else {
        await declineInvite(room.id, user.uid, user.email)
      }
    } catch {
      setError('Something went wrong. Try again.')
    }
  }

  return (
    <div className="rooms-panel">
      <div className="rooms-actions">
        <button className={cx('ghost-btn', mode === 'create' && 'on')} onClick={() => toggle('create')}>
          <Plus size={15} />
          New group
        </button>
        <button className={cx('ghost-btn', mode === 'join' && 'on')} onClick={() => toggle('join')}>
          <LogIn size={15} />
          Join with code
        </button>
      </div>

      {mode && (
        <form className="add-friend" onSubmit={submit}>
          <div className="input-prefix">
            <input
              autoFocus
              value={value}
              maxLength={mode === 'create' ? 64 : 16}
              placeholder={mode === 'create' ? 'Group name' : 'ABCDE-FGH23'}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <button className="primary-btn compact" type="submit" disabled={busy || !value.trim()}>
            {mode === 'create' ? 'Create' : 'Join'}
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}

      {invites.length > 0 && (
        <section>
          <h4>Invites</h4>
          {invites.map((room) => (
            <div key={room.id} className="friend-row">
              <RoomAvatar room={room} me={user.uid} people={people} size={32} />
              <div className="friend-name">
                <strong>{room.name}</strong>
                <span>{room.members.map((m) => displayName(people[m])).join(', ')}</span>
              </div>
              <div className="friend-actions">
                <button className="primary-btn compact" onClick={() => void respond(room, true)}>
                  Join
                </button>
                <button className="icon-btn small" title="Decline" onClick={() => void respond(room, false)}>
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {rooms.length === 0 && invites.length === 0 ? (
        <div className="panel-empty">
          <MessagesSquare size={28} strokeWidth={1.5} />
          <h3>Your inbox is empty</h3>
          <p>
            Add a friend in the Friends tab and your chat with them shows up here. For more people, start a group and
            invite them by username or email.
          </p>
          <p className="muted">
            Tip: press <kbd>{shortcut('⌘⇧S', 'Ctrl+Shift+S')}</kbd> to send the page you're on to a chat.
          </p>
        </div>
      ) : (
        rooms.length > 0 && (
          <section>
            <h4>Chats</h4>
            {rooms.map((room) => (
              <RoomRow key={room.id} room={room} onOpen={() => onOpen(room.id)} />
            ))}
          </section>
        )
      )}
    </div>
  )
}

function RoomRow({ room, onOpen }: { room: Room; onOpen: () => void }): ReactNode {
  const { user, people } = useSocial()
  if (!user) return null
  const unread = isUnread(room, user.uid)
  const m = room.lastMessage
  const partner = directPartner(room, user.uid)
  let preview = partner
    ? `Say hi to ${displayName(people[partner])}`
    : `${room.members.length} ${room.members.length === 1 ? 'member' : 'members'}`
  if (m) {
    const body = m.url ? `🔗 ${m.title || m.url}` : m.text
    // In a direct chat, their messages need no name.
    if (m.from === user.uid) preview = `You: ${body}`
    else preview = partner ? `${body}` : `${displayName(people[m.from])}: ${body}`
  }

  return (
    <button className={cx('room-row', unread && 'unread')} onClick={onOpen}>
      <RoomAvatar room={room} me={user.uid} people={people} size={36} />
      <span className="room-row-main">
        <span className="room-row-top">
          <strong>{roomTitle(room, user.uid, people)}</strong>
          {m && <span className="room-row-time">{timeAgo(room.lastMessageAt)}</span>}
        </span>
        <span className="room-row-preview">{preview}</span>
      </span>
      {unread && <span className="unread-dot" />}
    </button>
  )
}
