import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { TAB_LAYOUTS } from '@shared/constants'
import type { AppInfo, SearchEngine, Settings, TabLayout } from '@shared/types'
import { INTERNAL_SCHEME, SEARCH_ENGINE_NAMES } from '@shared/url'

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
        <label className="setting">
          <span className="setting-text">
            <strong>Tab layout</strong>
            <span>{TAB_LAYOUTS.find((l) => l.id === settings.tabLayout)?.description}. You can also switch from View › Tab Layout.</span>
          </span>
          <select value={settings.tabLayout} onChange={(e) => void update({ tabLayout: e.target.value as TabLayout })}>
            {TAB_LAYOUTS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <Toggle
          label="Group tabs by site"
          detail="When two or more tabs are from the same site, like YouTube, they sit together in a group you can collapse. Right-click a group for more."
          checked={settings.groupTabsBySite}
          onChange={(v) => void update({ groupTabsBySite: v })}
        />
        <Toggle
          label="Show how long tabs have been open"
          detail="Each tab shows when you opened it, like 5m or 2h. Hover a tab for the exact time."
          checked={settings.showTabAge}
          onChange={(v) => void update({ showTabAge: v })}
        />
        <Toggle
          label="Show group colors on tabs"
          detail="Each tab in a group gets a line in the group's color: along the left in the sidebar, along the bottom in the tab bar."
          checked={settings.showGroupLines}
          onChange={(v) => void update({ showGroupLines: v })}
        />
        {settings.groupTabsBySite && settings.ungroupedSites.length > 0 && (
          <div className="setting">
            <span className="setting-text">
              <strong>Sites that aren't grouped</strong>
              <span>Click a site to group its tabs again.</span>
              <span className="site-chips">
                {settings.ungroupedSites.map((site) => (
                  <button
                    key={site}
                    className="site-chip"
                    title={`Group ${site} tabs again`}
                    onClick={() => void update({ ungroupedSites: settings.ungroupedSites.filter((s) => s !== site) })}
                  >
                    {site} <X size={12} />
                  </button>
                ))}
              </span>
            </span>
          </div>
        )}
        <Toggle
          label="Reopen tabs on startup"
          detail="Pick up where you left off."
          checked={settings.restoreSession}
          onChange={(v) => void update({ restoreSession: v })}
        />
        <Toggle
          label="Memory Saver"
          detail="Pause tabs you haven't used for 5 minutes and unload them after 30. They come back when you open them. Pinned tabs, tabs playing audio and sites that send you notifications stay awake."
          checked={settings.memorySaver}
          onChange={(v) => void update({ memorySaver: v })}
        />
        {info && (
          <div className="setting">
            <span className="setting-text">
              <strong>Default browser</strong>
              <span>{info.isDefaultBrowser ? 'Tabs is your default browser.' : 'Open links from other apps in Tabs.'}</span>
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
        <div className="setting">
          <span className="setting-text">
            <strong>Import from another browser</strong>
            <span>Bring over the bookmarks bar (as favorites) and history from Chrome, Safari, Firefox, Arc and others.</span>
          </span>
          <button className="secondary-btn" onClick={() => void api.openImport()}>
            Import…
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Extensions</h2>
        <div className="setting">
          <span className="setting-text">
            <strong>Chrome extensions</strong>
            <span>Add extensions from the Chrome Web Store, and turn them off or remove them.</span>
          </span>
          <button className="secondary-btn" onClick={() => (location.href = `${INTERNAL_SCHEME}://extensions/`)}>
            Manage
          </button>
        </div>
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
            <span>History, cookies, cache and site permissions. Your friends and chats are not affected.</span>
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
          detail="Get notified about new messages, friend requests and group invites."
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
