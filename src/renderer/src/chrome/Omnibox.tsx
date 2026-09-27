import { AlertTriangle, Lock, Search, Star } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Suggestion, TabState } from '@shared/types'
import { copyText, MENU_SEPARATOR, popupMenu } from '../ui/menu'
import { cx, shortcut } from '../ui/util'

/** How the address bar looks when you're not typing in it. */
function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/^(www\.)?([^/]+)\/$/, '$1$2')
}

interface Props {
  tab: TabState | null
  isBookmarked: boolean
}

export function Omnibox({ tab, isBookmarked }: Props): ReactNode {
  const api = window.browserr
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const suggestions = useRef<{ for: string; items: Suggestion[]; selected: number }>({ for: '', items: [], selected: 0 })
  const queryId = useRef(0)
  const blurTimer = useRef<number | undefined>(undefined)

  const tabUrl = tab?.url ?? ''

  // Show the page URL unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setText(focused ? tabUrl : displayUrl(tabUrl))
  }, [tabUrl, focused, dirty])

  // Switching tabs abandons whatever was typed.
  useEffect(() => {
    setDirty(false)
    hide()
  }, [tab?.id])

  useEffect(
    () =>
      api.onCommand((cmd) => {
        if (cmd.type !== 'focus-omnibox') return
        inputRef.current?.focus()
        inputRef.current?.select()
      }),
    []
  )

  useEffect(
    () =>
      api.omnibox.onPick((index) => {
        const item = suggestions.current.items[index]
        if (item) go(item.url)
      }),
    []
  )

  function showDropdown(): void {
    const rect = wrapRef.current?.getBoundingClientRect()
    const { items, selected } = suggestions.current
    if (!rect || !items.length) return hide()
    api.omnibox.show(items, selected, { x: rect.left, y: rect.bottom + 4, width: rect.width, height: 0 })
  }

  function hide(): void {
    suggestions.current = { for: '', items: [], selected: 0 }
    api.omnibox.hide()
  }

  function go(target: string): void {
    hide()
    setDirty(false)
    api.nav.go(target)
    inputRef.current?.blur()
  }

  function onChange(value: string): void {
    setText(value)
    setDirty(true)
    const id = ++queryId.current
    if (!value.trim()) return hide()
    void api.omnibox.query(value).then((items) => {
      if (id !== queryId.current) return
      suggestions.current = { for: value, items, selected: 0 }
      showDropdown()
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    const s = suggestions.current
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && s.items.length) {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      s.selected = (s.selected + delta + s.items.length) % s.items.length
      setText(s.items[s.selected].type === 'search' || s.items[s.selected].type === 'suggest' ? s.items[s.selected].title : s.items[s.selected].url)
      showDropdown()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Suggestions may still be for an older keystroke; fall back to exactly what was typed.
      const item = s.for && s.items[s.selected]
      const target = item && (s.selected > 0 || s.for === text) ? item.url : text
      if (e.altKey || e.metaKey || e.ctrlKey) {
        hide()
        setDirty(false)
        api.tabs.create(target)
        inputRef.current?.blur()
      } else {
        go(target)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (s.items.length) return hide()
      setDirty(false)
      setText(tabUrl)
      inputRef.current?.select()
    }
  }

  const internalPage = !tab || tab.internal
  const SecurityIcon = !tabUrl || internalPage ? Search : tab?.secure ? Lock : AlertTriangle

  return (
    <div ref={wrapRef} className={cx('omnibox', focused && 'focused')}>
      <button
        className={cx('omnibox-icon', !tab?.secure && tabUrl && !internalPage && 'insecure')}
        tabIndex={-1}
        title={internalPage ? undefined : tab?.secure ? 'Connection is secure' : 'Not secure'}
        onClick={() => !internalPage && api.siteInfoMenu()}
      >
        <SecurityIcon size={14} strokeWidth={2} />
      </button>
      <input
        ref={inputRef}
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder="Search or enter address"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          const page = !internalPage && tabUrl
          void popupMenu([
            { role: 'undo' },
            { role: 'redo' },
            MENU_SEPARATOR,
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { label: 'Paste and Go', run: () => api.nav.pasteAndGo() },
            { role: 'selectAll' },
            ...(page
              ? [
                  MENU_SEPARATOR,
                  { label: 'Copy Page Address', run: () => copyText(tabUrl) },
                  { label: 'Send Page to a Friend…', run: () => api.share.openPicker() }
                ]
              : [])
          ])
        }}
        onFocus={() => {
          window.clearTimeout(blurTimer.current)
          setFocused(true)
          if (!dirty) setText(tabUrl)
          requestAnimationFrame(() => inputRef.current?.select())
        }}
        onBlur={() => {
          setFocused(false)
          // Give a click in the dropdown time to register before closing it.
          blurTimer.current = window.setTimeout(() => {
            api.omnibox.hide()
            setDirty(false)
          }, 150)
        }}
      />
      {tab && tab.zoomPercent !== 100 && (
        <button className="omnibox-chip" title="Reset zoom" onClick={() => api.nav.resetZoom()}>
          {tab.zoomPercent}%
        </button>
      )}
      {!internalPage && tabUrl && (
        <button
          className={cx('omnibox-star', isBookmarked && 'on')}
          title={`${isBookmarked ? 'Remove bookmark' : 'Bookmark this page'} (${shortcut('⌘D', 'Ctrl+D')})`}
          onClick={() => api.bookmarks.toggleCurrent()}
        >
          <Star size={15} strokeWidth={2} fill={isBookmarked ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
}
