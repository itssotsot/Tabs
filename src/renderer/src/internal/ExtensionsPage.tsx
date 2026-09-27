import { Pin, PinOff, Puzzle, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ExtensionInfo } from '@shared/types'

function ExtensionRow({ ext, onChange }: { ext: ExtensionInfo; onChange: (list: ExtensionInfo[]) => void }): ReactNode {
  const api = window.browserrInternal

  return (
    <div className="setting extension">
      {ext.icon ? <img className="extension-icon" src={ext.icon} alt="" /> : <Puzzle className="extension-icon" size={28} />}
      <span className="setting-text">
        <strong>
          {ext.name} <span className="extension-version">{ext.version}</span>
        </strong>
        {ext.description && <span>{ext.description}</span>}
        {ext.shortcuts.length > 0 && (
          <span className="extension-shortcuts">
            {ext.shortcuts.map((s) => (
              <span key={s.shortcut}>
                <kbd>{s.shortcut}</kbd> {s.description}
              </span>
            ))}
          </span>
        )}
        {ext.error && <span className="extension-error">{ext.error}</span>}
      </span>
      <span className="extension-actions">
        {ext.enabled && !ext.error && (
          <button
            className="row-remove"
            title={ext.pinned ? 'Hide from toolbar' : 'Show in toolbar'}
            onClick={async () => onChange(await api.setExtensionPinned(ext.id, !ext.pinned))}
          >
            {ext.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
        )}
        {ext.optionsUrl && ext.enabled && !ext.error && (
          <button className="row-remove" title="Options" onClick={() => void api.openExtensionOptions(ext.id)}>
            <Settings2 size={15} />
          </button>
        )}
        <button
          className="row-remove"
          title="Remove"
          onClick={async () => {
            if (confirm(`Remove “${ext.name}”?`)) onChange(await api.removeExtension(ext.id))
          }}
        >
          <Trash2 size={15} />
        </button>
        <input
          type="checkbox"
          className="switch"
          aria-label={`Turn ${ext.name} ${ext.enabled ? 'off' : 'on'}`}
          checked={ext.enabled}
          onChange={async (e) => onChange(await api.setExtensionEnabled(ext.id, e.target.checked))}
        />
      </span>
    </div>
  )
}

export function ExtensionsPage(): ReactNode {
  const api = window.browserrInternal
  const [extensions, setExtensions] = useState<ExtensionInfo[] | null>(null)

  useEffect(() => {
    const load = (): void => void api.extensions().then(setExtensions)
    load()
    // Extensions added from the Web Store in another tab show up when you come back.
    const onVisible = (): void => {
      if (!document.hidden) load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  if (!extensions) return null

  return (
    <main className="page">
      <header className="page-head">
        <h1>Extensions</h1>
        <button className="primary-btn" onClick={() => void api.openWebStore()}>
          Chrome Web Store
        </button>
      </header>
      <p className="page-note">Add extensions from the Chrome Web Store. Pinned ones get a button in the toolbar; the rest are in the extensions menu.</p>
      {!extensions.length ? (
        <p className="empty">No extensions yet.</p>
      ) : (
        <section className="card">
          {extensions.map((ext) => (
            <ExtensionRow key={ext.id} ext={ext} onChange={setExtensions} />
          ))}
        </section>
      )}
    </main>
  )
}
