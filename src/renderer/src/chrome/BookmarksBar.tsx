import type { ReactNode } from 'react'
import type { Bookmark } from '@shared/types'
import { siteIcon } from '../ui/util'

export function BookmarksBar({ bookmarks }: { bookmarks: Bookmark[] }): ReactNode {
  const api = window.browserr.bookmarks
  return (
    <div className="bookmarks-bar">
      {bookmarks.map((b) => (
        <button
          key={b.id}
          className="bookmark"
          title={`${b.title}\n${b.url}`}
          onClick={(e) => api.open(b.url, e.metaKey || e.ctrlKey)}
          onAuxClick={(e) => e.button === 1 && api.open(b.url, true)}
          onContextMenu={(e) => {
            e.preventDefault()
            api.contextMenu(b.id)
          }}
        >
          <img src={siteIcon(b.url)} alt="" draggable={false} />
          <span>{b.title}</span>
        </button>
      ))}
    </div>
  )
}
