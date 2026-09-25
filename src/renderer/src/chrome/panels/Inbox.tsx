import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { deleteShare, markSeen, react } from '../../social/api'
import { useSocial } from '../../social/SocialProvider'
import { shortcut } from '../../ui/util'
import { ShareCard } from './ShareCard'

export function InboxPanel(): ReactNode {
  const { inbox, people, unseenCount, friends } = useSocial()

  if (!inbox.length) {
    return (
      <div className="panel-empty">
        <Inbox size={28} strokeWidth={1.5} />
        <h3>No links yet</h3>
        <p>
          {friends.length
            ? 'When friends send you something, it shows up here.'
            : 'Add a friend in the Friends tab. Links they send land here.'}
        </p>
        <p className="muted">
          Tip: press <kbd>{shortcut('⌘⇧S', 'Ctrl+Shift+S')}</kbd> to send the page you're on.
        </p>
      </div>
    )
  }

  const markAll = (): void => {
    for (const s of inbox) if (!s.seenAt) void markSeen(s.id)
  }

  return (
    <div className="share-list">
      {unseenCount > 0 && (
        <div className="list-actions">
          <span>{unseenCount} new</span>
          <button className="link-btn" onClick={markAll}>
            Mark all as seen
          </button>
        </div>
      )}
      {inbox.map((share) => (
        <ShareCard
          key={share.id}
          share={share}
          person={people[share.from]}
          direction="in"
          onOpen={(background) => {
            window.browserr.openUrl(share.url, background)
            if (!share.seenAt) void markSeen(share.id)
          }}
          onReact={(reaction) => {
            void react(share.id, reaction)
            if (!share.seenAt) void markSeen(share.id)
          }}
          onDelete={() => void deleteShare(share.id)}
        />
      ))}
    </div>
  )
}
