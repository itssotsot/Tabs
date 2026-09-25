// Opened in the user's normal browser by src/main/auth.ts. Signs in with a Google
// popup, then hands the Google credential back to the app over localhost.
import { initializeApp } from 'firebase/app'
import {
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  inMemoryPersistence,
  initializeAuth,
  signInWithPopup,
  signOut
} from 'firebase/auth'
import { firebaseConfig } from '../firebase-config'
import './auth.css'

const params = new URLSearchParams(location.search)
const port = params.get('port')
const state = params.get('state')

const status = document.getElementById('status')!
const button = document.getElementById('google') as HTMLButtonElement

function show(message: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  status.textContent = message
  status.dataset.kind = kind
}

if (!port || !/^\d+$/.test(port) || !state) {
  show('This sign-in link is invalid. Start signing in again from Browserr.', 'error')
  button.hidden = true
}

// In-memory only: this browser shouldn't stay signed in to Browserr.
const auth = initializeAuth(initializeApp(firebaseConfig), {
  persistence: inMemoryPersistence,
  popupRedirectResolver: browserPopupRedirectResolver
})

button.addEventListener('click', async () => {
  button.disabled = true
  show('Waiting for Google…')
  try {
    const provider = new GoogleAuthProvider()
    provider.setCustomParameters({ prompt: 'select_account' })
    const result = await signInWithPopup(auth, provider)
    const credential = GoogleAuthProvider.credentialFromResult(result)
    if (!credential?.idToken) throw new Error('Google did not return a credential.')

    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      // text/plain keeps this a "simple" request, so no CORS preflight is needed.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ state, idToken: credential.idToken, accessToken: credential.accessToken ?? null })
    })
    await signOut(auth)
    if (!res.ok) throw new Error('Browserr rejected the sign-in. Try again from the app.')

    button.hidden = true
    show(`Signed in as ${result.user.email}. You can close this tab and go back to Browserr.`, 'ok')
    setTimeout(() => window.close(), 1500)
  } catch (err) {
    button.disabled = false
    const code = (err as { code?: string }).code
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      show('Sign-in was cancelled. Click the button to try again.')
    } else if (code === 'auth/popup-blocked') {
      show('Your browser blocked the Google window. Allow popups for this page and try again.', 'error')
    } else if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
      show('Google sign-in is not enabled for this Firebase project yet.', 'error')
    } else if (err instanceof TypeError) {
      show('Could not reach Browserr. Make sure the app is still open, then start again from it.', 'error')
    } else {
      show((err as Error).message || 'Something went wrong.', 'error')
    }
  }
})
