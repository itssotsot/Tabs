import { ArrowDownToLine, ArrowLeft, ArrowRight, CircleArrowUp, MessagesSquare, MoreVertical, RotateCw, Send, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DownloadState, SidebarPanel, ToolbarExtension, UpdateReady, WindowState } from '@shared/types'
import { useSocial } from '../social/SocialProvider'
import { Avatar } from '../ui/Avatar'
import { cx, shortcut } from '../ui/util'
import { ExtensionButtons } from './ExtensionButtons'
import { Omnibox } from './Omnibox'

interface Props {
  state: WindowState
  downloads: DownloadState[]
  update: UpdateReady | null
  sidebar: SidebarPanel | null
  onToggleSidebar: (panel: SidebarPanel) => void
  extensions: ToolbarExtension[]
}

export function Toolbar({ state, downloads, update, sidebar, onToggleSidebar, extensions }: Props): ReactNode {
  const api = window.browserr
  const { user, profile, unreadCount, incoming } = useSocial()
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? null
  const canShare = !!tab && !tab.internal && !!tab.url

  const active = downloads.filter((d) => d.state === 'progressing')
  const progress = active.length
    ? active.reduce((sum, d) => sum + d.receivedBytes, 0) / Math.max(1, active.reduce((sum, d) => sum + d.totalBytes, 0))
    : 0

  return (
    <div className="toolbar">
      <button className="icon-btn" disabled={!tab?.canGoBack} title="Back" onClick={() => api.nav.back()}>
        <ArrowLeft size={17} />
      </button>
      <button className="icon-btn" disabled={!tab?.canGoForward} title="Forward" onClick={() => api.nav.forward()}>
        <ArrowRight size={17} />
      </button>
      {tab?.loading ? (
        <button className="icon-btn" title="Stop loading" onClick={() => api.nav.stop()}>
          <X size={17} />
        </button>
      ) : (
        <button className="icon-btn" title={`Reload (${shortcut('⌘R', 'Ctrl+R')})`} onClick={() => api.nav.reload()}>
          <RotateCw size={15} />
        </button>
      )}

      <Omnibox tab={tab} isBookmarked={state.isBookmarked} />

      <ExtensionButtons extensions={extensions} />

      <button
        className="send-btn"
        disabled={!canShare}
        title={`Send to a friend (${shortcut('⌘⇧S', 'Ctrl+Shift+S')})`}
        onClick={() => api.share.openPicker()}
      >
        <Send size={15} />
        <span>Send</span>
      </button>

      {downloads.length > 0 && (
        <button
          className={cx('icon-btn', sidebar === 'downloads' && 'pressed')}
          title="Downloads"
          onClick={() => onToggleSidebar('downloads')}
        >
          <ArrowDownToLine size={16} />
          {active.length > 0 && (
            <svg className="download-ring" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="16" pathLength="100" strokeDasharray={`${Math.round(progress * 100)} 100`} />
            </svg>
          )}
        </button>
      )}

      <button
        className={cx('icon-btn', sidebar === 'inbox' && 'pressed')}
        title={`Inbox (${shortcut('⌘⇧L', 'Ctrl+Shift+L')})`}
        onClick={() => onToggleSidebar('inbox')}
      >
        <MessagesSquare size={17} />
        {unreadCount > 0 && <span className="badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      <button
        className={cx('icon-btn avatar-btn', sidebar === 'friends' && 'pressed')}
        title={profile ? `@${profile.username}` : 'Sign in'}
        onClick={() => onToggleSidebar('friends')}
      >
        {user ? <Avatar profile={profile ?? null} photoURL={user.photoURL} size={22} /> : <Avatar profile={null} size={22} />}
        {incoming.length > 0 && <span className="badge dot" />}
      </button>

      {update && (
        <button className="update-btn" title={`Tabs ${update.version} is ready to install`} onClick={() => api.updates.install()}>
          <CircleArrowUp size={15} />
          <span>Update</span>
        </button>
      )}

      <button
        className="icon-btn"
        title="Menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          api.appMenu(r.left, r.bottom + 4)
        }}
      >
        <MoreVertical size={17} />
      </button>
    </div>
  )
}
