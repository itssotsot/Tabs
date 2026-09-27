import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
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

export interface LastMessage {
  id: string
  from: string
  text: string | null
  title: string | null
  url: string | null
}

export interface Room {
  id: string
  /** "direct" is the automatic one-to-one chat between two friends. */
  kind: 'group' | 'direct'
  /** Empty for direct rooms; show the other person instead. */
  name: string
  createdBy: string
  members: string[]
  invited: string[]
  invitedEmails: string[]
  joinCode: string
  lastMessage: LastMessage | null
  lastMessageAt: Date | null
  readAt: Record<string, Date | null>
}

export interface Message {
  id: string
  from: string
  text: string | null
  url: string | null
  title: string | null
  thumbnail: string | null
  timestampSec: number | null
  createdAt: Date | null
  /** uid → emoji */
  reactions: Record<string, string>
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_ROOM_MEMBERS = 50
const MESSAGE_LIMIT = 200
// No 0/O or 1/I, so codes survive being read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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
    await acceptFriend(me, other.uid)
    return 'accepted'
  }
  await setDoc(ref, { members: [me, other.uid], requester: me, status: 'pending', createdAt: serverTimestamp() })
  return 'sent'
}

/** Accepts their request and opens your direct chat. */
export async function acceptFriend(me: string, other: string): Promise<void> {
  await updateDoc(doc(db, 'friendships', pairId(me, other)), { status: 'accepted', acceptedAt: serverTimestamp() })
  // The rules check the friendship on the server, so this waits for the accept to land first.
  // If it fails anyway, SocialProvider creates the chat on its next pass.
  await ensureDirectRoom(me, other).catch(() => {})
}

/** Declines or cancels a pending request. */
export function removeFriendship(friendshipId: string): Promise<void> {
  return deleteDoc(doc(db, 'friendships', friendshipId))
}

/** Ends a friendship, and the direct chat with it. */
export async function unfriend(me: string, other: string): Promise<void> {
  const room = doc(db, 'rooms', directRoomId(me, other))
  // From the server: a stale cache saying "no chat" would leave the chat behind.
  const hasRoom = (await getDocFromServer(room)).exists()
  const batch = writeBatch(db)
  batch.delete(doc(db, 'friendships', pairId(me, other)))
  if (hasRoom) batch.delete(room)
  await batch.commit()
}

export function directRoomId(a: string, b: string): string {
  return `dm_${pairId(a, b)}`
}

/**
 * Creates the direct chat between two friends if it doesn't exist yet. Either side may call it,
 * at the same time even: the transaction makes the second call a no-op.
 */
