import { Globe, PanelsTopLeft, Plus, Star, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { TAB_LAYOUTS } from '@shared/constants'
import type { TabLayout, TabState, WindowState } from '@shared/types'
import { hostOf } from '@shared/url'
import { displayName, roomTitle, useSocial } from '../../social/SocialProvider'
import { Avatar } from '../../ui/Avatar'
import { copyText, MENU_SEPARATOR, popupMenu } from '../../ui/menu'
import { cx, shortcut, siteIcon, timeAgo, useFailingIcon } from '../../ui/util'
import { tabDragStarted } from '../split-drag'
import { useLinks, type SharedLink } from './links'
import { CallButtons, CallPeople, CaptureSigns, hasMediaBar, MediaButton, MediaProgress, MuteButton } from './media'

/** What you can do with the tab's sound, call and player, between its icon and its name. */
export function TabControls({ tab }: { tab: TabState }): ReactNode {
  return (
    <span className="tab-controls">
      <MediaButton tab={tab} />
      <MuteButton tab={tab} animated />
      <CaptureSigns tab={tab} />
      <CallButtons tab={tab} />
      <CallPeople tab={tab} />
    </span>
  )
}

export function TabIcon({ tab }: { tab: TabState }): ReactNode {
  const [failing, onError] = useFailingIcon(tab.favicon)
  if (tab.loading) return <span className="spinner" />
  if (tab.favicon && !failing) {
    return <img className="favicon" src={tab.favicon} alt="" draggable={false} onError={onError} />
  }
  return <Globe className="favicon" size={15} strokeWidth={1.75} />
}

/** Space between the end of a scrolling title and its start coming round again. */
const MARQUEE_GAP = 32
/** How fast a title scrolls, in pixels a second. */
const MARQUEE_SPEED = 40

/**
 * A title that, when too long to fit, scrolls along while its tab is hovered. A second copy follows it,
 * so it loops round to the start instead of scrolling back.
 */
export function MarqueeText({ text, className }: { text: string; className: string }): ReactNode {
  const box = useRef<HTMLSpanElement>(null)
  const first = useRef<HTMLSpanElement>(null)
  /** How far one loop moves the text; 0 when it fits. */
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    const textEl = first.current
    if (!el || !textEl) return
    const measure = (): void => {
      const width = textEl.getBoundingClientRect().width
      setShift(width > el.clientWidth + 1 ? Math.round(width + MARQUEE_GAP) : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  const style = shift ? ({ '--marquee-shift': `${-shift}px`, '--marquee-time': `${shift / MARQUEE_SPEED}s` } as CSSProperties) : undefined
  return (
    <span ref={box} className={cx(className, 'marquee-box')}>
      <span className={cx('marquee', shift > 0 && 'moving')} style={style}>
        <span ref={first}>{text}</span>
        {shift > 0 && (
          <span style={{ paddingLeft: MARQUEE_GAP }} aria-hidden>
            {text}
          </span>
        )}
      </span>
    </span>
  )
}

/** A site icon with the face of whoever sent the link in the corner, for links from two-person chats. */
export function LinkIcon({ url, link, favicon }: { url: string; link?: SharedLink; favicon?: ReactNode }): ReactNode {
  const { people } = useSocial()
  const src = siteIcon(url)
  const [failing, onError] = useFailingIcon(favicon ? null : src)
  return (
    <span className="link-icon">
      {favicon ??
        (failing || !src ? (
          <Globe className="favicon" size={15} strokeWidth={1.75} />
        ) : (
          <img className="favicon" src={src} alt="" draggable={false} onError={onError} />
        ))}
      {link && link.oneOnOne && !link.mine && (
        <span className="link-icon-face">
          <Avatar profile={people[link.from]} size={12} />
        </span>
      )}
    </span>
  )
}

/** useState that survives restarts (per window UI, saved in localStorage). */
export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])
  return [value, setValue]
}

/** Right-click menu for a link from a chat (or a favorite) that isn't open as a tab. */
export function useLinkMenu(): (url: string, title: string, options?: { link?: SharedLink; onArchive?: () => void; onRestore?: () => void }) => void {
  const { open, isFavorite, toggleFavorite } = useLinks()
  return (url, title, { link, onArchive, onRestore } = {}) =>
    void popupMenu([
      { label: 'Open', run: () => open(url, { link }) },
      { label: 'Open in a new tab', run: () => open(url, { background: true, link }) },
      MENU_SEPARATOR,
      { label: 'Send to a Friend…', run: () => window.browserr.share.openPickerForLink(url, title) },
      { label: 'Copy link address', run: () => copyText(url) },
      { label: 'Copy Title', run: () => copyText(title) },
      MENU_SEPARATOR,
      { label: isFavorite(url) ? 'Remove from Favorites' : 'Add to Favorites', run: () => toggleFavorite(url, title) },
      ...(onArchive ? [{ label: 'Archive', run: onArchive }] : []),
      ...(onRestore ? [{ label: 'Put Back in the Group', run: onRestore }] : [])
    ])
}

