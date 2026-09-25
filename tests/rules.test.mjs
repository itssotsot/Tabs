// Firestore security rules tests. Run with: npm run test:rules
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import {
  collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch, addDoc
} from 'firebase/firestore'

const env = await initializeTestEnvironment({
  projectId: 'browserr-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8181 }
})

const db = (uid) => env.authenticatedContext(uid).firestore()
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

function share(from, to, extra = {}) {
  return addDoc(collection(db(from), 'shares'), {
    from, to, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s', title: 'Me at the zoo',
    thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg', timestampSec: 12, note: 'lol',
    createdAt: serverTimestamp(), seenAt: null, reaction: null, ...extra
  })
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
await check('sharing before being friends is rejected', assertFails(share('alice', 'bob')))
await check('carol cannot create a request on behalf of alice', assertFails(
  setDoc(doc(db('carol'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'pending', createdAt: serverTimestamp() })))
await check('cannot create an already-accepted friendship', assertFails(
  setDoc(doc(db('alice'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'accepted', createdAt: serverTimestamp() })))
await check('alice sends bob a request', assertSucceeds(
  setDoc(doc(db('alice'), 'friendships', ab), { members: ['alice', 'bob'], requester: 'alice', status: 'pending', createdAt: serverTimestamp() })))
await check('alice cannot accept her own request', assertFails(updateDoc(doc(db('alice'), 'friendships', ab), { status: 'accepted', acceptedAt: serverTimestamp() })))
await check('pending request still blocks sharing', assertFails(share('alice', 'bob')))
await check('bob accepts', assertSucceeds(updateDoc(doc(db('bob'), 'friendships', ab), { status: 'accepted', acceptedAt: serverTimestamp() })))
await check('bob lists his friendships', assertSucceeds(getDocs(query(collection(db('bob'), 'friendships'), where('members', 'array-contains', 'bob')))))
await check('carol cannot list bob’s friendships', assertFails(getDocs(query(collection(db('carol'), 'friendships'), where('members', 'array-contains', 'bob')))))

console.log('Shares')
let shareRef
await check('alice sends bob a link', (async () => { shareRef = await assertSucceeds(share('alice', 'bob')) })())
await check('alice cannot send a link to carol (not friends)', assertFails(share('alice', 'carol')))
await check('alice cannot forge a link from bob', assertFails(addDoc(collection(db('alice'), 'shares'), {
  from: 'bob', to: 'alice', url: 'https://example.com', title: 'x', thumbnail: null, timestampSec: null, note: null,
  createdAt: serverTimestamp(), seenAt: null, reaction: null
})))
await check('javascript: URLs are rejected', assertFails(share('alice', 'bob', { url: 'javascript:alert(1)' })))
await check('extra fields are rejected', assertFails(share('alice', 'bob', { admin: true })))
await check('pre-marked "seen" is rejected', assertFails(share('alice', 'bob', { seenAt: serverTimestamp() })))
await check('bob reads his inbox', assertSucceeds(getDocs(query(collection(db('bob'), 'shares'), where('to', '==', 'bob'), orderBy('createdAt', 'desc'), limit(100)))))
await check('alice reads her sent list', assertSucceeds(getDocs(query(collection(db('alice'), 'shares'), where('from', '==', 'alice'), orderBy('createdAt', 'desc'), limit(100)))))
await check('carol cannot read bob’s inbox', assertFails(getDocs(query(collection(db('carol'), 'shares'), where('to', '==', 'bob')))))
await check('carol cannot read the link directly', assertFails(getDoc(doc(db('carol'), 'shares', shareRef.id))))
await check('bob marks it seen and reacts', assertSucceeds(updateDoc(doc(db('bob'), 'shares', shareRef.id), { seenAt: serverTimestamp(), reaction: '😂' })))
await check('bob cannot rewrite the URL', assertFails(updateDoc(doc(db('bob'), 'shares', shareRef.id), { url: 'https://evil.example' })))
await check('alice cannot fake bob’s reaction', assertFails(updateDoc(doc(db('alice'), 'shares', shareRef.id), { reaction: '❤️' })))
await check('carol cannot delete it', assertFails(deleteDoc(doc(db('carol'), 'shares', shareRef.id))))
await check('bob deletes it from his inbox', assertSucceeds(deleteDoc(doc(db('bob'), 'shares', shareRef.id))))

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