export async function ensureDirectRoom(me: string, other: string): Promise<void> {
  const ref = doc(db, 'rooms', directRoomId(me, other))
  await runTransaction(db, async (tx) => {
    if ((await tx.get(ref)).exists()) return
    tx.set(ref, {
      kind: 'direct',
      name: '',
      createdBy: me,
      createdAt: serverTimestamp(),
      members: [me, other],
      invited: [],
      invitedEmails: [],
      joinCode: null,
      lastMessage: null,
      lastMessageAt: serverTimestamp(),
      readAt: { [me]: serverTimestamp(), [other]: serverTimestamp() }
    })
  })
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

// ---- rooms ----

function toRoom(snap: QueryDocumentSnapshot<DocumentData>): Room {
  const d = snap.data({ serverTimestamps: 'estimate' })
  const readAt: Record<string, Date | null> = {}
  for (const [uid, t] of Object.entries(d.readAt ?? {})) readAt[uid] = toDate(t)
  return {
    id: snap.id,
    kind: d.kind === 'direct' ? 'direct' : 'group',
    name: d.name ?? '',
    createdBy: d.createdBy,
    members: d.members ?? [],
    invited: d.invited ?? [],
    invitedEmails: d.invitedEmails ?? [],
    joinCode: d.joinCode,
    lastMessage: d.lastMessage ?? null,
    lastMessageAt: toDate(d.lastMessageAt),
    readAt
  }
}

/** Rooms where `field` contains `value`: our rooms, invites by uid, or invites by email. */
export function watchRooms(
  field: 'members' | 'invited' | 'invitedEmails',
  value: string,
  cb: (rooms: Room[]) => void
): () => void {
  return onSnapshot(query(collection(db, 'rooms'), where(field, 'array-contains', value)), (snap) =>
    cb(snap.docs.map(toRoom))
  )
}

export function isUnread(room: Room, uid: string): boolean {
  if (!room.lastMessage || room.lastMessage.from === uid || !room.lastMessageAt) return false
  const read = room.readAt[uid]
  return !read || room.lastMessageAt > read
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function newJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

/** Shown as "ABCDE-FGH23" but stored without the dash. */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

export async function createRoom(uid: string, name: string): Promise<string> {
  const ref = doc(collection(db, 'rooms'))
  const joinCode = newJoinCode()
  const batch = writeBatch(db)
  batch.set(ref, {
    kind: 'group',
    name: name.trim().slice(0, 64),
    createdBy: uid,
    createdAt: serverTimestamp(),
    members: [uid],
    invited: [],
    invitedEmails: [],
    joinCode,
    lastMessage: null,
    lastMessageAt: serverTimestamp(),
    readAt: { [uid]: serverTimestamp() }
  })
  batch.set(doc(db, 'roomCodes', joinCode), { roomId: ref.id })
  await batch.commit()
  return ref.id
}

export function renameRoom(roomId: string, name: string): Promise<void> {
  return updateDoc(doc(db, 'rooms', roomId), { name: name.trim().slice(0, 64) })
}

export async function resetJoinCode(room: Room): Promise<void> {
  const joinCode = newJoinCode()
  const batch = writeBatch(db)
  batch.update(doc(db, 'rooms', room.id), { joinCode })
  batch.set(doc(db, 'roomCodes', joinCode), { roomId: room.id })
  batch.delete(doc(db, 'roomCodes', room.joinCode))
  await batch.commit()
}

export type InviteResult = 'invited' | 'already-member' | 'already-invited' | 'not-found' | 'self' | 'full'

/** Invites by username (someone on Tabs) or by email (they see it once they sign in with that address). */
export async function invite(room: Room, me: { uid: string; email: string | null }, who: string): Promise<InviteResult> {
  const input = who.trim()
  if (room.members.length + room.invited.length + room.invitedEmails.length >= MAX_ROOM_MEMBERS) return 'full'
  if (EMAIL_RE.test(input)) {
    const email = normalizeEmail(input)
    if (me.email && normalizeEmail(me.email) === email) return 'self'
    if (room.invitedEmails.includes(email)) return 'already-invited'
    await updateDoc(doc(db, 'rooms', room.id), { invitedEmails: arrayUnion(email) })
    return 'invited'
  }
  const other = await findUserByUsername(input)
  if (!other) return 'not-found'
  if (other.uid === me.uid) return 'self'
  if (room.members.includes(other.uid)) return 'already-member'
  if (room.invited.includes(other.uid)) return 'already-invited'
  await updateDoc(doc(db, 'rooms', room.id), { invited: arrayUnion(other.uid) })
  return 'invited'
}

export function cancelInvite(roomId: string, invitee: { uid?: string; email?: string }): Promise<void> {
  return updateDoc(
    doc(db, 'rooms', roomId),
    invitee.uid ? { invited: arrayRemove(invitee.uid) } : { invitedEmails: arrayRemove(invitee.email) }
  )
}

function joinUpdate(uid: string, email: string | null): DocumentData {
  return {
    members: arrayUnion(uid),
    invited: arrayRemove(uid),
    invitedEmails: arrayRemove(email ? normalizeEmail(email) : ''),
    [`readAt.${uid}`]: serverTimestamp()
  }
}

export function acceptInvite(roomId: string, uid: string, email: string | null): Promise<void> {
  return updateDoc(doc(db, 'rooms', roomId), joinUpdate(uid, email))
}

export function declineInvite(roomId: string, uid: string, email: string | null): Promise<void> {
  return updateDoc(doc(db, 'rooms', roomId), {
    invited: arrayRemove(uid),
    invitedEmails: arrayRemove(email ? normalizeEmail(email) : '')
  })
}

export type JoinResult = { ok: true; roomId: string } | { ok: false; reason: 'not-found' | 'denied' }

export async function joinWithCode(uid: string, email: string | null, input: string): Promise<JoinResult> {
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!/^[A-Z2-9]{10}$/.test(code)) return { ok: false, reason: 'not-found' }
  const snap = await getDoc(doc(db, 'roomCodes', code))
  const roomId = snap.data()?.roomId as string | undefined
  if (!roomId) return { ok: false, reason: 'not-found' }
  const batch = writeBatch(db)
  batch.set(doc(db, 'rooms', roomId, 'joins', uid), { code })
  batch.update(doc(db, 'rooms', roomId), joinUpdate(uid, email))
  try {
    await batch.commit()
  } catch (err) {
    if ((err as { code?: string }).code !== 'permission-denied') throw err
    // The rules only let outsiders join, so we may simply be in it already. Otherwise it's full.
    const room = await getDoc(doc(db, 'rooms', roomId)).catch(() => null)
    return room?.data()?.members?.includes(uid) ? { ok: true, roomId } : { ok: false, reason: 'denied' }
  }
  return { ok: true, roomId }
}

/** Leaves the room; the last one out deletes it. */
export async function leaveRoom(room: Room, uid: string): Promise<void> {
  if (room.members.length <= 1) {
    const batch = writeBatch(db)
    batch.delete(doc(db, 'rooms', room.id))
    batch.delete(doc(db, 'roomCodes', room.joinCode))
    await batch.commit()
    return
  }
  await updateDoc(doc(db, 'rooms', room.id), { members: arrayRemove(uid) })
}

export function markRoomRead(roomId: string, uid: string): Promise<void> {
  return updateDoc(doc(db, 'rooms', roomId), { [`readAt.${uid}`]: serverTimestamp() })
}

// ---- messages ----

function toMessage(snap: QueryDocumentSnapshot<DocumentData>): Message {
  const d = snap.data({ serverTimestamps: 'estimate' })
  return {
    id: snap.id,
    from: d.from,
    text: d.text ?? null,
    url: d.url ?? null,
    title: d.title ?? null,
    thumbnail: d.thumbnail ?? null,
    timestampSec: d.timestampSec ?? null,
    createdAt: toDate(d.createdAt),
    reactions: d.reactions ?? {}
  }
}

/** Oldest first. */
export function watchMessages(roomId: string, cb: (messages: Message[]) => void, onError?: () => void): () => void {
  const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'desc'), limit(MESSAGE_LIMIT))
  return onSnapshot(q, (snap) => cb(snap.docs.map(toMessage).reverse()), onError)
}

