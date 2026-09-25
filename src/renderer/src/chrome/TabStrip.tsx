import { Globe, Plus, Volume2, VolumeX, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { TabState, WindowState } from '@shared/types'
import { cx, shortcut } from '../ui/util'

function TabIcon({ tab }: { tab: TabState }): ReactNode {
  const [broken, setBroken] = useState<string | null>(null)
  if (tab.loading) return <span className="spinner" />
  if (tab.favicon && broken !== tab.favicon) {
    return <img className="favicon" src={tab.favicon} alt="" draggable={false} onError={() => setBroken(tab.favicon)} />
  }
  return <Globe className="favicon" size={15} strokeWidth={1.75} />
}

interface TabItemProps {
  tab: TabState
  index: number
  active: boolean
  dragging: boolean
  onDragStart: () => void
  onDrop: (index: number) => void
}

function TabItem({ tab, index, active, dragging, onDragStart, onDrop }: TabItemProps): ReactNode {
  const { tabs } = window.browserr
  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.url ? `${tab.title}\n${tab.url}` : tab.title}
      className={cx('tab', active && 'active', tab.pinned && 'pinned', dragging && 'dragging')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(index)
      }}
      onMouseDown={(e) => {
        if (e.button === 0) tabs.activate(tab.id)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) tabs.close(tab.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        tabs.contextMenu(tab.id)
      }}
    >
      <TabIcon tab={tab} />
      {!tab.pinned && <span className="tab-title">{tab.title}</span>}
      {(tab.audible || tab.muted) && (
        <button
          className="tab-audio"
          title={tab.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => tabs.toggleMute(tab.id)}
        >
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      {!tab.pinned && (
        <button
          className="tab-close"
          title={`Close tab (${shortcut('⌘W', 'Ctrl+W')})`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => tabs.close(tab.id)}
        >
          <X size={13} strokeWidth={2.25} />
        </button>
      )}
    </div>
  )
}

export function TabStrip({ state }: { state: WindowState }): ReactNode {
  const [dragId, setDragId] = useState<number | null>(null)
  const { platform } = window.browserr
  const leftPad = platform === 'darwin' && !state.fullscreen ? 80 : 8
  const rightPad = platform === 'darwin' ? 8 : 146

  return (
    <div className="tabstrip" style={{ paddingLeft: leftPad, paddingRight: rightPad }}>
      <div className="tabs" role="tablist" onDragEnd={() => setDragId(null)}>
        {state.tabs.map((tab, i) => (
          <TabItem
            key={tab.id}
            tab={tab}
            index={i}
            active={tab.id === state.activeTabId}
            dragging={tab.id === dragId}
            onDragStart={() => setDragId(tab.id)}
            onDrop={(to) => {
              if (dragId !== null) window.browserr.tabs.move(dragId, to)
              setDragId(null)
            }}
          />
        ))}
        <button
          className="icon-btn newtab-btn"
          title={`New tab (${shortcut('⌘T', 'Ctrl+T')})`}
          onClick={() => window.browserr.tabs.create()}
        >
          <Plus size={16} />
        </button>
      </div>
      {state.profile && (
        <span className="profile-chip" title={`Profile: ${state.profile}`}>
          {state.profile}
        </span>
      )}
    </div>
  )
}
