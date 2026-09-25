import { Search, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { HistoryEntry } from '@shared/types'
import { prettyUrl } from '@shared/url'
import { siteIcon } from '../ui/util'

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function HistoryPage(): ReactNode {
  const api = window.browserrInternal
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  const load = (q: string): void => void api.history(q, 500).then(setEntries)

  useEffect(() => {
    const timer = setTimeout(() => load(query), 120)
    return () => clearTimeout(timer)
  }, [query])

  const groups: { label: string; items: HistoryEntry[] }[] = []
  for (const e of entries) {
    const label = dayLabel(e.lastVisit)
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] })
    groups.at(-1)!.items.push(e)
  }

  return (
    <main className="page">
      <header className="page-head">
        <h1>History</h1>
        <button
          className="danger-btn"
          disabled={!entries.length}
          onClick={async () => {
            if (!confirm('Clear all browsing history?')) return
            await api.clearHistory()
            load(query)
          }}
        >
          <Trash2 size={15} />
          Clear history
        </button>
      </header>
      <label className="page-search">
        <Search size={16} />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search history" />
      </label>

      {!entries.length && <p className="empty">{query ? 'No matches.' : 'Pages you visit show up here.'}</p>}

      {groups.map((g) => (
        <section key={g.label} className="card">
          <h2>{g.label}</h2>
          {g.items.map((e) => (
            <div key={e.url} className="row">
              <span className="row-time">
                {new Date(e.lastVisit).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </span>
              <img className="row-icon" src={siteIcon(e.url)} alt="" />
              <a className="row-title" href={e.url} title={e.url}>
                {e.title}
              </a>
              <span className="row-url">{prettyUrl(e.url)}</span>
              <button
                className="row-remove"
                title="Remove from history"
                onClick={async () => {
                  await api.removeHistory(e.url)
                  setEntries((list) => list.filter((x) => x.url !== e.url))
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </main>
  )
}
