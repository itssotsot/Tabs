import { ArrowLeft, ArrowRight, Check, Copy, Globe, History, Layers, Lock, Search, Send, Star, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ImportCounts, ImportPreview, ImportSource } from '@shared/types'
import { acceptFriend, addFriend, type FriendRequestResult } from '../../social/api'
import { useSocial, type Friend } from '../../social/SocialProvider'
import { Avatar } from '../../ui/Avatar'
import { cx, shortcut } from '../../ui/util'
import { useGoogleSignIn, useUsernameField } from '../panels/Account'
import './intro.css'

type Step = 'welcome' | 'account' | 'friends' | 'import' | 'done'

/** `setup` is the first-run intro; `import` is only the import step, opened from the File menu or Settings. */
export type IntroMode = 'setup' | 'import'

const DOWNLOAD_URL = 'https://github.com/itssotsot/tabs/releases/latest'

interface StepProps {
  onNext: () => void
}

function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }): ReactNode {
  return (
    <div className="intro-footer">
      {onBack ? (
        <button className="intro-back" onClick={onBack}>
          <ArrowLeft size={14} />
          Back
        </button>
      ) : (
        <span />
      )}
      <div className="intro-footer-actions">{children}</div>
    </div>
  )
}

// ---- Welcome ----

function Hero(): ReactNode {
  return (
    <div className="intro-hero" aria-hidden>
      <div className="hero-glow" />
      {(['t1', 't2', 't3'] as const).map((t) => (
        <div key={t} className={cx('hero-tab', t)}>
          <div className="hero-tab-bar">
            <i />
            <b />
          </div>
          <div className="hero-tab-body">
            <b />
            <b />
            <b />
          </div>
        </div>
      ))}
      <div className="hero-send">
        <Send size={20} />
      </div>
    </div>
  )
}

function WelcomeStep({ onNext }: StepProps): ReactNode {
  return (
    <>
      <Hero />
      <h1>Welcome to Tabs</h1>
      <p className="intro-lede">
        The browser that's better with friends. Send any page to a chat in one keystroke, and videos start at the exact
        second you were watching.
      </p>
      <button className="intro-primary big" autoFocus onClick={onNext}>
        Get started
        <ArrowRight size={16} />
      </button>
    </>
  )
}

// ---- Account ----

