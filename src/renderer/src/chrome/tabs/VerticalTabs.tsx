import { Archive, ChevronRight, MessagesSquare, RotateCcw, Volume2, VolumeX, X } from 'lucide-react'
import { forwardRef, useRef, useState, type ReactNode } from 'react'
import type { TabLayout, TabState, WindowState } from '@shared/types'
import { roomTitle, useSocial } from '../../social/SocialProvider'
import { RoomAvatar } from '../../ui/Avatar'
import { popupMenu } from '../../ui/menu'
import { cx, timeAgo } from '../../ui/util'
import { pageKey, useLinks, type SharedLink } from './links'
import { LayoutButton, LinkIcon, linkTooltip, NewTabButton, StarButton, TabIcon, TabItem, useLinkCaption, useLinkMenu, useStoredState, useTabDrag } from './parts'
import { closeGroupPeek, SiteGroupedTabs, siteGroups, useCollapsedSites } from './SiteGroups'

const ROOM_PREVIEW = 4
const ROOM_EXPANDED = 25
const WIDTH_DEFAULT = 264
const WIDTH_MIN = 200
const WIDTH_MAX = 520

interface Props {
  state: WindowState
  layout: TabLayout
  onOpenRoom: (roomId: string) => void
}

/** Layout 1: a column on the left with favorites, the links from each chat, and your open tabs. */
export const VerticalTabs = forwardRef<HTMLElement, Props>(function VerticalTabs({ state, layout, onOpenRoom }, ref) {
  const { user, people } = useSocial()
  const { rooms, favorites, linkFor, open, tabFor, archive, unarchive } = useLinks()
  const caption = useLinkCaption()
  const linkMenu = useLinkMenu()
  const drag = useTabDrag()
  const [collapsed, setCollapsed] = useStoredState<string[]>('browserr.vtabs.collapsed', [])
  const [width, setWidth] = useStoredState('browserr.vtabs.width', WIDTH_DEFAULT)
  const [collapsedSites, setCollapsedSites] = useCollapsedSites()
  const [showAll, setShowAll] = useState<string[]>([])
  const [showArchived, setShowArchived] = useState<string[]>([])
  const mac = window.browserr.platform === 'darwin'

  // A chat link you open becomes that row's tab: it stays with the row (even if you browse on in it)
  // instead of showing up again under Tabs. Tab ids only live as long as the app, so this isn't saved.
  const bindings = useRef(new Map<string, number>())
  const liveIds = new Set(state.tabs.map((t) => t.id))
  for (const [key, id] of bindings.current) if (!liveIds.has(id)) bindings.current.delete(key)
  const bound = new Set(bindings.current.values())
  // The tab opened from a row belongs to it even if the site redirects somewhere else.
  const pending = useRef<{ key: string; known: Set<number>; at: number } | null>(null)
  if (pending.current && Date.now() - pending.current.at > 10_000) pending.current = null
  if (pending.current) {
    const known = pending.current.known
    const tab = state.tabs.findLast((t) => !t.pinned && !known.has(t.id) && !bound.has(t.id))
    if (tab) {
      bindings.current.set(pending.current.key, tab.id)
      bound.add(tab.id)
      pending.current = null
    }
  }
  const openFromRow = (link: SharedLink, background: boolean): void => {
    pending.current = { key: link.key, known: new Set(state.tabs.map((t) => t.id)), at: Date.now() }
    window.browserr.openUrl(link.url, background, link.key)
  }
  for (const { links } of rooms) {
    for (const link of links) {
      if (bindings.current.has(link.key)) continue
      const page = pageKey(link.url)
      const tab = state.tabs.find((t) => !t.pinned && !bound.has(t.id) && t.url && pageKey(t.url) === page)
      if (!tab) continue
      bindings.current.set(link.key, tab.id)
      bound.add(tab.id)
    }
  }
  const tabOf = (link: SharedLink): TabState | undefined => {
    const id = bindings.current.get(link.key)
    return id === undefined ? undefined : state.tabs.find((t) => t.id === id)
  }

  const pinned = state.tabs.filter((t) => t.pinned)
  const unpinned = state.tabs.filter((t) => !t.pinned && !bound.has(t.id))

  const toggle = (id: string): void => setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id])
  const isCollapsed = (id: string): boolean => collapsed.includes(id)

  // Right-clicking the Tabs section (but not a tab or a group, which have their own menus).
  const tabsMenu = (e: React.MouseEvent): void => {
    if (e.defaultPrevented) return
    e.preventDefault()
    const groups = siteGroups(unpinned)
    const anyOpen = groups.some((g) => !collapsedSites.includes(g))
    void popupMenu([
      {
        label: anyOpen || groups.length === 0 ? 'Collapse all groups' : 'Expand all groups',
        enabled: groups.length > 0,
        run: () =>
          setCollapsedSites(anyOpen ? [...new Set([...collapsedSites, ...groups])] : collapsedSites.filter((g) => !groups.includes(g))),
      },
    ])
  }

  return (
    <aside ref={ref} className="vtabs" style={{ width }}>
      <div className="vtabs-head" style={{ paddingLeft: mac && !state.fullscreen ? 80 : 10 }}>
        {state.profile && <span className="profile-chip">{state.profile}</span>}
        <span className="vtabs-spacer" />
        <LayoutButton layout={layout} />
        <NewTabButton />
      </div>

      <div className="vtabs-body" onDragEnd={drag.end} onScroll={closeGroupPeek}>
        <div className="fav-grid">
          {favorites.map((b) => {
            const tab = tabFor(b.url)
            return (
              <button
                key={b.id}
                className={cx('fav-tile', tab && 'is-open', tab?.id === state.activeTabId && 'active')}
                title={`${b.title}\n${b.url}`}
                onClick={(e) => open(b.url, { background: e.metaKey || e.ctrlKey })}
                onAuxClick={(e) => e.button === 1 && open(b.url, { background: true })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  window.browserr.bookmarks.contextMenu(b.id)
                }}
              >
                <LinkIcon url={b.url} link={linkFor(b.url)} />
              </button>
            )
          })}
          {pinned.map((tab) => (
            <TabItem key={tab.id} tab={tab} index={state.tabs.indexOf(tab)} active={tab.id === state.activeTabId} {...drag.itemProps(tab)} />
          ))}
          {favorites.length === 0 && pinned.length === 0 && <p className="vtabs-hint">Star a tab or a link and it stays up here.</p>}
        </div>

        {rooms.length > 0 && user && (
          <section className="vtabs-section">
            <h4>From chats</h4>
            {rooms.map(({ room, links, archived }) => {
              const fresh = links.filter((l) => !l.opened).length
              const closed = isCollapsed(room.id)
              const limit = showAll.includes(room.id) ? ROOM_EXPANDED : ROOM_PREVIEW
              return (
                <div key={room.id} className={cx('vroom', closed && 'collapsed')}>
                  <div className="vroom-head">
                    <button className="vroom-toggle" onClick={() => toggle(room.id)}>
                      <ChevronRight size={12} className="vroom-chevron" />
                      <RoomAvatar room={room} me={user.uid} people={people} size={18} />
                      <span className="vroom-name">{roomTitle(room, user.uid, people)}</span>
                      {fresh > 0 && <span className="count">{fresh}</span>}
                    </button>
                    <button className="icon-btn small" title="Open chat" onClick={() => onOpenRoom(room.id)}>
                      <MessagesSquare size={13} />
                    </button>
                  </div>
                  {/* Rows with an open tab always show, even when the chat is collapsed. */}
                  {links
                    .filter((link, i) => (!closed && i < limit) || tabOf(link))
                    .map((link) => {
                      const tab = tabOf(link)
                      return (
                        <LinkRow
                          key={link.key}
                          link={link}
                          tab={tab}
                          active={!!tab && tab.id === state.activeTabId}
                          onOpen={(background) => openFromRow(link, background)}
                          onArchive={() => {
                            if (tab) window.browserr.tabs.close(tab.id)
                            archive(link)
                          }}
                        />
                      )
                    })}
                  {!closed && (
                    <>
                      {links.length > ROOM_PREVIEW && (
                        <button
                          className="vtabs-more"
                          onClick={() => setShowAll(showAll.includes(room.id) ? showAll.filter((r) => r !== room.id) : [...showAll, room.id])}
                        >
                          {showAll.includes(room.id) ? 'Show less' : `Show ${Math.min(links.length, ROOM_EXPANDED) - ROOM_PREVIEW} more`}
                        </button>
                      )}
                      {archived.length > 0 && (
                        <button
                          className="vtabs-more"
                          onClick={() =>
                            setShowArchived(showArchived.includes(room.id) ? showArchived.filter((r) => r !== room.id) : [...showArchived, room.id])
                          }
                        >
                          <Archive size={11} /> {archived.length} archived
                        </button>
                      )}
                      {showArchived.includes(room.id) &&
                        archived.slice(0, ROOM_EXPANDED).map((link) => (
                          <div
                            key={link.key}
                            role="button"
                            className="vlink archived"
                            title={`${linkTooltip(link, caption(link))}\nArchived`}
                            onClick={(e) => open(link.url, { background: e.metaKey || e.ctrlKey, link })}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              linkMenu(link.url, link.title, { link, onRestore: () => unarchive(link) })
                            }}
                          >
                            <LinkIcon url={link.url} link={link} />
                            <span className="vlink-title">{link.title}</span>
                            <button
                              className="tab-close vlink-restore"
                              title="Put back in the group"
                              onClick={(e) => {
                                e.stopPropagation()
                                unarchive(link)
                              }}
                            >
                              <RotateCcw size={12} />
                            </button>
                          </div>
                        ))}
                    </>
                  )}
                </div>
              )
            })}
          </section>
        )}

        <section className="vtabs-section" onContextMenu={tabsMenu}>
          <h4>
            Tabs <span className="vtabs-count">{unpinned.length}</span>
          </h4>
          <div className="vtab-list" role="tablist">
            <SiteGroupedTabs
              state={state}
              tabs={unpinned}
              drag={drag}
              collapsed={collapsedSites}
              setCollapsed={setCollapsedSites}
              vertical
              renderTab={(tab, color) => (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  index={state.tabs.indexOf(tab)}
                  active={tab.id === state.activeTabId}
                  showSender
                  color={color}
                  {...drag.itemProps(tab)}
                />
              )}
            />
          </div>
          <button className="vtabs-newtab" onClick={() => window.browserr.tabs.create()}>
            + New tab
          </button>
        </section>
      </div>
      <Resizer width={width} onResize={setWidth} />
    </aside>
  )
})

