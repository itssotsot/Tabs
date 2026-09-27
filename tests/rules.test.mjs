// Firestore security rules tests. Run with: npm run test:rules
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from 'firebase/firestore'

const env = await initializeTestEnvironment({
  projectId: 'browserr-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8181 }
})

const db = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true }).firestore()
const pair = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`)
let failures = 0
async function check(name, promise) {
  try {
    await promise
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures++
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`)
  }
}

function claim(uid, username) {
  const d = db(uid)
  const batch = writeBatch(d)
  batch.set(doc(d, 'usernames', username), { uid })
  batch.set(doc(d, 'users', uid), { username, displayName: username, photoURL: null, createdAt: serverTimestamp() })
  return batch.commit()
}

function createRoom(uid, id, code, extra = {}) {
  const d = db(uid)
  const batch = writeBatch(d)
  batch.set(doc(d, 'rooms', id), {
    kind: 'group', name: 'Movie night', createdBy: uid, createdAt: serverTimestamp(), members: [uid], invited: [], invitedEmails: [],
    joinCode: code, lastMessage: null, lastMessageAt: serverTimestamp(), readAt: { [uid]: serverTimestamp() }, ...extra
  })
  batch.set(doc(d, 'roomCodes', code), { roomId: id })
  return batch.commit()
}

function post(uid, roomId, fields = {}) {
  const d = db(uid)
  const ref = doc(collection(d, 'rooms', roomId, 'messages'))
  const message = {
    from: uid, text: 'check this out', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s', title: 'Me at the zoo',
    thumbnail: null, timestampSec: 12, createdAt: serverTimestamp(), reactions: {}, ...fields
  }
  const batch = writeBatch(d)
  batch.set(ref, message)
  batch.update(doc(d, 'rooms', roomId), {
    lastMessage: { id: ref.id, from: uid, text: message.text, title: message.title },
    lastMessageAt: serverTimestamp(),
    [`readAt.${uid}`]: serverTimestamp()
  })
  return batch.commit().then(() => ref)
}

function createDirect(uid, a, b, extra = {}) {
  return setDoc(doc(db(uid), 'rooms', `dm_${pair(a, b)}`), {
    kind: 'direct', name: '', createdBy: uid, createdAt: serverTimestamp(), members: [a, b], invited: [], invitedEmails: [],
    joinCode: null, lastMessage: null, lastMessageAt: serverTimestamp(),
    readAt: { [a]: serverTimestamp(), [b]: serverTimestamp() }, ...extra
  })
}

function join(uid, roomId, code) {
  const d = db(uid)
  const batch = writeBatch(d)
  if (code) batch.set(doc(d, 'rooms', roomId, 'joins', uid), { code })
  batch.update(doc(d, 'rooms', roomId), {
    members: arrayUnion(uid),
    invited: arrayRemove(uid),
    invitedEmails: arrayRemove(`${uid}@example.com`),
    [`readAt.${uid}`]: serverTimestamp()
  })
  return batch.commit()
}

console.log('Profiles')
await check('alice claims @alice', assertSucceeds(claim('alice', 'alice')))
await check('bob claims @bob', assertSucceeds(claim('bob', 'bob')))
await check('carol claims @carol', assertSucceeds(claim('carol', 'carol')))
await check('carol cannot take @alice', assertFails(claim('carol', 'alice')))
await check('invalid username rejected', assertFails(claim('dave', 'Bad Name!')))
await check('cannot write someone else’s profile', assertFails(updateDoc(doc(db('carol'), 'users', 'alice'), { displayName: 'pwned' })))
await check('signed-out users cannot read profiles', assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'users', 'alice'))))