export interface OutgoingLink {
  url: string
  title: string
  thumbnail: string | null
  timestampSec: number | null
}

export async function sendMessage(roomId: string, from: string, text: string | null, link?: OutgoingLink): Promise<void> {
  const ref = doc(collection(db, 'rooms', roomId, 'messages'))
  const body = text?.trim() ? text.trim().slice(0, 2000) : null
  const title = link ? link.title.slice(0, 500) : null
  const batch = writeBatch(db)
  batch.set(ref, {
    from,
    text: body,
    url: link?.url ?? null,
    title,
    thumbnail: link?.thumbnail && link.thumbnail.length <= 2048 ? link.thumbnail : null,
    timestampSec: link?.timestampSec ?? null,
    createdAt: serverTimestamp(),
    reactions: {}
  })
  batch.update(doc(db, 'rooms', roomId), {
    lastMessage: { id: ref.id, from, text: body?.slice(0, 200) ?? null, title, url: link?.url ?? null },
    lastMessageAt: serverTimestamp(),
    [`readAt.${from}`]: serverTimestamp()
  })
  await batch.commit()
}

export function react(roomId: string, messageId: string, uid: string, reaction: string | null): Promise<void> {
  return updateDoc(doc(db, 'rooms', roomId, 'messages', messageId), {
    [`reactions.${uid}`]: reaction ?? deleteField()
  })
}

export function deleteMessage(roomId: string, messageId: string): Promise<void> {
  return deleteDoc(doc(db, 'rooms', roomId, 'messages', messageId))
}

// ---- archived links (private to each user) ----

/** Which links of one message you've archived, by URL. */
export interface ArchivedLinks {
  roomId: string
  messageId: string
  urls: string[]
}

export function archivedLinksId(roomId: string, messageId: string): string {
  return `${roomId}:${messageId}`
}

export function watchArchivedLinks(uid: string, cb: (list: ArchivedLinks[]) => void, onError?: () => void): () => void {
  return onSnapshot(
    collection(db, 'users', uid, 'archivedLinks'),
    (snap) => cb(snap.docs.map((d) => ({ roomId: d.data().roomId, messageId: d.data().messageId, urls: d.data().urls ?? [] }))),
    onError
  )
}

/** Saves the archived URLs for a message; none left removes the record. */
export function setArchivedLinks(uid: string, roomId: string, messageId: string, urls: string[]): Promise<void> {
  const ref = doc(db, 'users', uid, 'archivedLinks', archivedLinksId(roomId, messageId))
  if (!urls.length) return deleteDoc(ref)
  return setDoc(ref, { roomId, messageId, urls: urls.slice(0, 50), updatedAt: serverTimestamp() })
}
