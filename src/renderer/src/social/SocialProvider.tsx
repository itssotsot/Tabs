import { onAuthStateChanged, type User } from 'firebase/auth'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { auth } from '../firebase'
import {
  directRoomId,
  ensureDirectRoom,
  getProfile,
  isUnread,
  markRoomRead,
  normalizeEmail,
  watchFriendships,
  watchProfile,
  watchRooms,
  type Friendship,
  type Profile,
  type Room
} from './api'

export interface Friend {
  friendshipId: string
  uid: string
  profile: Profile | null
  requester: string
  status: Friendship['status']
}

interface SocialState {
  authReady: boolean
  user: User | null
  /** undefined while loading, null when the user hasn't picked a username yet. */
  profile: Profile | null | undefined
  friends: Friend[]
  incoming: Friend[]
  outgoing: Friend[]
  /** Rooms we're in (direct chats and groups), most recently active first. */
  rooms: Room[]
  roomsLoaded: boolean
  /** Rooms we've been invited to (by username or by email) but haven't joined. */
  invites: Room[]
  /** Unread rooms plus pending invites. */
  unreadCount: number
  /** Profiles of friends and everyone in our rooms, keyed by uid. */
  people: Record<string, Profile | null>
  /** The room open in this window's sidebar; its messages don't raise notifications. */
  setViewingRoom: (roomId: string | null) => void
}

const SocialContext = createContext<SocialState | null>(null)

export function useSocial(): SocialState {
  const ctx = useContext(SocialContext)
  if (!ctx) throw new Error('useSocial must be used inside <SocialProvider>')
  return ctx
}

export function displayName(p: Profile | null | undefined): string {
  return p ? `@${p.username}` : 'Someone'
}

/** The other person in a direct chat. */
export function directPartner(room: Room, me: string): string | undefined {
  return room.kind === 'direct' ? room.members.find((m) => m !== me) : undefined
}

/** A group room's name, or for a direct chat, the friend's name. */
export function roomTitle(room: Room, me: string, people: Record<string, Profile | null>): string {
  const partner = directPartner(room, me)
  if (!partner) return room.name
  const p = people[partner]
  return p ? p.displayName || `@${p.username}` : '…'
}

const LAST_NOTIFIED_KEY = 'browserr.lastNotifiedAt'

interface Props {
  children: ReactNode
  /** The main browser UI raises notifications and watches invites; the overlay only needs rooms. */
  withNotifications?: boolean
}