/** "@alex in Book club · 2h" */
export function useLinkCaption(): (link: SharedLink) => string {
  const { user, rooms, people } = useSocial()
  return (link) => {
    const room = rooms.find((r) => r.id === link.roomId)
    const who = link.mine ? 'You' : displayName(people[link.from])
    const where = room && room.kind === 'group' && user ? ` in ${roomTitle(room, user.uid, people)}` : ''
    return `${who}${where} · ${timeAgo(link.createdAt)}`
  }
}

export function linkTooltip(link: SharedLink, caption: string): string {
  return `${link.title}\n${hostOf(link.url)}\n${caption}`
}

export function StarButton({ url, title, className }: { url: string; title: string; className?: string }): ReactNode {
  const { isFavorite, toggleFavorite } = useLinks()
  const on = isFavorite(url)
  return (
    <button
      className={cx('star-btn', on && 'on', className)}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        toggleFavorite(url, title)
      }}
    >
      <Star size={13} fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}

// One clock for every tab's age, ticking each minute.
const MINUTE_MS = 60_000
const minuteListeners = new Set<() => void>()
let minuteNow = Date.now()
let minuteTimer: number | undefined

function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener)
  if (minuteTimer === undefined) minuteNow = Date.now()
  minuteTimer ??= window.setInterval(() => {
    minuteNow = Date.now()
    minuteListeners.forEach((l) => l())
  }, MINUTE_MS)
  return () => {
    minuteListeners.delete(listener)
    if (!minuteListeners.size) {
      window.clearInterval(minuteTimer)
      minuteTimer = undefined
    }
  }
}

/** The time, updated once a minute. */
function useMinute(): number {
  return useSyncExternalStore(subscribeMinute, () => minuteNow)
}

/** How long ago a tab was opened (or a link sent), short enough for the strip: now, 5m, 2h, 3d. */
function tabAge(since: number, now: number): string {
  const min = Math.floor(Math.max(0, now - since) / MINUTE_MS)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

interface TabItemProps {
  tab: TabState
  /** The tab's position in the window, for drag and drop. */
  index: number
  active: boolean
  dragging: boolean
  onDragStart: () => void
  onDrop: (index: number) => void
  /** Show who sent the page, when it came from a chat. */
  showSender?: boolean
  /** Group color, for tabs in a chat's or a site's group. */
  color?: string
  className?: string
  /** What × does, when it's more than closing the tab. */
  onClose?: () => void
  closeTitle?: string
}

export function TabItem({ tab, index, active, dragging, onDragStart, onDrop, showSender, color, className, onClose, closeTitle }: TabItemProps): ReactNode {
  const { tabs } = window.browserr
  const { linkForTab } = useLinks()
  const now = useMinute()
  const chatLink = linkForTab(tab)
  const link = showSender ? chatLink : undefined
  const since = tab.createdAt
  // When a chat's link was sent is in the tooltip; the age is always this tab's own.
  const sent = chatLink?.createdAt ? `\n${chatLink.mine ? 'Sent' : 'Received'} ${formatWhen(chatLink.createdAt.getTime())}` : ''
  const opened = `Opened ${formatWhen(since)}${sent}`
  const style = color ? ({ '--group': color } as CSSProperties) : undefined
  // It switches on click, not on press, so a tab dragged onto the page (for a split view) leaves the page you're on
  // showing. The buttons in it stop the press, so clicking them doesn't switch.
  const pressed = useRef(false)
  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.url ? `${tab.title}\n${tab.url}\n${opened}${tab.sleeping ? '\nSleeping to save memory' : ''}` : `${tab.title}\n${opened}`}
      className={cx(
        'tab',
        active && 'active',
        tab.onScreen && !active && 'on-screen',
        tab.split && 'in-split',
        tab.pinned && 'pinned',
        dragging && 'dragging',
        tab.sleeping && 'sleeping',
        color && 'grouped',
        hasMediaBar(tab) && 'has-media',
        className
      )}
      style={style}
      data-tab-id={tab.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        pressed.current = false
        onDragStart()
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(index)
      }}
      onMouseDown={(e) => {
        pressed.current = e.button === 0
      }}
      onClick={() => {
        if (pressed.current) tabs.activate(tab.id)
        pressed.current = false
      }}
      onAuxClick={(e) => {
        if (e.button === 1) tabs.close(tab.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        tabs.contextMenu(tab.id)
      }}
    >
      {link ? <LinkIcon url={tab.url} link={link} favicon={<TabIcon tab={tab} />} /> : <TabIcon tab={tab} />}
      {/* A pinned tab is just its icon, plus mute while it plays and the mic in a call. */}
      {tab.pinned ? (
        <>
          <MuteButton tab={tab} />
          <CallButtons tab={tab} micOnly />
        </>
      ) : (
        <TabControls tab={tab} />
      )}
      {!tab.pinned && <MarqueeText className="tab-title" text={tab.title} />}
      {!tab.pinned && <span className="tab-age">{tabAge(since, now)}</span>}
      {!tab.pinned && (
        <span className="tab-actions">
          <button
            className="tab-close"
            title={closeTitle ?? `Close tab (${shortcut('⌘W', 'Ctrl+W')})`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => (onClose ? onClose() : tabs.close(tab.id))}
          >
            <X size={13} strokeWidth={2.25} />
          </button>
        </span>
      )}
      <MediaProgress tab={tab} />
    </div>
  )
}

