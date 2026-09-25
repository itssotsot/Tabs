import { Search, Send } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { Bookmark, HistoryEntry, Settings } from '@shared/types'
import { hostOf, SEARCH_ENGINE_NAMES, toNavigableUrl } from '@shared/url'
import { siteIcon } from '../ui/util'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Up late?'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function Tile({ url, title }: { url: string; title: string }): ReactNode {
  return (
    <a className="tile" href={url} title={`${title}\n${url}`}>
      <span className="tile-icon">
        <img src={siteIcon(url, 64)} alt="" />
      </span>
      <span className="tile-title">{title || hostOf(url)}</span>
    </a>
  )
}

export function NewTabPage(): ReactNode {
  const api = window.browserrInternal
  const [settings, setSettings] = useState<Settings | null>(null)
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [query, setQuery] = useState('')
  const isMac = navigator.platform.toLowerCase().includes('mac')

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.topSites().then(setTopSites)
    void api.bookmarks().then(setBookmarks)
  }, [])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (query.trim()) location.href = toNavigableUrl(query, settings?.searchEngine ?? 'google')
  }

  return (
    <main className="newtab">
      <h1 className="greeting">{greeting()}</h1>
      <form className="search" onSubmit={submit}>
        <Search size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${SEARCH_ENGINE_NAMES[settings?.searchEngine ?? 'google']} or type a URL`}
          spellCheck={false}
        />
      </form>

      {topSites.length > 0 && (
        <section className="tiles">
          {topSites.map((s) => (
            <Tile key={s.url} url={new URL(s.url).origin} title={hostOf(s.url)} />
          ))}
        </section>
      )}

      {bookmarks.length > 0 && (
        <section className="newtab-section">
          <h2>Bookmarks</h2>
          <div className="tiles">
            {bookmarks.slice(0, 16).map((b) => (
              <Tile key={b.id} url={b.url} title={b.title} />
            ))}
          </div>
        </section>
      )}

      <div className="tip">
        <Send size={14} />
        <span>
          Found something good? Press <kbd>{isMac ? '⌘⇧S' : 'Ctrl+Shift+S'}</kbd> to send it to a friend.
        </span>
      </div>
    </main>
  )
}
