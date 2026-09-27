import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Bookmark, TabState } from '@shared/types'
import { findLinks, pageKey, prettyUrl } from '@shared/url'
import { parseYouTube, youTubeThumbnail } from '@shared/youtube'
import { setArchivedLinks, watchArchivedLinks, watchMessages, type ArchivedLinks, type Message, type Room } from '../../social/api'
import { useSocial } from '../../social/SocialProvider'

export { pageKey }

/** A link someone (maybe you) sent in one of your chats. A message can hold several. */
export interface SharedLink {
  /** `${roomId}/${messageId}` for the message's link card, `${roomId}/${messageId}#n` for links in its text. */
  key: string
  roomId: string
  messageId: string
  url: string
  title: string
  thumbnail: string | null
  timestampSec: number | null
  from: string
  mine: boolean
  /** Sent in a chat with just you and one other person, so the sender says which chat it's from. */
  oneOnOne: boolean
  createdAt: Date | null
  /** Opened from any list, or a tab showed the page at some point. */
  opened: boolean
  /** Closed with × in a chat's tab group; it no longer shows there. */
  archived: boolean
}

export interface RoomLinks {
  room: Room
  /** Links still in the group, newest first, one per page. */
  links: SharedLink[]
  /** Archived pages, newest first, one per page. */
  archived: SharedLink[]
}

interface LinksState {
  /** Every link in every chat, newest first. */
  links: SharedLink[]
  /** Chats where someone sent you links, most recent link first. Links you sent aren't in these. */
  rooms: RoomLinks[]
  favorites: Bookmark[]
  isFavorite(url: string): boolean
  toggleFavorite(url: string, title: string): void
  /** The most recent link for the page a URL shows. */
  linkFor(url: string): SharedLink | undefined
  /** The link a tab was opened from, while it still shows that page. Not set for tabs you opened yourself. */
  linkForTab(tab: TabState): SharedLink | undefined
  /** The open tab showing this page, if any. */
  tabFor(url: string): TabState | undefined
  /** Switches to the page if it's open in a tab, otherwise opens it. */
  open(url: string, options?: { background?: boolean; link?: SharedLink }): void
  /** Takes the page out of its chat's group: every message in that chat that shared it. */
  archive(link: SharedLink): void
  /** Puts the page back in its chat's group. */
  unarchive(link: SharedLink): void
  /** How many of a message's links are archived, for showing it in the chat. */
  messageArchive(roomId: string, messageId: string): { total: number; archived: number }
  /** Restores every archived link of a message. */
  unarchiveMessage(roomId: string, messageId: string): void
}

const LinksContext = createContext<LinksState | null>(null)

export function useLinks(): LinksState {
  const ctx = useContext(LinksContext)
  if (!ctx) throw new Error('useLinks must be used inside <LinksProvider>')
  return ctx
}

type LinkParts = Pick<SharedLink, 'key' | 'url' | 'title' | 'thumbnail' | 'timestampSec'>

/** The link card first, then any other pages mentioned in the text, each page once. */
export function linksInMessage(roomId: string, m: Message): LinkParts[] {
  const out: LinkParts[] = []
  const pages = new Set<string>()
  if (m.url) {
    out.push({ key: `${roomId}/${m.id}`, url: m.url, title: m.title || m.url, thumbnail: m.thumbnail, timestampSec: m.timestampSec })
    pages.add(pageKey(m.url))
  }
  findLinks(m.text ?? '').forEach((url, i) => {
    const page = pageKey(url)
    if (pages.has(page)) return
    pages.add(page)
    const yt = parseYouTube(url)
    out.push({ key: `${roomId}/${m.id}#${i + 1}`, url, title: prettyUrl(url), thumbnail: yt ? youTubeThumbnail(yt) : null, timestampSec: null })
  })
  return out
}

const STATE_LIMIT = 1000

interface LocalState {
  opened: string[]
  /** Link keys archived on this device; kept even if saving to your account fails. */
  archived: string[]
}

const EMPTY_LOCAL: LocalState = { opened: [], archived: [] }

function storageKey(uid: string): string {
  return `browserr.links.${uid}`
}

function readLocal(uid: string): LocalState {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(uid)) ?? '{}') as Partial<LocalState>
    return { opened: parsed.opened ?? [], archived: parsed.archived ?? [] }
  } catch {
    return EMPTY_LOCAL
  }
}