export interface TabDrag {
  dragId: number | null
  /** The site group being dragged by its chip. */
  dragGroup: string | null
  itemProps: (tab: TabState) => Pick<TabItemProps, 'dragging' | 'onDragStart' | 'onDrop'>
  /** Drag a whole site group by its chip. */
  startGroup: (group: string) => void
  /** Something dropped at `to` (a tab's position in the window). */
  drop: (to: number) => void
  end: () => void
}

/** Drag-and-drop state shared by a list of TabItems (and site group chips). */
export function useTabDrag(): TabDrag {
  const [dragId, setDragId] = useState<number | null>(null)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const end = (): void => {
    setDragId(null)
    setDragGroup(null)
  }
  const drop = (to: number): void => {
    if (dragId !== null) window.browserr.tabs.move(dragId, to)
    else if (dragGroup !== null) window.browserr.tabs.moveGroup(dragGroup, to)
    end()
  }
  return {
    dragId,
    dragGroup,
    end,
    drop,
    startGroup: (group) => {
      setDragId(null)
      setDragGroup(group)
    },
    itemProps: (tab) => ({
      dragging: tab.id === dragId,
      onDragStart: () => {
        setDragGroup(null)
        setDragId(tab.id)
        tabDragStarted(tab.id)
      },
      onDrop: drop
    })
  }
}

interface LinkTabProps {
  url: string
  title: string
  /** Whose face to show on the icon. */
  sender?: SharedLink
  tooltip: string
  onOpen: (background: boolean) => void
  /** Shows an × that calls this. */
  onDismiss?: () => void
  dismissTitle?: string
  /** When the link was sent, for links from a chat. Shown like a tab's age. */
  sentAt?: Date | null
  color?: string
  className?: string
  onContextMenu?: () => void
}

/** A page that isn't open yet, drawn like a sleeping tab. Clicking it opens it. */
export function LinkTab({ url, title, sender, tooltip, onOpen, onDismiss, dismissTitle, sentAt, color, className, onContextMenu }: LinkTabProps): ReactNode {
  const linkMenu = useLinkMenu()
  const now = useMinute()
  const style = color ? ({ '--group': color } as CSSProperties) : undefined
  return (
    <div
      role="tab"
      aria-selected={false}
      title={tooltip}
      className={cx('tab', 'link-tab', color && 'grouped', className)}
      style={style}
      onMouseDown={(e) => {
        if (e.button === 0) onOpen(e.metaKey || e.ctrlKey)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) onOpen(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (onContextMenu) onContextMenu()
        else linkMenu(url, title)
      }}
    >
      <LinkIcon url={url} link={sender} />
      <MarqueeText className="tab-title" text={title} />
      {/* Pending messages have no server time yet; they're brand new. */}
      {sentAt !== undefined && <span className="tab-age">{tabAge(sentAt?.getTime() ?? now, now)}</span>}
      <StarButton url={url} title={title} className="tab-star" />
      {onDismiss && (
        <button
          className="tab-close"
          title={dismissTitle ?? 'Dismiss'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
        >
          <X size={13} strokeWidth={2.25} />
        </button>
      )}
    </div>
  )
}

export function NewTabButton(): ReactNode {
  return (
    <button className="icon-btn newtab-btn" title={`New tab (${shortcut('⌘T', 'Ctrl+T')})`} onClick={() => window.browserr.tabs.create()}>
      <Plus size={16} />
    </button>
  )
}

/** There are two layouts, so the button flips to the other one. */
export function LayoutButton({ layout }: { layout: TabLayout }): ReactNode {
  const next = TAB_LAYOUTS.find((l) => l.id !== layout) ?? TAB_LAYOUTS[0]
  return (
    <button className="icon-btn small layout-btn" title={`Switch to ${next.name.toLowerCase()}`} onClick={() => void window.browserr.settings.set({ tabLayout: next.id })}>
      <PanelsTopLeft size={15} />
    </button>
  )
}

/** The draggable top row: room for the window controls, the tabs, and the layout button. */
export function StripFrame({ state, layout, children }: { state: WindowState; layout: TabLayout; children: ReactNode }): ReactNode {
  const { platform } = window.browserr
  const leftPad = platform === 'darwin' && !state.fullscreen ? 80 : 8
  const rightPad = platform === 'darwin' ? 8 : 146
  return (
    <div className="tabstrip" style={{ paddingLeft: leftPad, paddingRight: rightPad }}>
      {children}
      <LayoutButton layout={layout} />
      {state.profile && (
        <span className="profile-chip" title={`Profile: ${state.profile}`}>
          {state.profile}
        </span>
      )}
    </div>
  )
}
