import { onAuthStateChanged, type User } from 'firebase/auth'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { auth } from '../firebase'
import {
  getProfile,
  markSeen,
  watchFriendships,
  watchProfile,
  watchShares,
  type Friendship,
  type Profile,
  type Share
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
  inbox: Share[]
  sent: Share[]
  unseenCount: number
  /** Profiles of everyone we've exchanged links with, keyed by uid. */
  people: Record<string, Profile | null>
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

const LAST_NOTIFIED_KEY = 'browserr.lastNotifiedAt'

interface Props {
  children: ReactNode
  /** The main browser UI watches links and raises notifications; the overlay only needs friends. */
  withShares?: boolean
}

export function SocialProvider({ children, withShares = false }: Props): ReactNode {
  const [authReady, setAuthReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [friendships, setFriendships] = useState<Friendship[]>([])
  const [inbox, setInbox] = useState<Share[]>([])
  const [sent, setSent] = useState<Share[]>([])
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
          setInbox([])
          setSent([])
        }
      }),
    []
  )

  const uid = user?.uid

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
      ensurePeople(list.map((f) => (f.members[0] === uid ? f.members[1] : f.members[0])))
      if (withShares && previous) {
        for (const f of list) {
          const before = previous.get(f.id)
          const other = f.members[0] === uid ? f.members[1] : f.members[0]
          if (!before && f.status === 'pending' && f.requester !== uid) {
            void getProfile(other).then((p) =>
              window.browserr.notify({
                key: `friend-request:${f.id}`,
                title: 'New friend request',
                body: `${displayName(p)} wants to swap links with you.`,
                panel: 'friends'
              })
            )
          }
          if (before?.status === 'pending' && f.status === 'accepted' && f.requester === uid) {
            void getProfile(other).then((p) =>
              window.browserr.notify({
                key: `friend-accepted:${f.id}`,
                title: 'Friend request accepted',
                body: `You and ${displayName(p)} can now send each other links.`,
                panel: 'friends'
              })
            )
          }
        }
      }
      previous = new Map(list.map((f) => [f.id, f]))
    })
  }, [uid, ready, withShares])

  // Incoming links
  useEffect(() => {
    if (!uid || !ready || !withShares) return
    return watchShares('to', uid, (list, changes, initial) => {
      setInbox(list)
      ensurePeople(list.map((s) => s.from))

      const lastNotified = Number(localStorage.getItem(LAST_NOTIFIED_KEY) ?? 0)
      localStorage.setItem(LAST_NOTIFIED_KEY, String(Date.now()))

      if (initial) {
        // Links that arrived while the app was closed get one summary notification.
        const missed = list.filter((s) => !s.seenAt && s.createdAt && s.createdAt.getTime() > lastNotified)
        if (missed.length === 1) notifyShare(missed[0])
        else if (missed.length > 1) {
          window.browserr.notify({
            key: `missed:${missed[0].id}`,
            title: `${missed.length} new links`,
            body: 'Friends sent you links while you were away.',
            panel: 'inbox'
          })
        }
        return
      }
      for (const c of changes) {
        if (c.type === 'added' && !c.share.seenAt) notifyShare(c.share)
      }
    })
  }, [uid, ready, withShares])

  // Reactions to links we sent
  useEffect(() => {
    if (!uid || !ready || !withShares) return
    const reactions = new Map<string, string | null>()
    return watchShares('from', uid, (list, changes, initial) => {
      setSent(list)
      ensurePeople(list.map((s) => s.to))
      for (const c of changes) {
        const before = reactions.get(c.share.id)
        reactions.set(c.share.id, c.share.reaction)
        if (initial || c.type !== 'modified' || !c.share.reaction || before === c.share.reaction) continue
        const share = c.share
        void getProfile(share.to).then((p) =>
          window.browserr.notify({
            key: `reaction:${share.id}:${share.reaction}`,
            title: `${displayName(p)} reacted ${share.reaction}`,
            body: share.title,
            panel: 'sent'
          })
        )
      }
    })
  }, [uid, ready, withShares])

  // Clicking a notification opens the link; mark it seen here.
  useEffect(() => {
    if (!withShares) return
    return window.browserr.onCommand((cmd) => {
      if (cmd.type === 'share-opened') void markSeen(cmd.shareId).catch(() => {})
    })
  }, [withShares])

  const unseenCount = inbox.filter((s) => !s.seenAt).length
  useEffect(() => {
    if (withShares) window.browserr.setBadge(unseenCount)
  }, [unseenCount, withShares])

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
      inbox,
      sent,
      unseenCount,
      people
    }
  }, [authReady, user, profile, friendships, inbox, sent, unseenCount, people, uid])

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>
}

function notifyShare(share: Share): void {
  void getProfile(share.from).then((p) =>
    window.browserr.notify({
      key: `share:${share.id}`,
      title: `${displayName(p)} sent you a link`,
      body: share.note ? `${share.title}\n“${share.note}”` : share.title,
      url: share.url,
      shareId: share.id
    })
  )
}
