import { Bell, BellOff, LogOut, Send } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { isUsernameAvailable, saveProfile, signInWithGoogle, signOut, USERNAME_RE } from '../../social/api'
import { useSocial } from '../../social/SocialProvider'
import { Avatar } from '../../ui/Avatar'
import { shortcut } from '../../ui/util'

function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code ?? ''
  const message = (err as Error).message ?? ''
  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
    return 'Google sign-in is not enabled in Firebase yet.'
  }
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.'
  if (message.includes('timed out')) return 'Sign-in timed out. Try again.'
  if (message.includes('restarted')) return ''
  return message || 'Sign-in failed.'
}

export function SignInCard(): ReactNode {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  // Retrying cancels the previous attempt; only the latest one may update the UI.
  const attempt = useRef(0)

  const start = async (): Promise<void> => {
    const id = ++attempt.current
    setError('')
    setWaiting(true)
    try {
      await signInWithGoogle()
    } catch (err) {
      if (id === attempt.current) setError(authErrorMessage(err))
    } finally {
      if (id === attempt.current) setWaiting(false)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-icon">
        <Send size={26} />
      </div>
      <h2>Send links to friends, instantly</h2>
      <p>
        Press <kbd>{shortcut('⌘⇧S', 'Ctrl+Shift+S')}</kbd> on any page (or the send button on YouTube) and it pops up in
        your friend's Browserr, at the exact timestamp.
      </p>
      <button className="primary-btn" disabled={waiting} onClick={start}>
        {waiting ? 'Finish signing in in your browser…' : 'Sign in with Google'}
      </button>
      {waiting && (
        <button className="link-btn" onClick={start}>
          Didn't open? Try again
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

function suggestUsername(name: string | null, email: string | null): string {
  const base = (name || email?.split('@')[0] || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 20)
  return base.length >= 3 ? base : ''
}

export function UsernameSetup(): ReactNode {
  const { user } = useSocial()
  const [username, setUsername] = useState(() => suggestUsername(user?.displayName ?? null, user?.email ?? null))
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!username) return setStatus('idle')
    if (!USERNAME_RE.test(username)) return setStatus('invalid')
    setStatus('checking')
    const timer = setTimeout(() => {
      isUsernameAvailable(username)
        .then((ok) => setStatus(ok ? 'available' : 'taken'))
        .catch(() => setStatus('idle'))
    }, 300)
    return () => clearTimeout(timer)
  }, [username])

  if (!user) return null

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (status !== 'available') return
    setSaving(true)
    setError('')
    try {
      await saveProfile(user.uid, username, user.displayName || username, user.photoURL)
    } catch {
      setError('That username was just taken. Try another one.')
      setStatus('taken')
    } finally {
      setSaving(false)
    }
  }

  const hints = {
    idle: '3–20 characters: letters, numbers and _',
    checking: 'Checking…',
    available: `@${username} is available`,
    taken: `@${username} is taken`,
    invalid: 'Use 3–20 lowercase letters, numbers or _'
  }

  return (
    <form className="onboarding" onSubmit={save}>
      <Avatar profile={null} photoURL={user.photoURL} size={56} />
      <h2>Pick a username</h2>
      <p>Friends add you by your username.</p>
      <div className="input-prefix">
        <span>@</span>
        <input
          autoFocus
          value={username}
          maxLength={20}
          spellCheck={false}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
        />
      </div>
      <p className={`field-hint ${status}`}>{hints[status]}</p>
      <button className="primary-btn" type="submit" disabled={status !== 'available' || saving}>
        {saving ? 'Saving…' : 'Continue'}
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  )
}

export function AccountFooter(): ReactNode {
  const { user, profile } = useSocial()
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.browserr.settings.get().then(setSettings)
    return window.browserr.settings.onChanged(setSettings)
  }, [])

  const toggleNotifications = async (): Promise<void> => {
    if (settings) setSettings(await window.browserr.settings.set({ notifications: !settings.notifications }))
  }

  return (
    <div className="account-footer">
      <Avatar profile={profile} photoURL={user?.photoURL} size={26} />
      <div className="account-name">
        <strong>{profile?.displayName}</strong>
        <span>@{profile?.username}</span>
      </div>
      <button
        className="icon-btn small"
        title={settings?.notifications ? 'Mute notifications' : 'Turn on notifications'}
        onClick={toggleNotifications}
      >
        {settings?.notifications === false ? <BellOff size={15} /> : <Bell size={15} />}
      </button>
      <button className="icon-btn small" title="Sign out" onClick={() => void signOut()}>
        <LogOut size={15} />
      </button>
    </div>
  )
}
