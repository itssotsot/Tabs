import { ChevronRight, Star } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { colorFor } from '@shared/colors'
import type { TabLayout, TabState, WindowState } from '@shared/types'
import { roomTitle, useSocial } from '../../social/SocialProvider'
import { RoomAvatar } from '../../ui/Avatar'
import { cx } from '../../ui/util'
import { pageKey, useLinks, type SharedLink } from './links'
import { LinkTab, linkTooltip, NewTabButton, StripFrame, TabItem, useLinkCaption, useLinkMenu, useStoredState, useTabDrag } from './parts'
import { SiteGroupedTabs, useCollapsedSites } from './SiteGroups'

/** Links per group; the rest are one click away in the chat. */
const GROUP_ITEMS = 4
const MAX_GROUPS = 5
const FAVORITES = 'favorites'
const FAVORITES_COLOR = '#eab308'

interface GroupItem {
  url: string
  title: string
  /** Whose face to show on the icon. */
  sender?: SharedLink
  link?: SharedLink
  bookmarkId?: string
  /** The open tab showing this page, which then lives in the group. */
  tab?: TabState
}

interface Group {
  id: string
  name: string
  color: string
  icon: ReactNode
  items: GroupItem[]
  /** Links beyond GROUP_ITEMS. */
  more: number
  fresh: number
}

/** Layout 3: every chat is a collapsible tab group of the links sent in it, next to a Favorites group. Other tabs are grouped by site. */
export function GroupsStrip({ state, layout, onOpenRoom }: { state: WindowState; layout: TabLayout; onOpenRoom: (roomId: string) => void }): ReactNode {
  const { user, people } = useSocial()
  const { rooms, favorites, linkFor, open, archive } = useLinks()
  const caption = useLinkCaption()
  const linkMenu = useLinkMenu()
  const drag = useTabDrag()
  const [expanded, setExpanded] = useStoredState<string[]>('browserr.tabs.expandedGroups', [])
  const [collapsedSites, setCollapsedSites] = useCollapsedSites()

  const groups: Group[] = []
  if (favorites.length) {
    groups.push({
      id: FAVORITES,
      name: 'Favorites',
      color: FAVORITES_COLOR,
      icon: <Star size={12} fill="currentColor" />,
      items: favorites.slice(0, GROUP_ITEMS).map((b) => ({ url: b.url, title: b.title, sender: linkFor(b.url), bookmarkId: b.id })),
      more: 0,
      fresh: 0
    })
  }
  // A chat whose links are all archived has no group.
  for (const { room, links } of rooms.filter((r) => r.links.length).slice(0, MAX_GROUPS)) {
    if (!user) break
    groups.push({
      id: room.id,
      name: roomTitle(room, user.uid, people),
      color: colorFor(room.id),
      icon: <RoomAvatar room={room} me={user.uid} people={people} size={16} />,
      items: links.slice(0, GROUP_ITEMS).map((l) => ({ url: l.url, title: l.title, sender: l, link: l })),
      more: Math.max(0, links.length - GROUP_ITEMS),
      fresh: links.filter((l) => !l.opened).length
    })
  }

  // Tabs showing a group's page move into that group (favorites first).
  const claimed = new Set<number>()
  for (const group of groups) {
    for (const item of group.items) {
      const page = pageKey(item.url)
      item.tab = state.tabs.find((t) => !t.pinned && !claimed.has(t.id) && t.url && pageKey(t.url) === page)
      if (item.tab) claimed.add(item.tab.id)
    }
  }

  const indexOf = (tab: TabState): number => state.tabs.indexOf(tab)
  // × on a chat's tab closes it and archives the link, so it leaves the group.
  const renderTab = (tab: TabState, color?: string, link?: SharedLink): ReactNode => (
    <TabItem
      key={tab.id}
      tab={tab}
      index={indexOf(tab)}
      active={tab.id === state.activeTabId}
      color={color}
      showSender
      onClose={
        link
          ? () => {
              window.browserr.tabs.close(tab.id)
              archive(link)
            }
          : undefined
      }
      closeTitle={link ? 'Close and archive' : undefined}
      {...drag.itemProps(tab)}
    />
  )

  const toggle = (id: string): void => setExpanded(expanded.includes(id) ? expanded.filter((g) => g !== id) : [...expanded, id])

  return (
    <StripFrame state={state} layout={layout}>
      <div className="tabs" role="tablist" onDragEnd={drag.end}>
        {state.tabs.filter((t) => t.pinned).map((t) => renderTab(t))}
        {groups.map((group) => {
          const isOpen = expanded.includes(group.id)
          const active = group.items.find((i) => i.tab?.id === state.activeTabId)?.tab
          return (
            <div key={group.id} className={cx('tab-group', isOpen && 'open')} style={{ '--group': group.color } as CSSProperties}>
              <button
                className="group-chip"
                title={`${group.name} · ${group.items.length + group.more} ${group.id === FAVORITES ? 'favorites' : 'links'}\nClick to ${isOpen ? 'collapse' : 'expand'}`}
                onClick={() => toggle(group.id)}
                onContextMenu={(e) => {
                  if (group.id === FAVORITES) return
                  e.preventDefault()
                  onOpenRoom(group.id)
                }}
              >
                {group.icon}
                <span className="group-name">{group.name}</span>
                {group.fresh > 0 && <span className="count">{group.fresh}</span>}
                <ChevronRight size={12} className="group-chevron" />
              </button>
              {isOpen
                ? group.items.map((item) =>
                    item.tab ? (
                      renderTab(item.tab, group.color, item.link)
                    ) : (
                      <LinkTab
                        key={item.link?.key ?? item.bookmarkId ?? item.url}
                        url={item.url}
                        title={item.title}
                        sender={item.sender}
                        sentAt={item.link?.createdAt}
                        color={group.color}
                        tooltip={item.link ? linkTooltip(item.link, caption(item.link)) : `${item.title}\n${item.url}`}
                        onOpen={(background) => open(item.url, { background, link: item.link })}
                        onDismiss={item.link ? () => archive(item.link!) : undefined}
                        dismissTitle="Archive"
                        onContextMenu={
                          item.bookmarkId
                            ? () => window.browserr.bookmarks.contextMenu(item.bookmarkId!)
                            : () => linkMenu(item.url, item.title, { link: item.link, onArchive: item.link && (() => archive(item.link!)) })
                        }
                      />
                    )
                  )
                : active && renderTab(active, group.color, group.items.find((i) => i.tab === active)?.link)}
              {isOpen && group.more > 0 && (
                <button className="more-chip" title="See every link in the chat" onClick={() => onOpenRoom(group.id)}>
                  +{group.more}
                </button>
              )}
            </div>
          )
        })}
        {/* Tabs no chat claimed are grouped by site. */}
        <SiteGroupedTabs
          state={state}
          tabs={state.tabs.filter((t) => !t.pinned && !claimed.has(t.id))}
          drag={drag}
          collapsed={collapsedSites}
          setCollapsed={setCollapsedSites}
          renderTab={renderTab}
        />
        <NewTabButton />
      </div>
    </StripFrame>
  )
}
