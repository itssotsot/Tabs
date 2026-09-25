import { initializeApp } from 'firebase/app'
import { browserLocalPersistence, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth'
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { firebaseConfig } from './firebase-config'

export const firebaseApp = initializeApp(firebaseConfig)

// No popup/redirect resolver: sign-in happens in the system browser (see src/main/auth.ts).
export const auth = initializeAuth(firebaseApp, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence]
})

// Each window's UI and overlay is a separate renderer on the same origin, so share one cache.
export const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
})
