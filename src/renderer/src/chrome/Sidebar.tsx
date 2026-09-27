import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DownloadState, SidebarPanel } from '@shared/types'
import { useSocial } from '../social/SocialProvider'
import { cx } from '../ui/util'
import { AccountFooter, SignInCard, UsernameSetup } from './panels/Account'
import { DownloadsPanel } from './panels/Downloads'
import { FriendsPanel } from './panels/Friends'
import { InboxPanel } from './panels/Inbox'

interface Props {
  panel: SidebarPanel
  onPanel: (panel: SidebarPanel) => void
  onClose: () => void
  downloads: DownloadState[]
  roomId: string | null
  onRoom: (roomId: string | null) => void
}

export function Sidebar({ panel, onPanel, onClose, downloads, roomId, onRoom }: Props): ReactNode {
  const { authReady, user, profile, unreadCount, incoming } = useSocial()

  const tabs: { id: SidebarPanel; label: string; count?: number }[] = [
    { id: 'inbox', label: 'Inbox', count: unreadCount },
    { id: 'friends', label: 'Friends', count: incoming.length },
    { id: 'downloads', label: 'Downloads' }
  ]

  let body: ReactNode
  if (panel === 'downloads') body = <DownloadsPanel downloads={downloads} />
  else if (!authReady || (user && profile === undefined)) body = <div className="panel-empty"><span className="spinner" /></div>
  else if (!user) body = <SignInCard />
  else if (!profile) body = <UsernameSetup />
  else if (panel === 'inbox') body = <InboxPanel roomId={roomId} onRoom={onRoom} />
  else {
    body = (
      <FriendsPanel
        onOpenChat={(id) => {
          onRoom(id)
          onPanel('inbox')
        }}
      />
    )
  }

  return (
    <>
      <div className="sidebar-head">
        <div className="segmented" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={panel === t.id}
              className={cx('segment', panel === t.id && 'active')}
              onClick={() => onPanel(t.id)}
            >
              {t.label}
              {!!t.count && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>
        <button className="icon-btn small" title="Close sidebar" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="sidebar-body">{body}</div>
      {user && profile && <AccountFooter />}
    </>
  )
}