/** Remembers which links were opened or archived; windows share it through localStorage. */
function useLocalLinkState(uid: string | undefined): [LocalState, (patch: (s: LocalState) => LocalState) => void] {
  const [state, setState] = useState<LocalState>(EMPTY_LOCAL)

  useEffect(() => {
    if (!uid) return
    setState(readLocal(uid))
    const onStorage = (e: StorageEvent): void => {
      if (e.key === storageKey(uid)) setState(readLocal(uid))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [uid])

  const update = (patch: (s: LocalState) => LocalState): void => {
    if (!uid) return
    const next = patch(readLocal(uid))
    const trimmed = {
      opened: next.opened.slice(-STATE_LIMIT),
      archived: next.archived.slice(-STATE_LIMIT)
    }
    localStorage.setItem(storageKey(uid), JSON.stringify(trimmed))
    setState(trimmed)
  }
  return [state, update]
}

interface Props {
  tabs: TabState[]
  bookmarks: Bookmark[]
  children: ReactNode
}

export function LinksProvider({ tabs, bookmarks, children }: Props): ReactNode {
  const { user, rooms } = useSocial()
  const uid = user?.uid
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [remoteArchive, setRemoteArchive] = useState<ArchivedLinks[]>([])
  const [local, updateLocal] = useLocalLinkState(uid)

  // One listener per chat; RoomView's listener for the open chat shares it.
  const roomIds = rooms.map((r) => r.id).join(',')
  useEffect(() => {
    if (!uid) {
      setMessages({})
      return
    }
    const ids = roomIds ? roomIds.split(',') : []
    setMessages((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.includes(id))))
    const offs = ids.map((id) =>
      watchMessages(id, (list) => setMessages((prev) => ({ ...prev, [id]: list.filter((m) => m.url || findLinks(m.text ?? '').length) })))
    )
    return () => offs.forEach((off) => off())
  }, [uid, roomIds])

  useEffect(() => {
    setRemoteArchive([])
    if (!uid) return
    return watchArchivedLinks(uid, setRemoteArchive, () => setRemoteArchive([]))
  }, [uid])

  // A page that's been open in a tab counts as opened, however you got there.
  const openKeys = useMemo(() => new Set(tabs.filter((t) => t.url).map((t) => pageKey(t.url))), [tabs])

  const value = useMemo<LinksState>(() => {
    const opened = new Set(local.opened)
    const archivedHere = new Set(local.archived)
    const remote = new Map(remoteArchive.map((a) => [`${a.roomId}/${a.messageId}`, new Set(a.urls)]))
    const roomById = new Map(rooms.map((r) => [r.id, r]))

    const links: SharedLink[] = []
    for (const [roomId, list] of Object.entries(messages)) {
      const room = roomById.get(roomId)
      if (!room || !uid) continue
      const oneOnOne = room.members.length === 2
      for (const m of list) {
        const mine = m.from === uid
        const remoteUrls = remote.get(`${roomId}/${m.id}`)
        for (const part of linksInMessage(roomId, m)) {
          links.push({
            ...part,
            roomId,
            messageId: m.id,
            from: m.from,
            mine,
            oneOnOne,
            // Pending writes have no server time yet; they're brand new.
            createdAt: m.createdAt,
            opened: mine || opened.has(part.key) || openKeys.has(pageKey(part.url)),
            archived: archivedHere.has(part.key) || !!remoteUrls?.has(part.url)
          })
        }
      }
    }
    const time = (l: SharedLink): number => l.createdAt?.getTime() ?? Date.now()
    links.sort((a, b) => time(b) - time(a))

    // A page is in a chat's group while any message there that shared it isn't archived.
    const byPage = new Map<string, SharedLink>()
    const byRoom = new Map<string, Map<string, SharedLink[]>>()
    for (const link of links) {
      const page = pageKey(link.url)
      if (!byPage.has(page)) byPage.set(page, link)
      // A chat's group holds what others sent you; your own links stay in the chat.
      if (link.mine) continue
      const pages = byRoom.get(link.roomId) ?? new Map<string, SharedLink[]>()
      pages.set(page, [...(pages.get(page) ?? []), link])
      byRoom.set(link.roomId, pages)
    }
    const roomsWithLinks: RoomLinks[] = [...byRoom.entries()]
      .map(([id, pages]) => {
        const active: SharedLink[] = []
        const archived: SharedLink[] = []
        for (const same of pages.values()) {
          const live = same.find((l) => !l.archived)
          if (live) active.push(live)
          else archived.push(same[0])
        }
        return { room: roomById.get(id)!, links: active, archived }
      })
      .sort((a, b) => time(b.links[0] ?? b.archived[0]) - time(a.links[0] ?? a.archived[0]))

    // Every link in the same chat for the same page (they share one row).
    const samePage = (link: SharedLink): SharedLink[] => byRoom.get(link.roomId)?.get(pageKey(link.url)) ?? [link]

    const setArchived = (targets: SharedLink[], archived: boolean): void => {
      if (!uid || !targets.length) return
      const keys = new Set(targets.map((l) => l.key))
      updateLocal((s) => ({
        ...s,
        archived: archived ? [...new Set([...s.archived, ...keys])] : s.archived.filter((k) => !keys.has(k))
      }))
      // Saved per message, with every archived URL of that message.
      const messageIds = new Map(targets.map((l) => [`${l.roomId}/${l.messageId}`, l]))
      for (const { roomId, messageId } of messageIds.values()) {
        const urls = links
          .filter((l) => l.roomId === roomId && l.messageId === messageId && (keys.has(l.key) ? archived : l.archived))
          .map((l) => l.url)
        setArchivedLinks(uid, roomId, messageId, urls).catch((err: unknown) =>
          console.warn("Couldn't save archived links to your account; they're kept on this device.", err)
        )
      }
    }

    const byKey = new Map(links.map((l) => [l.key, l]))
    const favoriteKeys = new Set(bookmarks.map((b) => pageKey(b.url)))
    const tabFor = (url: string): TabState | undefined => {
      const page = pageKey(url)
      return tabs.find((t) => t.url && pageKey(t.url) === page)
    }

    return {
      links,
      rooms: roomsWithLinks,
      favorites: bookmarks,
      isFavorite: (url) => favoriteKeys.has(pageKey(url)),
      toggleFavorite: (url, title) => {
        const page = pageKey(url)
        const existing = bookmarks.find((b) => pageKey(b.url) === page)
        window.browserr.bookmarks.toggle(existing?.url ?? url, title)
      },
      linkFor: (url) => byPage.get(pageKey(url)),
      linkForTab: (tab) => {
        const link = tab.fromLink && tab.url ? byKey.get(tab.fromLink.key) : undefined
        if (!link || !tab.fromLink) return undefined
        const page = pageKey(tab.url)
        return page === pageKey(link.url) || page === pageKey(tab.fromLink.landedUrl) ? link : undefined
      },
      tabFor,
      open: (url, options = {}) => {
        if (options.link) {
          const key = options.link.key
          updateLocal((s) => ({ ...s, opened: s.opened.includes(key) ? s.opened : [...s.opened, key] }))
        }
        const tab = tabFor(url)
        if (tab && !options.background) window.browserr.tabs.activate(tab.id)
        else if (!tab) window.browserr.openUrl(url, options.background, options.link?.key)
      },
      archive: (link) => setArchived(samePage(link).filter((l) => !l.archived), true),
      unarchive: (link) => setArchived(samePage(link).filter((l) => l.archived), false),
      messageArchive: (roomId, messageId) => {
        const list = links.filter((l) => l.roomId === roomId && l.messageId === messageId)
        return { total: list.length, archived: list.filter((l) => l.archived).length }
      },
      unarchiveMessage: (roomId, messageId) =>
        setArchived(links.filter((l) => l.roomId === roomId && l.messageId === messageId && l.archived), false)
    }
  }, [messages, remoteArchive, rooms, uid, local, openKeys, bookmarks, tabs])

  // Remember pages you had open, so closing the tab doesn't bring the link back as new.
  useEffect(() => {
    const known = new Set(local.opened)
    const seen = value.links.filter((l) => !l.mine && !known.has(l.key) && openKeys.has(pageKey(l.url))).map((l) => l.key)
    if (seen.length) updateLocal((s) => ({ ...s, opened: [...new Set([...s.opened, ...seen])] }))
  }, [value.links, openKeys])

  return <LinksContext.Provider value={value}>{children}</LinksContext.Provider>
}
