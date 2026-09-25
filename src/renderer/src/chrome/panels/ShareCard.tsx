import { Play, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { REACTIONS } from '@shared/constants'
import { hostOf } from '@shared/url'
import { formatTimestamp } from '@shared/youtube'
import type { Profile, Share } from '../../social/api'
import { Avatar } from '../../ui/Avatar'
import { cx, siteIcon, timeAgo } from '../../ui/util'

interface Props {
  share: Share
  person: Profile | null | undefined
  direction: 'in' | 'out'
  onOpen: (background: boolean) => void
  onReact?: (reaction: string | null) => void
  onDelete: () => void
}

export function ShareCard({ share, person, direction, onOpen, onReact, onDelete }: Props): ReactNode {
  const [thumbFailed, setThumbFailed] = useState(false)
  const unseen = direction === 'in' && !share.seenAt

  return (
    <div
      className={cx('share-card', unseen && 'unseen')}
      role="button"
      tabIndex={0}
      onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && onOpen(true)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(false)}
    >
      <div className="share-thumb">
        {share.thumbnail && !thumbFailed ? (
          <img src={share.thumbnail} alt="" draggable={false} onError={() => setThumbFailed(true)} />
        ) : (
          <img className="share-site" src={siteIcon(share.url, 64)} alt="" draggable={false} />
        )}
        {share.timestampSec != null && share.timestampSec > 0 && (
          <span className="share-time">
            <Play size={9} fill="currentColor" />
            {formatTimestamp(share.timestampSec)}
          </span>
        )}
      </div>

      <div className="share-main">
        <div className="share-title">{share.title}</div>
        <div className="share-meta">
          <Avatar profile={person} size={16} />
          <span>
            {direction === 'in' ? '' : 'to '}
            {person ? `@${person.username}` : '…'}
          </span>
          <span className="dot-sep">·</span>
          <span>{timeAgo(share.createdAt)}</span>
          <span className="dot-sep">·</span>
          <span className="share-host">{hostOf(share.url)}</span>
        </div>
        {share.note && <div className="share-note">“{share.note}”</div>}

        {direction === 'in' && onReact && (
          <div className="reactions" onClick={(e) => e.stopPropagation()}>
            {REACTIONS.map((r) => (
              <button
                key={r}
                className={cx('reaction', share.reaction === r && 'on')}
                onClick={() => onReact(share.reaction === r ? null : r)}
              >
                {r}
              </button>
            ))}
          </div>
        )}
        {direction === 'out' && (
          <div className="share-status">
            {share.reaction && <span className="reaction-received">{share.reaction}</span>}
            <span>{share.seenAt ? `Opened ${timeAgo(share.seenAt)}` : 'Not opened yet'}</span>
          </div>
        )}
      </div>

      <button
        className="share-delete"
        title={direction === 'in' ? 'Remove' : 'Unsend'}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <X size={13} />
      </button>
    </div>
  )
}
