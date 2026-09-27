import { Volume2, VolumeX, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { GROUP_PEEK_HEAD_HEIGHT, GROUP_PEEK_MARGIN, GROUP_PEEK_PADDING, GROUP_PEEK_ROW_HEIGHT, GROUP_PEEK_WIDTH } from '@shared/constants'
import type { OverlayState } from '@shared/types'
import { TabIcon } from '../chrome/tabs/parts'
import { cx } from '../ui/util'

/** A collapsed group's tabs, beside its chip. Click one to switch to it. */
export function GroupPeek({ state }: { state: Extract<OverlayState, { mode: 'group' }> }): ReactNode {
  const { tabs, overlay } = window.browserr
  const style = {
    '--group': state.color,
    width: GROUP_PEEK_WIDTH,
    margin: GROUP_PEEK_MARGIN,
    padding: GROUP_PEEK_PADDING,
    maxHeight: `calc(100vh - ${GROUP_PEEK_MARGIN * 2}px)`
  } as CSSProperties
  return (
    <div className="group-peek" style={style} onMouseEnter={() => overlay.peekHover(true)} onMouseLeave={() => overlay.peekHover(false)}>
      <div className="group-peek-head" style={{ height: GROUP_PEEK_HEAD_HEIGHT }}>
        <span className="group-peek-name">{state.name}</span>
        <span className="group-count">{state.tabs.length}</span>
      </div>
      <div className="group-peek-list" role="listbox">
        {state.tabs.map((tab) => (
          <div
            key={tab.id}
            role="option"
            aria-selected={tab.id === state.activeTabId}
            className={cx('group-peek-tab', tab.id === state.activeTabId && 'active', tab.sleeping && 'sleeping')}
            style={{ height: GROUP_PEEK_ROW_HEIGHT }}
            title={tab.url ? `${tab.title}\n${tab.url}` : tab.title}
            onClick={() => {
              tabs.activate(tab.id)
              overlay.close()
            }}
            onAuxClick={(e) => e.button === 1 && tabs.close(tab.id)}
          >
            <TabIcon tab={tab} />
            <span className="group-peek-title">{tab.title}</span>
            {(tab.audible || tab.muted) && (tab.muted ? <VolumeX size={13} className="group-peek-audio" /> : <Volume2 size={13} className="group-peek-audio" />)}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                tabs.close(tab.id)
              }}
            >
              <X size={13} strokeWidth={2.25} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
