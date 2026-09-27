import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type {
  Bookmark,
  DownloadState,
  ExtensionPanelInfo,
  FindState,
  PageEdge,
  Settings,
  SidebarPanel,
  TabLayout,
  ToolbarExtension,
  UpdateReady,
  WindowState
} from '@shared/types'
import { cx } from '../ui/util'
import { FindBar } from './FindBar'
import { Intro, type IntroMode } from './intro/Intro'
import { Sidebar } from './Sidebar'
import { GroupsStrip } from './tabs/GroupsStrip'
import { LinksProvider } from './tabs/links'
import { Overview } from './tabs/Overview'
import { VerticalTabs } from './tabs/VerticalTabs'
import { Toolbar } from './Toolbar'

const EMPTY_STATE: WindowState = {
  tabs: [],
  activeTabId: null,
  htmlFullscreen: false,
  fullscreen: false,
  isBookmarked: false,
  profile: null,
  groupNames: {},
  groupColors: {}
}

/**
 * Puts the toolbar's colors on the header: the page's main color, and its top edge as a gradient. The
 * gradient spans only the page, which ends where an open sidebar begins; each color sits in the middle of the
 * column it was read from. Null clears them.
 */
function applyPageEdge(header: HTMLElement, color: string | null, edge: string[] | null, sidebarWidth: number): void {
  const set = (name: string, value: string | null): void => {
    if (value) header.style.setProperty(name, value)
    else header.style.removeProperty(name)
  }
  const stops = color && edge?.map((c, i) => `${c} ${(((i + 0.5) / edge.length) * 100).toFixed(2)}%`)
  set('--page', color)
  set('--page-edge', stops ? `linear-gradient(to right, ${stops.join(', ')})` : null)
  set('--page-edge-width', color && sidebarWidth ? `calc(100% - ${sidebarWidth}px)` : null)
}