console.log('Friendships')
const ab = pair('alice', 'bob')
await check('alice can check a friendship that does not exist yet', assertSucceeds(getDoc(doc(db('alice'), 'friendships', ab))))
await check('carol cannot peek at alice/bob friendship', assertFails(getDoc(doc(db('carol'), 'friendships', ab))))
await check('carol cannot create a request on behalf of alice', assertFails(
  setDoc(doc(db('carol'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'pending', createdAt: serverTimestamp() })))
await check('cannot create an already-accepted friendship', assertFails(
  setDoc(doc(db('alice'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'accepted', createdAt: serverTimestamp() })))
await check('alice sends bob a request', assertSucceeds(
  setDoc(doc(db('alice'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'pending', createdAt: serverTimestamp() })))
await check('alice cannot accept her own request', assertFails(updateDoc(doc(db('alice'), 'friendships', ab), { status: 'accepted', acceptedAt: serverTimestamp() })))
await check('bob accepts', assertSucceeds(updateDoc(doc(db('bob'), 'friendships', ab), { status: 'accepted', acceptedAt: serverTimestamp() })))
await check('bob lists his friendships', assertSucceeds(getDocs(query(collection(db('bob'), 'friendships'), where('members', 'array-contains', 'bob')))))
await check('carol cannot list bob’s friendships', assertFails(getDocs(query(collection(db('carol'), 'friendships'), where('members', 'array-contains', 'bob')))))

console.log('Rooms')
const code = 'ABCDEFGH23'
await check('alice creates a room', assertSucceeds(createRoom('alice', 'room1', code)))
await check('cannot create a room for someone else', assertFails(createRoom('carol', 'room2', 'ZZZZZZZZ22', { members: ['alice'] })))
await check('cannot create a room with an existing code', assertFails(createRoom('carol', 'room3', code)))
await check('cannot create a room with a bad code', assertFails(createRoom('carol', 'room4', 'short')))
await check('carol cannot read the room', assertFails(getDoc(doc(db('carol'), 'rooms', 'room1'))))
await check('carol cannot list alice’s rooms', assertFails(getDocs(query(collection(db('carol'), 'rooms'), where('members', 'array-contains', 'alice')))))
await check('carol cannot post before joining', assertFails(post('carol', 'room1')))
await check('alice posts a link', assertSucceeds(post('alice', 'room1')))
await check('alice posts plain text', assertSucceeds(post('alice', 'room1', { url: null, title: null, timestampSec: null })))
await check('empty message rejected', assertFails(post('alice', 'room1', { text: null, url: null, title: null })))
await check('javascript: URLs are rejected', assertFails(post('alice', 'room1', { url: 'javascript:alert(1)' })))
await check('extra fields are rejected', assertFails(post('alice', 'room1', { admin: true })))
await check('alice cannot forge a message from bob', assertFails(post('alice', 'room1', { from: 'bob' })))

await check('alice invites bob by username and dave by email', assertSucceeds(updateDoc(doc(db('alice'), 'rooms', 'room1'), {
  invited: arrayUnion('bob'), invitedEmails: arrayUnion('dave@example.com')
})))
await check('carol cannot invite herself', assertFails(updateDoc(doc(db('carol'), 'rooms', 'room1'), { invited: arrayUnion('carol') })))
await check('bob sees his invite', assertSucceeds(getDocs(query(collection(db('bob'), 'rooms'), where('invited', 'array-contains', 'bob')))))
await check('dave sees his email invite', assertSucceeds(getDocs(query(collection(db('dave'), 'rooms'), where('invitedEmails', 'array-contains', 'dave@example.com')))))
await check('carol cannot list dave’s email invites', assertFails(getDocs(query(collection(db('carol'), 'rooms'), where('invitedEmails', 'array-contains', 'dave@example.com')))))
await check('bob cannot read messages before joining', assertFails(getDocs(collection(db('bob'), 'rooms', 'room1', 'messages'))))
await check('bob accepts the invite', assertSucceeds(join('bob', 'room1')))
await check('bob reads messages', assertSucceeds(getDocs(query(collection(db('bob'), 'rooms', 'room1', 'messages'), orderBy('createdAt', 'desc'), limit(200)))))
await check('bob lists his rooms', assertSucceeds(getDocs(query(collection(db('bob'), 'rooms'), where('members', 'array-contains', 'bob')))))
await check('dave declines', assertSucceeds(updateDoc(doc(db('dave'), 'rooms', 'room1'), { invitedEmails: arrayRemove('dave@example.com') })))
await check('dave can no longer join without an invite', assertFails(join('dave', 'room1')))

await check('carol cannot join with a wrong code', assertFails(join('carol', 'room1', 'WRONGWRONG')))
await check('carol looks up the code', assertSucceeds(getDoc(doc(db('carol'), 'roomCodes', code))))
await check('carol joins with the code', assertSucceeds(join('carol', 'room1', code)))

let msg
await check('bob posts', (async () => { msg = await assertSucceeds(post('bob', 'room1')) })())
await check('alice reacts', assertSucceeds(updateDoc(doc(db('alice'), 'rooms', 'room1', 'messages', msg.id), { 'reactions.alice': '😂' })))
await check('alice cannot fake carol’s reaction', assertFails(updateDoc(doc(db('alice'), 'rooms', 'room1', 'messages', msg.id), { 'reactions.carol': '❤️' })))
await check('alice cannot rewrite bob’s message', assertFails(updateDoc(doc(db('alice'), 'rooms', 'room1', 'messages', msg.id), { text: 'pwned' })))
await check('alice cannot delete bob’s message', assertFails(deleteDoc(doc(db('alice'), 'rooms', 'room1', 'messages', msg.id))))
await check('bob deletes his message', assertSucceeds(deleteDoc(doc(db('bob'), 'rooms', 'room1', 'messages', msg.id))))
await check('alice marks the room read', assertSucceeds(updateDoc(doc(db('alice'), 'rooms', 'room1'), { 'readAt.alice': serverTimestamp() })))
await check('alice cannot mark it read for bob', assertFails(updateDoc(doc(db('alice'), 'rooms', 'room1'), { 'readAt.bob': serverTimestamp() })))
await check('alice cannot remove bob', assertFails(updateDoc(doc(db('alice'), 'rooms', 'room1'), { members: arrayRemove('bob') })))

const newCode = 'NEWCODE234'
await check('alice resets the join code', (async () => {
  const d = db('alice')
  const batch = writeBatch(d)
  batch.update(doc(d, 'rooms', 'room1'), { joinCode: newCode })
  batch.set(doc(d, 'roomCodes', newCode), { roomId: 'room1' })
  batch.delete(doc(d, 'roomCodes', code))
  await assertSucceeds(batch.commit())
})())
await check('carol leaves', assertSucceeds(updateDoc(doc(db('carol'), 'rooms', 'room1'), { members: arrayRemove('carol') })))
await check('carol cannot rejoin with the old code', assertFails(join('carol', 'room1', code)))
await check('carol cannot read messages after leaving', assertFails(getDocs(collection(db('carol'), 'rooms', 'room1', 'messages'))))
await check('alice cannot delete a room others are still in', assertFails(deleteDoc(doc(db('alice'), 'rooms', 'room1'))))
await check('bob leaves', assertSucceeds(updateDoc(doc(db('bob'), 'rooms', 'room1'), { members: arrayRemove('bob') })))
await check('the last member deletes the room', (async () => {
  const d = db('alice')
  const batch = writeBatch(d)
  batch.delete(doc(d, 'rooms', 'room1'))
  batch.delete(doc(d, 'roomCodes', newCode))
  await assertSucceeds(batch.commit())
})())

console.log('Direct chats')
const dm = `dm_${pair('alice', 'bob')}`
await check('bob can check for a direct chat that does not exist yet', assertSucceeds(getDoc(doc(db('bob'), 'rooms', dm))))
await check('carol cannot check alice/bob’s direct chat', assertFails(getDoc(doc(db('carol'), 'rooms', dm))))
await check('cannot open a direct chat with a non-friend', assertFails(createDirect('carol', 'alice', 'carol')))
await check('cannot sneak a group room in under a dm_ ID', assertFails(createDirect('alice', 'alice', 'bob', { kind: 'group', name: 'x' })))
await check('cannot pre-fill invites in a direct chat', assertFails(createDirect('alice', 'alice', 'bob', { invited: ['carol'] })))
await check('bob opens the direct chat with alice', assertSucceeds(createDirect('bob', 'alice', 'bob')))
await check('alice cannot recreate (overwrite) it', assertFails(createDirect('alice', 'alice', 'bob')))
await check('alice sees it in her rooms', assertSucceeds(getDocs(query(collection(db('alice'), 'rooms'), where('members', 'array-contains', 'alice')))))
await check('alice posts in it', assertSucceeds(post('alice', dm)))
await check('bob reads it', assertSucceeds(getDocs(collection(db('bob'), 'rooms', dm, 'messages'))))
await check('carol cannot read it', assertFails(getDocs(collection(db('carol'), 'rooms', dm, 'messages'))))
await check('nobody can be invited into a direct chat', assertFails(updateDoc(doc(db('alice'), 'rooms', dm), { invited: arrayUnion('carol') })))
await check('cannot leave a direct chat', assertFails(updateDoc(doc(db('alice'), 'rooms', dm), { members: arrayRemove('alice') })))
await check('cannot delete it while still friends', assertFails(deleteDoc(doc(db('alice'), 'rooms', dm))))
await check('unfriending deletes the chat', (async () => {
  const d = db('alice')
  const batch = writeBatch(d)
  batch.delete(doc(d, 'friendships', ab))
  batch.delete(doc(d, 'rooms', dm))
  await assertSucceeds(batch.commit())
})())
await check('accepting a request can create the chat in the same batch', (async () => {
  await assertSucceeds(setDoc(doc(db('alice'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'pending', createdAt: serverTimestamp() }))
  const d = db('bob')
  const batch = writeBatch(d)
  batch.update(doc(d, 'friendships', ab), { status: 'accepted', acceptedAt: serverTimestamp() })
  batch.set(doc(d, 'rooms', dm), {
    kind: 'direct', name: '', createdBy: 'bob', createdAt: serverTimestamp(), members: ['alice', 'bob'], invited: [], invitedEmails: [],
    joinCode: null, lastMessage: null, lastMessageAt: serverTimestamp(), readAt: { alice: serverTimestamp(), bob: serverTimestamp() }
  })
  await assertSucceeds(batch.commit())
})())

console.log('Archived links')
const archived = (uid, owner, roomId = 'room9', messageId = 'm1', extra = {}) =>
  setDoc(doc(db(uid), 'users', owner, 'archivedLinks', `${roomId}:${messageId}`), {
    roomId, messageId, urls: ['https://example.com/a', 'https://example.com/b'], updatedAt: serverTimestamp(), ...extra
  })
await check('alice archives links from a message', assertSucceeds(archived('alice', 'alice')))
await check('alice reads her archived links', assertSucceeds(getDocs(collection(db('alice'), 'users', 'alice', 'archivedLinks'))))
await check('bob cannot read alice’s archived links', assertFails(getDocs(collection(db('bob'), 'users', 'alice', 'archivedLinks'))))
await check('bob cannot archive for alice', assertFails(archived('bob', 'alice')))
await check('the ID must match the message', assertFails(archived('alice', 'alice', 'room9', 'm1', { messageId: 'other' })))
await check('extra fields are rejected on archived links', assertFails(archived('alice', 'alice', 'room9', 'm2', { note: 'x' })))
await check('an empty list is rejected (delete instead)', assertFails(archived('alice', 'alice', 'room9', 'm3', { urls: [] })))
await check('bob cannot unarchive for alice', assertFails(deleteDoc(doc(db('bob'), 'users', 'alice', 'archivedLinks', 'room9:m1'))))
await check('alice unarchives', assertSucceeds(deleteDoc(doc(db('alice'), 'users', 'alice', 'archivedLinks', 'room9:m1'))))

console.log('Renaming')
await check('alice renames to @alice2 (atomic swap)', (async () => {
  const d = db('alice')
  const batch = writeBatch(d)
  batch.set(doc(d, 'usernames', 'alice2'), { uid: 'alice' })
  batch.delete(doc(d, 'usernames', 'alice'))
  batch.update(doc(d, 'users', 'alice'), { username: 'alice2' })
  await assertSucceeds(batch.commit())
})())
await check('carol cannot delete bob’s username', assertFails(deleteDoc(doc(db('carol'), 'usernames', 'bob'))))

await env.cleanup()
console.log(failures ? `\n${failures} failing` : '\nAll rules tests passed')
process.exit(failures ? 1 : 0)