function GoogleLogo(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

function UsernameForm(): ReactNode {
  const { user } = useSocial()
  const { username, setUsername, status, hint, saving, error, save } = useUsernameField()

  return (
    <form className="intro-form" onSubmit={save}>
      <Avatar profile={null} photoURL={user?.photoURL} size={64} />
      <h1>Pick a username</h1>
      <p className="intro-lede">Friends find you by it.</p>
      <div className="intro-field">
        <span>@</span>
        <input autoFocus value={username} maxLength={20} spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <p className={cx('intro-hint', status)}>{hint}</p>
      <button className="intro-primary big" type="submit" disabled={status !== 'available' || saving}>
        {saving ? 'Saving…' : 'Continue'}
      </button>
      {error && <p className="intro-error">{error}</p>}
    </form>
  )
}

function AccountStep({ onNext, onBack }: StepProps & { onBack: () => void }): ReactNode {
  const { authReady, user, profile } = useSocial()
  const { start, waiting, error } = useGoogleSignIn()
  // Signing in (or picking a username) here moves on by itself; someone already signed in gets a Continue button.
  const setUpHere = useRef(!user || !profile)

  useEffect(() => {
    if (user && profile && setUpHere.current) onNext()
  }, [user, profile])

  let body: ReactNode
  if (!authReady || (user && profile === undefined)) {
    body = <span className="spinner intro-spinner" />
  } else if (!user) {
    body = (
      <>
        <div className="intro-badge">
          <Send size={28} />
        </div>
        <h1>Sign in to chat with friends</h1>
        <p className="intro-lede">
          Every friend gets a chat in your inbox. Press <kbd>{shortcut('⌘⇧S', 'Ctrl+Shift+S')}</kbd> on any page to drop
          it in. Your Google account is only used to sign you in.
        </p>
        <button className="intro-google" autoFocus disabled={waiting} onClick={start}>
          <GoogleLogo />
          {waiting ? 'Finish signing in in your browser…' : 'Continue with Google'}
        </button>
        {waiting && (
          <button className="intro-link" onClick={start}>
            Didn't open? Try again
          </button>
        )}
        {error && <p className="intro-error">{error}</p>}
      </>
    )
  } else if (!profile) {
    body = <UsernameForm />
  } else {
    body = (
      <>
        <Avatar profile={profile} photoURL={user.photoURL} size={64} />
        <h1>You're signed in</h1>
        <p className="intro-lede">
          as <strong>@{profile.username}</strong>
        </p>
        <button className="intro-primary big" autoFocus onClick={onNext}>
          Continue
          <ArrowRight size={16} />
        </button>
      </>
    )
  }

  return (
    <>
      {body}
      <Footer onBack={onBack}>
        {!user && (
          <button className="intro-secondary" onClick={onNext}>
            Skip for now
          </button>
        )}
      </Footer>
    </>
  )
}

// ---- Friends ----

const RESULT_TEXT: Record<FriendRequestResult, string> = {
  sent: 'Request sent!',
  accepted: 'They had already asked you, so you are now friends!',
  'already-friends': 'You are already friends.',
  'already-requested': 'You already sent them a request.',
  'not-found': 'No one has that username.',
  self: "That's you!"
}

function PersonRow({ friend, children }: { friend: Friend; children: ReactNode }): ReactNode {
  return (
    <div className="intro-person">
      <Avatar profile={friend.profile} size={32} />
      <div className="intro-person-name">
        <strong>{friend.profile?.displayName ?? '…'}</strong>
        <span>@{friend.profile?.username ?? '…'}</span>
      </div>
      {children}
    </div>
  )
}

function FriendsStep({ onNext, onBack }: StepProps & { onBack: () => void }): ReactNode {
  const { user, profile, friends, incoming, outgoing } = useSocial()
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!user || !profile) return null

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = username.trim().replace(/^@/, '').toLowerCase()
    if (!name) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await addFriend(user.uid, name)
      setMessage({ text: RESULT_TEXT[result], ok: result === 'sent' || result === 'accepted' })
      if (result === 'sent' || result === 'accepted') setUsername('')
    } catch {
      setMessage({ text: 'Something went wrong. Try again.', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const copyInvite = (): void => {
    void navigator.clipboard.writeText(`Add me on Tabs, I'm @${profile.username}. Get it here: ${DOWNLOAD_URL}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const people = incoming.length + friends.length + outgoing.length

  return (
    <>
      <div className="intro-badge">
        <UserPlus size={28} />
      </div>
      <h1>Find your friends</h1>
      <p className="intro-lede">Add friends by their username. Once they accept, your chat with them shows up in your inbox.</p>

      <form className="intro-add" onSubmit={submit}>
        <div className="intro-field">
          <span>@</span>
          <input
            autoFocus
            value={username}
            placeholder="friend's username"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <button className="intro-primary" type="submit" disabled={busy || !username.trim()}>
          Add
        </button>
      </form>
      {message && <p className={message.ok ? 'intro-ok' : 'intro-error'}>{message.text}</p>}

      {people > 0 && (
        <div className="intro-people">
          {incoming.map((f) => (
            <PersonRow key={f.friendshipId} friend={f}>
              <button className="intro-primary small" onClick={() => void acceptFriend(user.uid, f.uid)}>
                Accept
              </button>
            </PersonRow>
          ))}
          {friends.map((f) => (
            <PersonRow key={f.friendshipId} friend={f}>
              <span className="intro-tag ok">
                <Check size={12} />
                Friends
              </span>
            </PersonRow>
          ))}
          {outgoing.map((f) => (
            <PersonRow key={f.friendshipId} friend={f}>
              <span className="intro-tag">Requested</span>
            </PersonRow>
          ))}
        </div>
      )}

      <button className="intro-invite" onClick={copyInvite}>
        <span className="intro-invite-text">
          <strong>Friends not on Tabs yet?</strong>
          <span>Copy an invite with your username and a download link.</span>
        </span>
        <span className="intro-invite-action">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy invite'}
        </span>
      </button>

      <Footer onBack={onBack}>
        <button className="intro-primary" onClick={onNext}>
          {people ? 'Continue' : 'Skip for now'}
          <ArrowRight size={15} />
        </button>
      </Footer>
    </>
  )
}

// ---- Import ----

function BrowserIcon({ source, size = 36 }: { source: ImportSource; size?: number }): ReactNode {
  if (source.icon) return <img className="intro-app-icon" src={source.icon} width={size} height={size} alt="" draggable={false} />
  return (
    <span className="intro-app-icon letter" style={{ width: size, height: size }}>
      <Globe size={Math.round(size * 0.5)} />
    </span>
  )
}

const sourceName = (s: ImportSource): string => (s.profile ? `${s.browser} (${s.profile})` : s.browser)
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

function importSummary(counts: ImportCounts): string {
  const parts = [
    counts.tabs > 0 && plural(counts.tabs, 'tab', 'tabs'),
    counts.favorites > 0 && plural(counts.favorites, 'favorite', 'favorites'),
    counts.history > 0 && plural(counts.history, 'page', 'pages') + ' of history'
  ].filter((p): p is string => !!p)
  if (!parts.length) return 'Everything there was already here.'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Added ${list}.`
}

function ImportStep({ mode, onNext, onBack }: StepProps & { mode: IntroMode; onBack?: () => void }): ReactNode {
  const api = window.browserr
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // undefined while reading; null when the browser's data can't be read yet (Safari without Full Disk Access).
  const [preview, setPreview] = useState<ImportPreview | null | undefined>(undefined)
  const [choice, setChoice] = useState({ tabs: true, favorites: true, history: true })
  const [running, setRunning] = useState(false)
  const [imported, setImported] = useState<Record<string, ImportCounts>>({})
  const [error, setError] = useState('')
  const [recheck, setRecheck] = useState(0)

  useEffect(() => {
    void api.importer.sources().then((list) => {
      setSources(list)
      setSelected((current) => current ?? list[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!selected) return
    let current = true
    setPreview(undefined)
    setError('')
    api.importer
      .preview(selected)
      .then((p) => current && setPreview(p))
      .catch(() => current && setPreview(null))
    return () => {
      current = false
    }
  }, [selected, recheck])

  const source = sources?.find((s) => s.id === selected)
  const done = selected ? imported[selected] : undefined
  const anyImported = Object.keys(imported).length > 0
  const chosen = (key: keyof typeof choice): boolean => !!preview && choice[key] && preview[key] > 0
  const canImport = !done && (chosen('tabs') || chosen('favorites') || chosen('history'))

  const run = async (): Promise<void> => {
    if (!selected || !preview) return
    setRunning(true)
    setError('')
    try {
      const counts = await api.importer.run(selected, { tabs: chosen('tabs'), favorites: chosen('favorites'), history: chosen('history') })
      setImported((prev) => ({ ...prev, [selected]: counts }))
    } catch {
      setError("Couldn't import. Quit the other browser and try again.")
    } finally {
      setRunning(false)
    }
  }

  let details: ReactNode = null
  if (source && done) {
    details = (
      <div className="intro-import-done">
        <span className="intro-done-check small">
          <Check size={16} strokeWidth={3} />
        </span>
        <div>
          <strong>Imported from {source.browser}</strong>
          <span>{importSummary(done)}</span>
        </div>
      </div>
    )
  } else if (source && preview === undefined) {
    details = (
      <div className="intro-import-reading">
        <span className="spinner" />
        Looking at {source.browser}…
      </div>
    )
  } else if (source && preview === null) {
    const safari = source.kind === 'safari'
    details = (
      <div className="intro-import-locked">
        <Lock size={16} />
        <div>
          <strong>{safari ? `macOS keeps ${source.browser}'s data private` : `Couldn't open ${source.browser}'s data`}</strong>
          <span>
            {safari
              ? 'To import it, turn on Tabs in Privacy & Security › Full Disk Access, then quit and reopen Tabs.'
              : `Quit ${source.browser} and try again.`}
          </span>
          <div className="intro-locked-actions">
            {safari && (
              <button className="intro-secondary small" onClick={() => api.importer.openAccessSettings()}>
                Open System Settings
              </button>
            )}
            <button className="intro-link" onClick={() => setRecheck((n) => n + 1)}>
              {safari ? 'Check again' : 'Try again'}
            </button>
          </div>
        </div>
      </div>
    )
  } else if (source && preview) {
    const rows = [
      {
        key: 'tabs' as const,
        icon: <Layers size={16} />,
        label: 'Open tabs',
        detail: !preview.tabs
          ? 'No open tabs'
          : preview.tabsFound > preview.tabs
            ? `The first ${preview.tabs} of ${preview.tabsFound.toLocaleString()}`
            : plural(preview.tabs, 'tab', 'tabs'),
        count: preview.tabs
      },
      {
        key: 'favorites' as const,
        icon: <Star size={16} />,
        label: 'Favorites',
        detail: !preview.favorites
          ? 'Nothing new on the bookmarks bar'
          : preview.favoritesFound > preview.favorites
            ? `The first ${preview.favorites} of ${preview.favoritesFound.toLocaleString()} on the bookmarks bar`
            : `${plural(preview.favorites, 'page', 'pages')} from the bookmarks bar`,
        count: preview.favorites
      },
      {
        key: 'history' as const,
        icon: <History size={16} />,
        label: 'History',
        detail: preview.history ? plural(preview.history, 'page', 'pages') : 'No history',
        count: preview.history
      }
    ]
    details = (
      <>
        <div className="intro-choices">
          {rows.map((r) => (
            <label key={r.key} className={cx('intro-choice', !r.count && 'empty')}>
              <span className="intro-choice-icon">{r.icon}</span>
              <span className="intro-choice-text">
                <strong>{r.label}</strong>
                <span>{r.detail}</span>
              </span>
              <input
                type="checkbox"
                className="intro-check"
                disabled={!r.count}
                checked={choice[r.key] && r.count > 0}
                onChange={(e) => setChoice((c) => ({ ...c, [r.key]: e.target.checked }))}
              />
            </label>
          ))}
        </div>
        <button className="intro-primary wide" disabled={!canImport || running} onClick={run}>
          {running ? 'Importing…' : `Import from ${source.browser}`}
        </button>
      </>
    )
  }

  const finish = mode === 'import' ? 'Done' : 'Continue'

  return (
    <>
      <h1>Bring everything with you</h1>
      <p className="intro-lede">
        Your open tabs come along, the bookmarks bar becomes your favorites, and your history lets the address bar
        finish what you type.
      </p>

      {sources === null ? (
        <span className="spinner intro-spinner" />
      ) : sources.length === 0 ? (
        <p className="intro-empty">No other browsers found on this computer.</p>
      ) : (
        <div className="intro-import">
          <div className="intro-sources" role="radiogroup">
            {sources.map((s) => (
              <button
                key={s.id}
                role="radio"
                aria-checked={s.id === selected}
                className={cx('intro-source', s.id === selected && 'selected')}
                onClick={() => setSelected(s.id)}
              >
                <BrowserIcon source={s} size={32} />
                <span className="intro-source-name">{sourceName(s)}</span>
                {imported[s.id] && (
                  <span className="intro-source-done">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="intro-import-details" key={selected}>
            {details}
            {error && <p className="intro-error">{error}</p>}
          </div>
        </div>
      )}

      <Footer onBack={onBack}>
        <button className={anyImported || mode === 'import' ? 'intro-primary' : 'intro-secondary'} onClick={onNext}>
          {anyImported || mode === 'import' ? finish : 'Skip for now'}
          {mode === 'setup' && <ArrowRight size={15} />}
        </button>
      </Footer>
    </>
  )
}

// ---- Done ----

function DoneStep({ onNext }: StepProps): ReactNode {
  const tips = [
    { icon: <Send size={18} />, title: 'Send a page', keys: shortcut('⌘⇧S', 'Ctrl+Shift+S'), text: 'Drops the page you’re on into a chat.' },
    { icon: <Star size={18} />, title: 'Keep it close', keys: shortcut('⌘D', 'Ctrl+D'), text: 'Favorites stay at the top of your tabs.' },
    { icon: <Search size={18} />, title: 'Go anywhere', keys: shortcut('⌘L', 'Ctrl+L'), text: 'Search your history, favorites and the web.' }
  ]
  return (
    <>
      <span className="intro-done-check">
        <Check size={34} strokeWidth={3} />
      </span>
      <h1>You're all set</h1>
      <p className="intro-lede">A few things to try first:</p>
      <div className="intro-tips">
        {tips.map((t, i) => (
          <div key={t.title} className="intro-tip" style={{ animationDelay: `${120 + i * 80}ms` }}>
            <span className="intro-tip-icon">{t.icon}</span>
            <strong>{t.title}</strong>
            <kbd>{t.keys}</kbd>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <button className="intro-primary big" autoFocus onClick={onNext}>
        Start browsing
      </button>
    </>
  )
}

// ---- Palettes (a picker in development builds, for choosing one) ----

interface Palette {
  name: string
  /** The two gradient colors, and the backdrop's third tint. */
  a: string
  b: string
  c: string
  /** Text on the gradients. */
  on: string
}

const PALETTES: Palette[] = [
  { name: 'Violet', a: '#8b5cf6', b: '#ec4899', c: '#3b82f6', on: '#fff' },
  { name: 'Ocean', a: '#3b82f6', b: '#06b6d4', c: '#6366f1', on: '#fff' },
  { name: 'Aurora', a: '#2dd4bf', b: '#818cf8', c: '#22c55e', on: '#04201c' },
  { name: 'Mint', a: '#34d399', b: '#a3e635', c: '#0ea5e9', on: '#03251a' },
  { name: 'Sunset', a: '#f97316', b: '#e11d48', c: '#a855f7', on: '#fff' },
  { name: 'Rose', a: '#ec4899', b: '#a855f7', c: '#fb7185', on: '#fff' },
  { name: 'Gold', a: '#fbbf24', b: '#f97316', c: '#6366f1', on: '#231500' },
  { name: 'Neon', a: '#a3e635', b: '#22d3ee', c: '#8b5cf6', on: '#0b1a05' },
  { name: 'Graphite', a: '#f4f4f5', b: '#a1a1aa', c: '#52525b', on: '#09090b' }
]

const PALETTE_KEY = 'browserr.introPalette'

function paletteStyle(p: Palette): CSSProperties {
  return { '--intro-a': p.a, '--intro-b': p.b, '--intro-c': p.c, '--intro-on': p.on } as CSSProperties
}

function PalettePicker({ value, onChange }: { value: Palette; onChange: (p: Palette) => void }): ReactNode {
  return (
    <div className="intro-palettes" title="Palette (development builds only)">
      <span className="intro-palettes-name">{value.name}</span>
      {PALETTES.map((p) => (
        <button
          key={p.name}
          className={cx('intro-swatch', p === value && 'active')}
          title={p.name}
          style={{ '--a': p.a, '--b': p.b } as CSSProperties}
          onClick={() => onChange(p)}
        />
      ))}
    </div>
  )
}

// ---- The intro ----

export function Intro({ mode, onClose }: { mode: IntroMode; onClose: () => void }): ReactNode {
  const { user, profile } = useSocial()
  const [step, setStep] = useState<Step>(mode === 'import' ? 'import' : 'welcome')
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [palette, setPalette] = useState<Palette | null>(() =>
    import.meta.env.DEV ? (PALETTES.find((p) => p.name === localStorage.getItem(PALETTE_KEY)) ?? PALETTES[0]) : null
  )
  const pickPalette = (p: Palette): void => {
    localStorage.setItem(PALETTE_KEY, p.name)
    setPalette(p)
  }

  // Finding friends needs an account, so it's only there once you have one.
  const steps: Step[] =
    mode === 'import' ? ['import'] : ['welcome', 'account', ...(user && profile ? (['friends'] as const) : []), 'import', 'done']
  const index = Math.max(0, steps.indexOf(step))

  const go = (to: number): void => {
    if (to >= steps.length) return onClose()
    setDirection(to < index ? 'back' : 'forward')
    setStep(steps[Math.max(0, to)])
  }
  const next = (): void => go(index + 1)
  const back = (): void => go(index - 1)

  let content: ReactNode
  switch (step) {
    case 'welcome':
      content = <WelcomeStep onNext={next} />
      break
    case 'account':
      content = <AccountStep onNext={next} onBack={back} />
      break
    case 'friends':
      content = <FriendsStep onNext={next} onBack={back} />
      break
    case 'import':
      content = <ImportStep mode={mode} onNext={next} onBack={mode === 'setup' ? back : undefined} />
      break
    case 'done':
      content = <DoneStep onNext={next} />
      break
  }

  return (
    <div className={cx('intro', `intro-mode-${mode}`)} style={palette ? paletteStyle(palette) : undefined}>
      <div className="intro-backdrop" aria-hidden>
        <span className="intro-blob b1" />
        <span className="intro-blob b2" />
        <span className="intro-blob b3" />
      </div>
      {mode === 'import' && (
        <button className="intro-close" title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      )}
      <main className="intro-stage">
        <section key={step} className={cx('intro-card', `step-${step}`, direction)}>
          {content}
        </section>
      </main>
      {palette && <PalettePicker value={palette} onChange={pickPalette} />}
      {steps.length > 1 && (
        <nav className="intro-dots" aria-label="Setup steps">
          {steps.map((s, i) => (
            <span key={s} className={cx('intro-dot', i === index && 'active', i < index && 'past')} />
          ))}
        </nav>
      )}
    </div>
  )
}