/** Drag the column's edge to resize it. Double-click puts it back to the default width. */
function Resizer({ width, onResize }: { width: number; onResize: (width: number) => void }): ReactNode {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={cx('vtabs-resizer', dragging && 'dragging')}
      title="Drag to resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const handle = e.currentTarget
        const startX = e.clientX
        const move = (ev: PointerEvent): void => {
          onResize(Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width + ev.clientX - startX))))
        }
        const end = (): void => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('lostpointercapture', end)
          document.documentElement.classList.remove('resizing-vtabs')
          setDragging(false)
        }
        handle.setPointerCapture(e.pointerId)
        handle.addEventListener('pointermove', move)
        handle.addEventListener('lostpointercapture', end)
        document.documentElement.classList.add('resizing-vtabs')
        setDragging(true)
        closeGroupPeek()
      }}
      onDoubleClick={() => onResize(WIDTH_DEFAULT)}
    />
  )
}

/** A link from a chat. Once opened, the row is the tab: click to switch to it. × closes it and archives the link. */
interface LinkRowProps {
  link: SharedLink
  tab?: TabState
  active: boolean
  onOpen: (background: boolean) => void
  onArchive: () => void
}

function LinkRow({ link, tab, active, onOpen, onArchive }: LinkRowProps): ReactNode {
  const { tabs } = window.browserr
  const caption = useLinkCaption()
  const linkMenu = useLinkMenu()
  // Browsing on inside the tab shows where you are now.
  const samePage = !tab || !tab.url || pageKey(tab.url) === pageKey(link.url)
  const title = samePage ? link.title : tab.title
  const url = tab?.url || link.url

  const openHere = (background: boolean): void => {
    if (tab) tabs.activate(tab.id)
    else onOpen(background)
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      className={cx('vlink', active && 'active', tab && 'is-open', tab?.sleeping && 'sleeping', !link.opened && 'fresh')}
      title={tab ? `${title}\n${url}\n${caption(link)}` : linkTooltip(link, caption(link))}
      onMouseDown={(e) => {
        if (e.button === 0) openHere(e.metaKey || e.ctrlKey)
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        if (tab) tabs.close(tab.id)
        else openHere(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (tab) tabs.contextMenu(tab.id)
        else linkMenu(link.url, link.title, { link, onArchive })
      }}
    >
      <LinkIcon url={url} link={link} favicon={tab ? <TabIcon tab={tab} /> : undefined} />
      <span className="vlink-title">{title}</span>
      {tab && (tab.audible || tab.muted) && (
        <button
          className="tab-audio"
          title={tab.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => tabs.toggleMute(tab.id)}
        >
          {tab.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      <span className="vlink-time">{timeAgo(link.createdAt)}</span>
      <StarButton url={url} title={title} className="vlink-star" />
      <button
        className="tab-close vlink-close"
        title={tab ? 'Close and archive' : 'Archive'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onArchive}
      >
        <X size={13} strokeWidth={2.25} />
      </button>
    </div>
  )
}
