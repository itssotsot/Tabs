import { Check, Copy, MessageCircle, UserPlus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { acceptFriend, addFriend, directRoomId, removeFriendship, unfriend, type FriendRequestResult } from '../../social/api'
import { useSocial, type Friend } from '../../social/SocialProvider'
import { Avatar } from '../../ui/Avatar'

const RESULT_TEXT: Record<FriendRequestResult, string> = {
  sent: 'Request sent. Once they accept, your chat shows up in your inbox.',
  accepted: 'They had already asked you, so you are now friends! Your chat is in your inbox.',
  'already-friends': 'You are already friends.',
  'already-requested': 'You already sent them a request.',
  'not-found': 'No one has that username.',
  self: "That's you!"
}

function FriendRow({ friend, children }: { friend: Friend; children?: ReactNode }): ReactNode {
  return (
    <div className="friend-row">
      <Avatar profile={friend.profile} size={32} />
      <div className="friend-name">
        <strong>{friend.profile?.displayName ?? '…'}</strong>
        <span>@{friend.profile?.username ?? '…'}</span>
      </div>
      <div className="friend-actions">{children}</div>
    </div>
  )
}

export function FriendsPanel({ onOpenChat }: { onOpenChat: (roomId: string) => void }): ReactNode {
  const { user, profile, friends, incoming, outgoing } = useSocial()
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!user || !profile) return null

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = username.trim().replace(/^@/, '').toLowerCase()
    if (!name) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await addFriend(user.uid, name)
      setMessage({ text: RESULT_TEXT[result], ok: result === 'sent' || result === 'accepted' })
      if (result === 'sent' || result === 'accepted') setUsername('')
    } catch {
      setMessage({ text: 'Something went wrong. Try again.', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const copyUsername = (): void => {
    void navigator.clipboard.writeText(`@${profile.username}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="friends-panel">
      <form className="add-friend" onSubmit={submit}>
        <div className="input-prefix">
          <span>@</span>
          <input
            value={username}
            placeholder="friend's username"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <button className="primary-btn compact" type="submit" disabled={busy || !username.trim()}>
          <UserPlus size={15} />
          Add
        </button>
      </form>
      {message && <p className={message.ok ? 'form-ok' : 'form-error'}>{message.text}</p>}

      <button className="my-username" onClick={copyUsername} title="Copy your username">
        Your username is <strong>@{profile.username}</strong>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>

      {incoming.length > 0 && (
        <section>
          <h4>Requests</h4>
          {incoming.map((f) => (
            <FriendRow key={f.friendshipId} friend={f}>
              <button
                className="primary-btn compact"
                onClick={() => void acceptFriend(user.uid, f.uid).then(() => onOpenChat(directRoomId(user.uid, f.uid)))}
              >
                Accept
              </button>
              <button className="icon-btn small" title="Decline" onClick={() => void removeFriendship(f.friendshipId)}>
                <X size={15} />
              </button>
            </FriendRow>
          ))}
        </section>
      )}

      <section>
        <h4>Friends{friends.length ? ` · ${friends.length}` : ''}</h4>
        {friends.length === 0 && <p className="muted">No friends yet. Ask a friend for their username and add them above.</p>}
        {friends.map((f) => (
          <FriendRow key={f.friendshipId} friend={f}>
            <button className="icon-btn small" title="Message" onClick={() => onOpenChat(directRoomId(user.uid, f.uid))}>
              <MessageCircle size={15} />
            </button>
            <button
              className="icon-btn small"
              title="Remove friend"
              onClick={() => {
                if (confirm(`Remove @${f.profile?.username ?? 'this friend'}? Your chat with them will be deleted.`)) {
                  void unfriend(user.uid, f.uid).catch(() => alert("Couldn't remove them. Try again."))
                }
              }}
            >
              <X size={15} />
            </button>
          </FriendRow>
        ))}
      </section>

      {outgoing.length > 0 && (
        <section>
          <h4>Waiting for them</h4>
          {outgoing.map((f) => (
            <FriendRow key={f.friendshipId} friend={f}>
              <button className="link-btn" onClick={() => void removeFriendship(f.friendshipId)}>
                Cancel
              </button>
            </FriendRow>
          ))}
        </section>
      )}
    </div>
  )
}
