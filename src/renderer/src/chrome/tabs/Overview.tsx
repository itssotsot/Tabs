import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TabState, WindowState } from '@shared/types'
import { hostOf } from '@shared/url'
import { displayName, useSocial } from '../../social/SocialProvider'
import { Avatar } from '../../ui/Avatar'
import { cx } from '../../ui/util'
import { pageKey, useLinks, type SharedLink } from './links'
import { LinkIcon, StarButton, TabIcon, useLinkCaption, useLinkMenu } from './parts'

type Filter = 'all' | 'tabs' | 'shared' | 'favorites'

interface Card {
  key: string
  url: string
  title: string
  kind: Exclude<Filter, 'all'>
  tab?: TabState
  link?: SharedLink
  bookmarkId?: string
}

/** One searchable view of open tabs, favorites and links from chats. Replaces the page while open. */
export function Overview({ state, onClose }: { state: WindowState; onClose: () => void }): ReactNode {
  const { people } = useSocial()
  const { links, favorites, linkFor, linkForTab, open } = useLinks()
  const caption = useLinkCaption()
  const linkMenu = useLinkMenu()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [person, setPerson] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const tabs: Card[] = state.tabs.map((t) => ({ key: `tab:${t.id}`, url: t.url, title: t.title, kind: 'tabs', tab: t }))
  const favs: Card[] = favorites.map((b) => ({ key: `fav:${b.id}`, url: b.url, title: b.title, kind: 'favorites', bookmarkId: b.id }))
  const pages = new Set<string>()
  const shared: Card[] = []
  for (const link of links) {
    const page = pageKey(link.url)
    if (link.mine || pages.has(page)) continue
    pages.add(page)
    shared.push({ key: link.key, url: link.url, title: link.title, kind: 'shared', link })
  }

  const senders = [...new Set(links.filter((l) => !l.mine).map((l) => l.from))]
  const q = query.trim().toLowerCase()
  const matches = (c: Card): boolean => {
    if (person && (c.link ?? (c.tab ? linkForTab(c.tab) : linkFor(c.url)))?.from !== person) return false
    return !q || c.title.toLowerCase().includes(q) || c.url.toLowerCase().includes(q)
  }
  const sections: { id: Exclude<Filter, 'all'>; title: string; cards: Card[] }[] = [
    { id: 'tabs' as const, title: 'Open tabs', cards: tabs.filter(matches) },
    { id: 'favorites' as const, title: 'Favorites', cards: favs.filter(matches) },
    { id: 'shared' as const, title: 'From chats', cards: shared.filter(matches) }
  ].filter((s) => filter === 'all' || s.id === filter)
  const first = sections.find((s) => s.cards.length)?.cards[0]

  const choose = (card: Card, background = false): void => {
    if (card.tab) window.browserr.tabs.activate(card.tab.id)
    else open(card.url, { background, link: card.link })
    if (!background) onClose()
  }

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'Everything' },
    { id: 'tabs', label: `Open tabs · ${tabs.length}` },
    { id: 'favorites', label: `Favorites · ${favs.length}` },
    { id: 'shared', label: `From chats · ${shared.length}` }
  ]

  return (
    <div
      className="overview"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="overview-head">
        <div className="overview-search">
          <Search size={16} />
          <input
            ref={input}
            value={query}
            placeholder="Search tabs, favorites and links from friends"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && first) choose(first, e.metaKey || e.ctrlKey)
            }}
          />
          <kbd>esc</kbd>
        </div>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="overview-filters">
        {filters.map((f) => (
          <button key={f.id} className={cx('filter-chip', filter === f.id && 'on')} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
        {senders.length > 0 && <span className="filter-sep" />}
        {senders.map((uid) => (
          <button
            key={uid}
            className={cx('filter-chip person', person === uid && 'on')}
            title={`Only things ${displayName(people[uid])} sent`}
            onClick={() => setPerson(person === uid ? null : uid)}
          >
            <Avatar profile={people[uid]} size={16} />
            {displayName(people[uid])}
          </button>
        ))}
      </div>

      <div className="overview-body">
        {sections.every((s) => !s.cards.length) && <p className="overview-empty">Nothing matches “{query}”.</p>}
        {sections.map(
          (s) =>
            s.cards.length > 0 && (
              <section key={s.id}>
                <h3>{s.title}</h3>
                <div className="overview-grid">
                  {s.cards.map((card) => (
                    <div
                      key={card.key}
                      role="button"
                      className={cx('ov-card', card.tab?.id === state.activeTabId && 'active', card === first && q && 'first', card.link && !card.link.opened && 'fresh')}
                      title={card.url}
                      onClick={(e) => choose(card, e.metaKey || e.ctrlKey)}
                      onAuxClick={(e) => e.button === 1 && choose(card, true)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        if (card.tab) window.browserr.tabs.contextMenu(card.tab.id)
                        else if (card.bookmarkId) window.browserr.bookmarks.contextMenu(card.bookmarkId)
                        else linkMenu(card.url, card.title, { link: card.link })
                      }}
                    >
                      {card.link?.thumbnail ? (
                        <div className="ov-thumb">
                          <img src={card.link.thumbnail} alt="" draggable={false} />
                        </div>
                      ) : (
                        <div className="ov-thumb empty">
                          {card.tab ? <TabIcon tab={card.tab} /> : <LinkIcon url={card.url} />}
                        </div>
                      )}
                      <div className="ov-text">
                        <strong>{card.title || card.url}</strong>
                        <span>
                          {card.link ? (
                            <LinkIcon url={card.url} link={card.link} />
                          ) : card.tab ? (
                            <TabIcon tab={card.tab} />
                          ) : (
                            <LinkIcon url={card.url} link={linkFor(card.url)} />
                          )}
                          {card.link ? caption(card.link) : card.url ? hostOf(card.url) : 'New tab'}
                        </span>
                      </div>
                      {card.url && !card.tab?.internal && <StarButton url={card.url} title={card.title} className="ov-star" />}
                      {card.tab && (
                        <button
                          className="ov-close"
                          title="Close tab"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.browserr.tabs.close(card.tab!.id)
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
        )}
      </div>
    </div>
  )
}