export function SocialProvider({ children, withNotifications = false }: Props): ReactNode {
  const [authReady, setAuthReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [friendships, setFriendships] = useState<Friendship[]>([])
  const [friendshipsLoaded, setFriendshipsLoaded] = useState(false)
  const friendshipsRef = useRef(friendships)
  friendshipsRef.current = friendships
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [uidInvites, setUidInvites] = useState<Room[]>([])
  const [emailInvites, setEmailInvites] = useState<Room[]>([])
  const viewingRoom = useRef<string | null>(null)
  const [people, setPeople] = useState<Record<string, Profile | null>>({})
  const peopleRef = useRef(people)
  peopleRef.current = people

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u)
        setAuthReady(true)
        if (!u) {
          setProfile(null)
          setFriendships([])
          setFriendshipsLoaded(false)
          setRooms(null)
          setUidInvites([])
          setEmailInvites([])
        }
      }),
    []
  )

  const uid = user?.uid
  const email = user?.email ? normalizeEmail(user.email) : null

  useEffect(() => {
    if (!uid) return
    setProfile(undefined)
    return watchProfile(uid, setProfile)
  }, [uid])

  const ready = !!uid && !!profile

  // Resolve profiles for anyone we see, once.
  const ensurePeople = (uids: string[]): void => {
    for (const id of new Set(uids)) {
      if (id in peopleRef.current) continue
      peopleRef.current = { ...peopleRef.current, [id]: null }
      getProfile(id).then((p) => setPeople((prev) => ({ ...prev, [id]: p })))
    }
  }

  // Friends and friend-request notifications
  useEffect(() => {
    if (!uid || !ready) return
    let previous: Map<string, Friendship> | null = null
    return watchFriendships(uid, (list) => {
      setFriendships(list)
      setFriendshipsLoaded(true)
      ensurePeople(list.map((f) => (f.members[0] === uid ? f.members[1] : f.members[0])))
      if (withNotifications && previous) {
        for (const f of list) {
          const before = previous.get(f.id)
          const other = f.members[0] === uid ? f.members[1] : f.members[0]
          if (!before && f.status === 'pending' && f.requester !== uid) {
            void getProfile(other).then((p) =>
              window.browserr.notify({
                key: `friend-request:${f.id}`,
                title: 'New friend request',
                body: `${displayName(p)} wants to be friends.`,
                panel: 'friends'
              })
            )
          }
          if (before?.status === 'pending' && f.status === 'accepted' && f.requester === uid) {
            void getProfile(other).then((p) =>
              window.browserr.notify({
                key: `friend-accepted:${f.id}`,
                title: 'Friend request accepted',
                body: `You and ${displayName(p)} are now friends. Say hi in your inbox!`,
                panel: 'inbox'
              })
            )
          }
        }
      }
      previous = new Map(list.map((f) => [f.id, f]))
    })
  }, [uid, ready, withNotifications])

  const isFriendRoom = (roomId: string): boolean =>
    friendshipsRef.current.some((f) => f.status === 'accepted' && directRoomId(f.members[0], f.members[1]) === roomId)

  // Our rooms, and notifications for new messages in them
  useEffect(() => {
    if (!uid || !ready) return
    let previous: Map<string, string | undefined> | null = null
    return watchRooms('members', uid, (list) => {
      list.sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
      setRooms(list)
      ensurePeople(list.flatMap((r) => [...r.members, ...r.invited]))
      if (!withNotifications) return

      const lastNotified = Number(localStorage.getItem(LAST_NOTIFIED_KEY) ?? 0)
      localStorage.setItem(LAST_NOTIFIED_KEY, String(Date.now()))
      const before = previous
      previous = new Map(list.map((r) => [r.id, r.lastMessage?.id]))

      if (!before) {
        // Messages that arrived while the app was closed get one summary notification.
        const missed = list.filter((r) => isUnread(r, uid) && r.lastMessageAt!.getTime() > lastNotified)
        if (missed.length === 1) notifyMessage(missed[0])
        else if (missed.length > 1) {
          window.browserr.notify({
            key: `missed:${missed.map((r) => r.lastMessage!.id).join(',')}`,
            title: `New messages in ${missed.length} chats`,
            body: missed.map((r) => roomTitle(r, uid, peopleRef.current)).join(', '),
            panel: 'inbox'
          })
        }
        return
      }
      for (const room of list) {
        // Rooms we just joined aren't in `before`, so their history doesn't notify.
        if (!before.has(room.id) || before.get(room.id) === room.lastMessage?.id) continue
        if (!isUnread(room, uid)) continue
        if (room.kind === 'direct' && !isFriendRoom(room.id)) continue
        if (viewingRoom.current === room.id && document.hasFocus()) continue
        notifyMessage(room)
      }
    })
  }, [uid, ready, withNotifications])

  // Every friendship gets a direct chat. Accepting a request creates it; this covers the other side
  // of the friendship, friendships from before chats existed, and retries if creating it failed.
  const directRetry = useRef(new Map<string, { failures: number; retryAt: number }>())
  useEffect(() => {
    if (!uid || !ready || !withNotifications || !rooms) return
    const have = new Set(rooms.map((r) => r.id))
    for (const f of friendships) {
      if (f.status !== 'accepted') continue
      const other = f.members[0] === uid ? f.members[1] : f.members[0]
      const id = directRoomId(uid, other)
      const state = directRetry.current.get(id)
      // retryAt is Infinity while an attempt is in flight.
      if (have.has(id) || (state && Date.now() < state.retryAt)) continue
      const failures = state?.failures ?? 0
      directRetry.current.set(id, { failures, retryAt: Infinity })
      ensureDirectRoom(uid, other).then(
        () => directRetry.current.delete(id),
        (err: unknown) => {
          // E.g. the friendship hadn't reached the server yet, or we're offline. Back off, but keep trying.
          const delay = Math.min(60_000, 3000 * 2 ** failures)
          directRetry.current.set(id, { failures: failures + 1, retryAt: Date.now() + delay })
          console.warn(`Couldn't create the chat with ${other}; retrying in ${delay / 1000}s`, err)
          window.setTimeout(() => setFriendships((list) => [...list]), delay)
        }
      )
    }
  }, [uid, ready, withNotifications, friendships, rooms])

  // Invites, by uid and by the email we signed in with
  useEffect(() => {
    if (!uid || !ready || !withNotifications) return
    const offs = [watchRooms('invited', uid, setUidInvites)]
    if (email) offs.push(watchRooms('invitedEmails', email, setEmailInvites))
    return () => offs.forEach((off) => off())
  }, [uid, email, ready, withNotifications])

  const invites = useMemo(() => {
    const byId = new Map<string, Room>()
    for (const r of [...uidInvites, ...emailInvites]) if (!uid || !r.members.includes(uid)) byId.set(r.id, r)
    return [...byId.values()]
  }, [uidInvites, emailInvites, uid])

  useEffect(() => {
    ensurePeople(invites.flatMap((r) => r.members))
  }, [invites])

  const knownInvites = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!withNotifications || !ready) return
    const known = knownInvites.current
    knownInvites.current = new Set(invites.map((r) => r.id))
    // The first result is whatever was already pending; the badge covers those.
    if (!known) return
    for (const room of invites) {
      if (known.has(room.id)) continue
      void Promise.all(room.members.slice(0, 3).map(getProfile)).then((members) =>
        window.browserr.notify({
          key: `invite:${room.id}`,
          title: `You're invited to “${room.name}”`,
          body: `${members.map(displayName).join(', ')}${room.members.length > 3 ? ' and others' : ''} invited you to chat.`,
          panel: 'inbox'
        })
      )
    }
  }, [invites, withNotifications, ready])

  // Clicking a link notification opens the link; the room counts as read.
  useEffect(() => {
    if (!withNotifications || !uid) return
    return window.browserr.onCommand((cmd) => {
      if (cmd.type === 'room-read') void markRoomRead(cmd.roomId, uid).catch(() => {})
    })
  }, [withNotifications, uid])

  // A direct chat only shows while you're friends; it comes back (with its history) if you become friends again.
  const visibleRooms = useMemo(() => {
    if (!rooms || !uid) return null
    const accepted = new Set(
      friendships.filter((f) => f.status === 'accepted').map((f) => directRoomId(f.members[0], f.members[1]))
    )
    return rooms.filter((r) => r.kind !== 'direct' || (friendshipsLoaded && accepted.has(r.id)))
  }, [rooms, friendships, friendshipsLoaded, uid])

  const unreadCount = (uid && visibleRooms ? visibleRooms.filter((r) => isUnread(r, uid)).length : 0) + invites.length
  useEffect(() => {
    if (withNotifications) window.browserr.setBadge(unreadCount)
  }, [unreadCount, withNotifications])

  const value = useMemo<SocialState>(() => {
    const toFriend = (f: Friendship): Friend => {
      const other = f.members[0] === uid ? f.members[1] : f.members[0]
      return { friendshipId: f.id, uid: other, profile: people[other] ?? null, requester: f.requester, status: f.status }
    }
    const all = friendships.map(toFriend)
    const byName = (a: Friend, b: Friend): number => (a.profile?.username ?? '').localeCompare(b.profile?.username ?? '')
    return {
      authReady,
      user,
      profile,
      friends: all.filter((f) => f.status === 'accepted').sort(byName),
      incoming: all.filter((f) => f.status === 'pending' && f.requester !== uid),
      outgoing: all.filter((f) => f.status === 'pending' && f.requester === uid),
      rooms: visibleRooms ?? [],
      roomsLoaded: visibleRooms !== null,
      invites,
      unreadCount,
      people,
      setViewingRoom: (roomId) => {
        viewingRoom.current = roomId
      }
    }
  }, [authReady, user, profile, friendships, visibleRooms, invites, unreadCount, people, uid])

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>
}

function notifyMessage(room: Room): void {
  const m = room.lastMessage
  if (!m) return
  void getProfile(m.from).then((p) =>
    window.browserr.notify({
      key: `message:${m.id}`,
      title: room.kind === 'direct' ? displayName(p) : `${displayName(p)} in ${room.name}`,
      body: m.url ? (m.text ? `${m.title}\n${m.text}` : (m.title ?? m.url)) : (m.text ?? ''),
      url: m.url ?? undefined,
      linkKey: m.url ? `${room.id}/${m.id}` : undefined,
      roomId: room.id
    })
  )
}
