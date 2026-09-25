import { Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Bookmark } from '@shared/types'
import { prettyUrl } from '@shared/url'
import { siteIcon } from '../ui/util'

function BookmarkRow({ bookmark, onChange }: { bookmark: Bookmark; onChange: () => void }): ReactNode {
  const api = window.browserrInternal
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(bookmark.title)

  const save = async (): Promise<void> => {
    setEditing(false)
    if (title.trim() && title !== bookmark.title) {
      await api.renameBookmark(bookmark.id, title.trim())
      onChange()
    } else {
      setTitle(bookmark.title)
    }
  }

  return (
    <div className="row">
      <img className="row-icon" src={siteIcon(bookmark.url)} alt="" />
      {editing ? (
        <input
          className="row-edit"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') {
              setTitle(bookmark.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <a className="row-title" href={bookmark.url} title={bookmark.url}>
          {bookmark.title}
        </a>
      )}
      <span className="row-url">{prettyUrl(bookmark.url)}</span>
      <button className="row-remove" title="Rename" onClick={() => setEditing(true)}>
        <Pencil size={14} />
      </button>
      <button
        className="row-remove"
        title="Delete"
        onClick={async () => {
          await api.removeBookmark(bookmark.id)
          onChange()
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

export function BookmarksPage(): ReactNode {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const load = (): void => void window.browserrInternal.bookmarks().then(setBookmarks)
  const isMac = navigator.platform.toLowerCase().includes('mac')

  useEffect(load, [])

  return (
    <main className="page">
      <header className="page-head">
        <h1>Bookmarks</h1>
      </header>
      {!bookmarks.length ? (
        <p className="empty">
          No bookmarks yet. Press <kbd>{isMac ? '⌘D' : 'Ctrl+D'}</kbd> or click the star in the address bar to add one.
        </p>
      ) : (
        <section className="card">
          {bookmarks.map((b) => (
            <BookmarkRow key={`${b.id}:${b.title}`} bookmark={b} onChange={load} />
          ))}
        </section>
      )}
    </main>
  )
}
