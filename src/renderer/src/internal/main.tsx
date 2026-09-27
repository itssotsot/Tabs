import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/internal.css'
import { BookmarksPage } from './BookmarksPage'
import { ErrorPage } from './ErrorPage'
import { ExtensionsPage } from './ExtensionsPage'
import { HistoryPage } from './HistoryPage'
import { NewTabPage } from './NewTabPage'
import { SettingsPage } from './SettingsPage'

const PAGES: Record<string, { title: string; render: () => ReactNode }> = {
  newtab: { title: 'New Tab', render: () => <NewTabPage /> },
  history: { title: 'History', render: () => <HistoryPage /> },
  bookmarks: { title: 'Bookmarks', render: () => <BookmarksPage /> },
  settings: { title: 'Settings', render: () => <SettingsPage /> },
  extensions: { title: 'Extensions', render: () => <ExtensionsPage /> },
  error: { title: '', render: () => <ErrorPage /> }
}

const page = PAGES[location.hostname] ?? PAGES.newtab
if (page.title) document.title = page.title

createRoot(document.getElementById('root')!).render(<StrictMode>{page.render()}</StrictMode>)
