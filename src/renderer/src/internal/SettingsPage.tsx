import { useEffect, useState, type ReactNode } from 'react'
import type { AppInfo, SearchEngine, Settings } from '@shared/types'
import { SEARCH_ENGINE_NAMES } from '@shared/url'

function Toggle({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <label className="setting">
      <span className="setting-text">
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function SettingsPage(): ReactNode {
  const api = window.browserrInternal
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.appInfo().then(setInfo)
  }, [])

  if (!settings) return null

  const update = async (patch: Partial<Settings>): Promise<void> => setSettings(await api.setSettings(patch))

  return (
    <main className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="card">
        <h2>General</h2>
        <label className="setting">
          <span className="setting-text">
            <strong>Search engine</strong>
            <span>Used by the address bar and the new tab page.</span>
          </span>
          <select value={settings.searchEngine} onChange={(e) => void update({ searchEngine: e.target.value as SearchEngine })}>
            {Object.entries(SEARCH_ENGINE_NAMES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Toggle
          label="Reopen tabs on startup"
          detail="Pick up where you left off."
          checked={settings.restoreSession}
          onChange={(v) => void update({ restoreSession: v })}
        />
        <Toggle
          label="Memory Saver"
          detail="Pause tabs you haven't used for 5 minutes and unload them after 30. They come back when you open them. Tabs playing audio, pinned tabs and sites that send you notifications stay awake."
          checked={settings.memorySaver}
          onChange={(v) => void update({ memorySaver: v })}
        />
        <Toggle
          label="Show bookmarks bar"
          checked={settings.showBookmarksBar}
          onChange={(v) => void update({ showBookmarksBar: v })}
        />
        {info && (
          <div className="setting">
            <span className="setting-text">
              <strong>Default browser</strong>
              <span>{info.isDefaultBrowser ? 'Browserr is your default browser.' : 'Open links from other apps in Browserr.'}</span>
            </span>
            {!info.isDefaultBrowser && (
              <button
                className="secondary-btn"
                onClick={async () => {
                  await api.makeDefaultBrowser()
                  setInfo(await api.appInfo())
                }}
              >
                Make default
              </button>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <Toggle
          label="Block ads and trackers"
          detail="Uses EasyList, EasyPrivacy and uBlock Origin filter lists."
          checked={settings.adblock}
          onChange={(v) => void update({ adblock: v })}
        />
        <div className="setting">
          <span className="setting-text">
            <strong>Clear browsing data</strong>
            <span>History, cookies, cache and site permissions. Your friends and links are not affected.</span>
          </span>
          <button
            className="danger-btn"
            onClick={async () => {
              if (!confirm('Clear all browsing data? You will be signed out of websites.')) return
              await api.clearBrowsingData()
              setCleared(true)
            }}
          >
            {cleared ? 'Cleared' : 'Clear data'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Sharing</h2>
        <Toggle
          label="Notifications"
          detail="Get notified when a friend sends you a link or reacts to one of yours."
          checked={settings.notifications}
          onChange={(v) => void update({ notifications: v })}
        />
      </section>

      {info && (
        <p className="about">
          {info.name} {info.version} · Chromium {info.chrome} · Electron {info.electron}
        </p>
      )}
    </main>
  )
}
