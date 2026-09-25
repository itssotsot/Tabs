import { Clock, Globe, Search, Star } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Suggestion } from '@shared/types'
import { prettyUrl } from '@shared/url'
import { cx } from '../ui/util'

const ICONS = { url: Globe, search: Search, suggest: Search, history: Clock, bookmark: Star }

export function Suggestions({ items, selected }: { items: Suggestion[]; selected: number }): ReactNode {
  return (
    <div className="suggestions" role="listbox">
      {items.map((item, i) => {
        const Icon = ICONS[item.type]
        const showUrl = item.type === 'history' || item.type === 'bookmark'
        return (
          <div
            key={`${item.type}:${item.url}`}
            role="option"
            aria-selected={i === selected}
            className={cx('suggestion', i === selected && 'selected')}
            // mousedown, not click: the address bar blurs (and hides this list) on mouseup.
            onMouseDown={(e) => {
              e.preventDefault()
              window.browserr.overlay.pick(i)
            }}
          >
            <Icon size={15} className="suggestion-icon" />
            <span className="suggestion-title">{item.type === 'url' ? prettyUrl(item.url) : item.title}</span>
            {showUrl && <span className="suggestion-url">— {prettyUrl(item.url)}</span>}
            {item.type === 'search' && <span className="suggestion-url">— Search</span>}
          </div>
        )
      })}
    </div>
  )
}