export function App(): ReactNode {
  const api = window.browserr
  const [state, setState] = useState<WindowState>(EMPTY_STATE)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [downloads, setDownloads] = useState<DownloadState[]>([])
  const [update, setUpdate] = useState<UpdateReady | null>(null)
  const [sidebar, setSidebar] = useState<SidebarPanel | null>(null)
  const [find, setFind] = useState<FindState>({ open: false, matches: 0, activeMatch: 0 })
  const [findOpen, setFindOpen] = useState(false)
  const [findFocus, setFindFocus] = useState(0)
  const [findNext, setFindNext] = useState<{ forward: boolean; token: number } | null>(null)
  // Lives here so the open room survives switching sidebar tabs.
  const [roomId, setRoomId] = useState<string | null>(null)
  const [overview, setOverview] = useState(false)
  const [extensions, setExtensions] = useState<ToolbarExtension[]>([])
  const [extensionPanel, setExtensionPanel] = useState<ExtensionPanelInfo | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(0)
  const [intro, setIntro] = useState<IntroMode | null>(() => (api.intro.pending() ? 'setup' : null))

  const headerRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  const layout: TabLayout = settings?.tabLayout ?? 'vertical'

  useEffect(() => {
    const offs = [
      api.onWindowState(setState),
      api.bookmarks.onChanged(setBookmarks),
      api.settings.onChanged(setSettings),
      api.downloads.onChanged(setDownloads),
      api.updates.onChanged(setUpdate),
      api.extensions.onToolbar(setExtensions),
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
          case 'open-room':
            setSidebar('inbox')
            setRoomId(cmd.roomId)
            break
          case 'open-find':
            setFindOpen(true)
            setFindFocus((n) => n + 1)
            break
          case 'find-next':
            setFindOpen(true)
            setFindNext((prev) => ({ forward: cmd.forward, token: (prev?.token ?? 0) + 1 }))
            break
          case 'toggle-tab-overview':
            setOverview((open) => !open)
            break
          case 'open-extension-panel':
            setExtensionPanel(cmd.panel)
            setSidebar('extension')
            break
          case 'close-extension-panel':
            setSidebar((current) => (current === 'extension' ? null : current))
            break
          case 'show-import':
            setIntro((current) => current ?? 'import')
            break
          case 'intro-finished':
            setIntro((current) => (current === 'setup' ? null : current))
            break
        }
      })
    ]
    void api.bookmarks.list().then(setBookmarks)
    void api.settings.get().then(setSettings)
    void api.downloads.list().then(setDownloads)
    void api.updates.get().then(setUpdate)
    void api.extensions.get().then(setExtensions)
    return () => offs.forEach((off) => off())
  }, [])

  // Tell the main process where the page should go. The tab overview and the intro take the page's place.
  useLayoutEffect(() => {
    const report = (): void => {
      const sidebarWidth = Math.round(sidebarRef.current?.getBoundingClientRect().width ?? 0)
      setSidebarWidth(sidebarWidth)
      api.setInsets({
        top: overview || intro ? window.innerHeight : Math.round(headerRef.current?.getBoundingClientRect().height ?? 0),
        right: sidebarWidth,
        left: Math.round(tabsRef.current?.getBoundingClientRect().width ?? 0)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    if (headerRef.current) observer.observe(headerRef.current)
    if (sidebarRef.current) observer.observe(sidebarRef.current)
    if (tabsRef.current) observer.observe(tabsRef.current)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [sidebar, layout, overview, intro])

  // Switching the active tab from elsewhere (keyboard, the page) means you're done looking.
  const activeTabId = state.activeTabId
  useEffect(() => setOverview(false), [activeTabId])

  // The toolbar extends the top of the page upward, so it reads as part of the site. While you scroll,
  // the colors change many times a second, so they come on their own and go straight onto the header, without
  // re-rendering the browser UI. The tab's state has them too, for when you switch tabs.
  const activeTab = state.tabs.find((t) => t.id === activeTabId)
  const liveEdge = useRef<PageEdge | null>(null)
  const paintEdge = useRef<() => void>(() => {})
  paintEdge.current = () => {
    const header = headerRef.current
    if (!header) return
    const live = liveEdge.current?.tabId === activeTabId ? liveEdge.current : null
    const color = live?.color ?? activeTab?.color ?? null
    applyPageEdge(header, color, live?.edge ?? activeTab?.edge ?? null, sidebarWidth)
  }
  useLayoutEffect(() => {
    liveEdge.current = null
  }, [activeTabId])
  useLayoutEffect(() => paintEdge.current(), [activeTabId, activeTab?.color, activeTab?.edge, sidebarWidth])
  useEffect(
    () =>
      api.onPageEdge((edge) => {
        liveEdge.current = edge
        paintEdge.current()
      }),
    []
  )

  const closeIntro = (): void => {
    if (intro === 'setup') api.intro.finish()
    setIntro(null)
  }

  const toggleSidebar = (panel: SidebarPanel): void => setSidebar((current) => (current === panel ? null : panel))
  const openRoom = (id: string): void => {
    setSidebar('inbox')
    setRoomId(id)
  }

  return (
    <LinksProvider tabs={state.tabs} bookmarks={bookmarks}>
      <div className={cx('chrome', `layout-${layout}`, settings?.showTabAge && 'show-tab-age', settings?.showGroupLines && 'show-group-lines')}>
        {layout === 'vertical' && <VerticalTabs ref={tabsRef} state={state} layout={layout} onOpenRoom={openRoom} />}
        <div className="chrome-main">
          <header ref={headerRef} className="chrome-header">
            {layout === 'groups' && <GroupsStrip state={state} layout={layout} onOpenRoom={openRoom} />}
            <Toolbar
              state={state}
              downloads={downloads}
              update={update}
              sidebar={sidebar}
              onToggleSidebar={toggleSidebar}
              extensions={extensions}
            />
            {findOpen && (
              <FindBar result={find} focusToken={findFocus} nextRequest={findNext} onClose={() => setFindOpen(false)} />
            )}
          </header>
          <div className="chrome-body">
            {overview ? <Overview state={state} onClose={() => setOverview(false)} /> : <div className="viewport" />}
            {sidebar && (
              <aside ref={sidebarRef} className="sidebar">
                <Sidebar
                  panel={sidebar}
                  onPanel={setSidebar}
                  onClose={() => setSidebar(null)}
                  downloads={downloads}
                  roomId={roomId}
                  onRoom={setRoomId}
                  extensionPanel={extensionPanel}
                />
              </aside>
            )}
          </div>
        </div>
      </div>
      {intro && <Intro mode={intro} onClose={closeIntro} />}
    </LinksProvider>
  )
}
