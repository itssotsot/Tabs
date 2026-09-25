import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Bookmark, DownloadState, FindState, Settings, SidebarPanel, WindowState } from '@shared/types'
import { BookmarksBar } from './BookmarksBar'
import { FindBar } from './FindBar'
import { Sidebar } from './Sidebar'
import { TabStrip } from './TabStrip'
import { Toolbar } from './Toolbar'

const EMPTY_STATE: WindowState = { tabs: [], activeTabId: null, htmlFullscreen: false, fullscreen: false, isBookmarked: false }

export function App(): ReactNode {
  const api = window.browserr
  const [state, setState] = useState<WindowState>(EMPTY_STATE)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [downloads, setDownloads] = useState<DownloadState[]>([])
  const [sidebar, setSidebar] = useState<SidebarPanel | null>(null)
  const [find, setFind] = useState<FindState>({ open: false, matches: 0, activeMatch: 0 })
  const [findOpen, setFindOpen] = useState(false)
  const [findFocus, setFindFocus] = useState(0)
  const [findNext, setFindNext] = useState<{ forward: boolean; token: number } | null>(null)

  const headerRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const offs = [
      api.onWindowState(setState),
      api.bookmarks.onChanged(setBookmarks),
      api.settings.onChanged(setSettings),
      api.downloads.onChanged(setDownloads),
      api.find.onState((s) => {
        setFind(s)
        if (!s.open) setFindOpen(false)
      }),
      api.onCommand((cmd) => {
        switch (cmd.type) {
          case 'toggle-sidebar':
            setSidebar((current) => (current ? null : (cmd.panel ?? 'inbox')))
            break
          case 'open-sidebar':
            setSidebar(cmd.panel)
            break
          case 'open-find':
            setFindOpen(true)
            setFindFocus((n) => n + 1)
            break
          case 'find-next':
            setFindOpen(true)
            setFindNext((prev) => ({ forward: cmd.forward, token: (prev?.token ?? 0) + 1 }))
            break
        }
      })
    ]
    void api.bookmarks.list().then(setBookmarks)
    void api.settings.get().then(setSettings)
    void api.downloads.list().then(setDownloads)
    return () => offs.forEach((off) => off())
  }, [])

  // Tell the main process where the page should go.
  useLayoutEffect(() => {
    const report = (): void => {
      api.setInsets({
        top: Math.round(headerRef.current?.getBoundingClientRect().height ?? 0),
        right: Math.round(sidebarRef.current?.getBoundingClientRect().width ?? 0)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    if (headerRef.current) observer.observe(headerRef.current)
    if (sidebarRef.current) observer.observe(sidebarRef.current)
    return () => observer.disconnect()
  }, [sidebar])

  const toggleSidebar = (panel: SidebarPanel): void => setSidebar((current) => (current === panel ? null : panel))
  const showBookmarksBar = !!settings?.showBookmarksBar && bookmarks.length > 0

  return (
    <div className="chrome">
      <header ref={headerRef} className="chrome-header">
        <TabStrip state={state} />
        <Toolbar state={state} downloads={downloads} sidebar={sidebar} onToggleSidebar={toggleSidebar} />
        {showBookmarksBar && <BookmarksBar bookmarks={bookmarks} />}
        {findOpen && (
          <FindBar result={find} focusToken={findFocus} nextRequest={findNext} onClose={() => setFindOpen(false)} />
        )}
      </header>
      <div className="chrome-body">
        <div className="viewport" />
        {sidebar && (
          <aside ref={sidebarRef} className="sidebar">
            <Sidebar panel={sidebar} onPanel={setSidebar} onClose={() => setSidebar(null)} downloads={downloads} />
          </aside>
        )}
      </div>
    </div>
  )
}
