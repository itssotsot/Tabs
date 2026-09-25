import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot
} from 'firebase/firestore'
import { GoogleAuthProvider, signInWithCredential, signOut as firebaseSignOut } from 'firebase/auth'
import { auth, db } from '../firebase'

export interface Profile {
  uid: string
  username: string
  displayName: string
  photoURL: string | null
}

export interface Friendship {
  id: string
  members: [string, string]
  requester: string
  status: 'pending' | 'accepted'
  createdAt: Date | null
}

export interface Share {
  id: string
  from: string
  to: string
  url: string
  title: string
  thumbnail: string | null
  timestampSec: number | null
  note: string | null
  createdAt: Date | null
  seenAt: Date | null
  reaction: string | null
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
const INBOX_LIMIT = 100

export function pairId(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`
}

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : null)

// ---- auth ----

export async function signInWithGoogle(): Promise<void> {
  const { idToken, accessToken } = await window.browserr.auth.signInWithGoogle()
  await signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken))
}

export function signOut(): Promise<void> {
  return firebaseSignOut(auth)
}

// ---- profiles ----

export function watchProfile(uid: string, cb: (p: Profile | null) => void): () => void {
  return onSnapshot(doc(db, 'users', uid), (snap) => {
    const d = snap.data()
    cb(d ? { uid, username: d.username, displayName: d.displayName, photoURL: d.photoURL ?? null } : null)
  })
}

const profileCache = new Map<string, Promise<Profile | null>>()

export function getProfile(uid: string): Promise<Profile | null> {
  let cached = profileCache.get(uid)
  if (!cached) {
    cached = getDoc(doc(db, 'users', uid)).then((snap) => {
      const d = snap.data()
      return d ? { uid, username: d.username, displayName: d.displayName, photoURL: d.photoURL ?? null } : null
    })
    cached.catch(() => profileCache.delete(uid))
    profileCache.set(uid, cached)
  }
  return cached
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'usernames', username))
  return !snap.exists()
}

/** Claims a username (and releases the old one) in a single atomic write. */
export async function saveProfile(
  uid: string,
  username: string,
  displayName: string,
  photoURL: string | null,
  previousUsername?: string
): Promise<void> {
  const batch = writeBatch(db)
  batch.set(doc(db, 'usernames', username), { uid })
  if (previousUsername && previousUsername !== username) batch.delete(doc(db, 'usernames', previousUsername))
  if (previousUsername) {
    batch.update(doc(db, 'users', uid), { username, displayName, photoURL })
  } else {
    batch.set(doc(db, 'users', uid), { username, displayName, photoURL, createdAt: serverTimestamp() })
  }
  await batch.commit()
  profileCache.delete(uid)
}

export async function findUserByUsername(username: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db, 'usernames', username.toLowerCase().replace(/^@/, '')))
  const uid = snap.data()?.uid as string | undefined
  return uid ? getProfile(uid) : null
}

// ---- friends ----

export type FriendRequestResult = 'sent' | 'accepted' | 'already-friends' | 'already-requested' | 'not-found' | 'self'

export async function addFriend(me: string, username: string): Promise<FriendRequestResult> {
  const other = await findUserByUsername(username)
  if (!other) return 'not-found'
  if (other.uid === me) return 'self'
  const ref = doc(db, 'friendships', pairId(me, other.uid))
  const existing = await getDoc(ref)
  if (existing.exists()) {
    const f = existing.data()
    if (f.status === 'accepted') return 'already-friends'
    if (f.requester === me) return 'already-requested'
    // They already asked us, so asking back means yes.
    await acceptFriend(ref.id)
    return 'accepted'
  }
  await setDoc(ref, { members: [me, other.uid], requester: me, status: 'pending', createdAt: serverTimestamp() })
  return 'sent'
}

export function acceptFriend(friendshipId: string): Promise<void> {
  return updateDoc(doc(db, 'friendships', friendshipId), { status: 'accepted', acceptedAt: serverTimestamp() })
}

export function removeFriendship(friendshipId: string): Promise<void> {
  return deleteDoc(doc(db, 'friendships', friendshipId))
}

function toFriendship(snap: QueryDocumentSnapshot<DocumentData>): Friendship {
  const d = snap.data()
  return { id: snap.id, members: d.members, requester: d.requester, status: d.status, createdAt: toDate(d.createdAt) }
}

export function watchFriendships(uid: string, cb: (list: Friendship[]) => void): () => void {
  return onSnapshot(query(collection(db, 'friendships'), where('members', 'array-contains', uid)), (snap) =>
    cb(snap.docs.map(toFriendship))
  )
}

// ---- shares ----

function toShare(snap: QueryDocumentSnapshot<DocumentData>): Share {
  const d = snap.data({ serverTimestamps: 'estimate' })
  return {
    id: snap.id,
    from: d.from,
    to: d.to,
    url: d.url,
    title: d.title,
    thumbnail: d.thumbnail ?? null,
    timestampSec: d.timestampSec ?? null,
    note: d.note ?? null,
    createdAt: toDate(d.createdAt),
    seenAt: toDate(d.seenAt),
    reaction: d.reaction ?? null
  }
}

export interface ShareChange {
  type: 'added' | 'modified' | 'removed'
  share: Share
}

export function watchShares(
  field: 'to' | 'from',
  uid: string,
  cb: (list: Share[], changes: ShareChange[], initial: boolean) => void
): () => void {
  let initial = true
  const q = query(collection(db, 'shares'), where(field, '==', uid), orderBy('createdAt', 'desc'), limit(INBOX_LIMIT))
  return onSnapshot(q, (snap) => {
    const changes = snap.docChanges().map((c) => ({ type: c.type, share: toShare(c.doc) }))
    cb(snap.docs.map(toShare), changes, initial)
    initial = false
  })
}

export interface OutgoingShare {
  url: string
  title: string
  thumbnail: string | null
  timestampSec: number | null
  note: string | null
}

export async function sendShare(from: string, to: string, share: OutgoingShare): Promise<void> {
  await addDoc(collection(db, 'shares'), {
    from,
    to,
    url: share.url,
    title: share.title.slice(0, 500),
    thumbnail: share.thumbnail && share.thumbnail.length <= 2048 ? share.thumbnail : null,
    timestampSec: share.timestampSec,
    note: share.note?.trim() ? share.note.trim().slice(0, 500) : null,
    createdAt: serverTimestamp(),
    seenAt: null,
    reaction: null
  })
}

export function markSeen(shareId: string): Promise<void> {
  return updateDoc(doc(db, 'shares', shareId), { seenAt: serverTimestamp() })
}

export function react(shareId: string, reaction: string | null): Promise<void> {
  return updateDoc(doc(db, 'shares', shareId), { reaction })
}

export function deleteShare(shareId: string): Promise<void> {
  return deleteDoc(doc(db, 'shares', shareId))
}
