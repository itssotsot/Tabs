import { Puzzle, X } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { DownloadState, ExtensionPanelInfo, SidebarPanel } from '@shared/types'
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
  extensionPanel: ExtensionPanelInfo | null
}

/** An extension's side panel: our header, and the extension's page (placed by the main process) below it. */
function ExtensionSidePanel({ panel, onClose }: { panel: ExtensionPanelInfo; onClose: () => void }): ReactNode {
  const api = window.browserr
  const bodyRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const report = (): void => {
      const r = body.getBoundingClientRect()
      api.extensions.panelBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(body)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      api.extensions.panelBounds(null)
    }
  }, [panel.id])

  return (
    <>
      <div className="sidebar-head ext-panel-head">
        {panel.icon ? <img src={panel.icon} width={16} height={16} alt="" /> : <Puzzle size={15} />}
        <span className="ext-panel-name">{panel.name}</span>
        <button
          className="icon-btn small"
          title="Close side panel"
          onClick={() => {
            api.extensions.closePanel()
            onClose()
          }}
        >
          <X size={15} />
        </button>
      </div>
      <div ref={bodyRef} className="ext-panel-body" />
    </>
  )
}

export function Sidebar({ panel, onPanel, onClose, downloads, roomId, onRoom, extensionPanel }: Props): ReactNode {
  const { authReady, user, profile, unreadCount, incoming } = useSocial()

  if (panel === 'extension') {
    return extensionPanel ? <ExtensionSidePanel panel={extensionPanel} onClose={onClose} /> : null
  }

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
