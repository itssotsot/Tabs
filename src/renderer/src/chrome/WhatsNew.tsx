import { Sparkles, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ChangelogEntry } from '@shared/changelog'
import { INTERNAL_SCHEME } from '@shared/url'
import { APP_VERSION, CHANGELOG, ChangelogText } from '../ui/changelog'

/** The version whose notes were last dismissed (or skipped, on a new install). Shared by every window. */
const SEEN_KEY = 'browserr.whatsNew.seen'
/** How many of the version's items the card lists; the rest are a click away. */
const SHOWN_ITEMS = 3

/** This version's notes, if they haven't been seen. A new install (the intro still to come) starts as seen. */
function unseenEntry(): ChangelogEntry | null {
  const seen = localStorage.getItem(SEEN_KEY)
  if (seen === APP_VERSION) return null
  if (seen === null && window.browserr.intro.pending()) {
    localStorage.setItem(SEEN_KEY, APP_VERSION)
    return null
  }
  return CHANGELOG.find((e) => e.version === APP_VERSION) ?? null
}

/**
 * Below the toolbar after an update: what's new in this version, until it's dismissed in any window.
 * Mounted from the start (hidden during the intro), so a new install is recognized before the intro finishes.
 */
export function WhatsNew({ hidden }: { hidden: boolean }): ReactNode {
  const [entry, setEntry] = useState(unseenEntry)

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === SEEN_KEY && e.newValue === APP_VERSION) setEntry(null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  if (!entry || hidden) return null

  const dismiss = (): void => {
    localStorage.setItem(SEEN_KEY, APP_VERSION)
    setEntry(null)
  }
  const more = entry.items.length - SHOWN_ITEMS

  return (
    <div className="whats-new" role="status">
      <Sparkles className="whats-new-icon" size={16} />
      <div className="whats-new-body">
        <strong>Tabs was updated to {entry.version}</strong>
        <ul>
          {entry.items.slice(0, SHOWN_ITEMS).map((item) => (
            <li key={item}>
              <ChangelogText text={item} />
            </li>
          ))}
        </ul>
        <div className="whats-new-actions">
          <button
            className="whats-new-link"
            onClick={() => {
              window.browserr.tabs.create(`${INTERNAL_SCHEME}://whats-new/`)
              dismiss()
            }}
          >
            {more > 0 ? `See all changes (${more} more)` : 'See all changes'}
          </button>
          <button className="whats-new-done" onClick={dismiss}>
            Got it
          </button>
        </div>
      </div>
      <button className="icon-btn small" title="Close" onClick={dismiss}>
        <X size={14} />
      </button>
    </div>
  )
}
