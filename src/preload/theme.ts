import { ipcRenderer } from 'electron'
import { IPC } from '@shared/api'

/** Puts the theme on the page's root element (`data-theme`) before it first draws, and keeps it current. */
export function followTheme(): void {
  let theme: unknown = ipcRenderer.sendSync(IPC.themeGet)
  const apply = (): void => {
    const root = document.documentElement
    if (root && typeof theme === 'string') root.dataset.theme = theme
  }
  // Preloads run before the parser has made the root element; it's there by the first style and paint.
  if (document.documentElement) apply()
  else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return
      observer.disconnect()
      apply()
    })
    observer.observe(document, { childList: true })
  }
  ipcRenderer.on(IPC.themeChanged, (_e, next) => {
    theme = next
    apply()
  })
}
