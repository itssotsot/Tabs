import { dialog, Menu, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { Rect } from '@shared/types'
import { INTERNAL_SCHEME } from '@shared/url'
import type { BrowserWindowController } from '../window'
import { loadedExtension, manifestOf } from './access'
import { activateAction, isPinned, setPinned, toolbarFor } from './api/action'
import { extensionActionMenuItems } from './api/context-menus'
import { extensionOptionsUrl, removeExtension, WEB_STORE_URL } from './manager'

/** The menus for the extension buttons in the toolbar. */

function icon16(dataUrl: string | null): NativeImage | undefined {
  if (!dataUrl) return undefined
  const image = nativeImage.createFromDataURL(dataUrl)
  return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16, quality: 'best' })
}

const escape = (label: string): string => label.replace(/&/g, '&&')

function openExtensionsPage(c: BrowserWindowController): void {
  c.createTab(`${INTERNAL_SCHEME}://extensions/`)
}

async function confirmRemove(c: BrowserWindowController, id: string, name: string): Promise<void> {
  const { response } = await dialog.showMessageBox(c.win, {
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Remove “${name}”?`
  })
  if (response === 0) await removeExtension(id)
}

/** Right-click on an extension's toolbar button. */
export function showExtensionContextMenu(c: BrowserWindowController, id: string): void {
  if (!loadedExtension(id)) return
  const entry = toolbarFor(c).find((e) => e.id === id)
  const name = entry?.name ?? id
  const actionItems = manifestOf(id)?.action !== undefined ? extensionActionMenuItems(id, c) : []
  const options = extensionOptionsUrl(id)
  const items: MenuItemConstructorOptions[] = [
    { label: escape(name), enabled: false, icon: icon16(entry?.icon ?? null) },
    { type: 'separator' },
    ...actionItems,
    ...(actionItems.length ? [{ type: 'separator' } as const] : []),
    ...(options ? [{ label: 'Options', click: () => c.createTab(options) }] : []),
    { label: isPinned(id) ? 'Unpin' : 'Pin to toolbar', click: () => setPinned(id, !isPinned(id)) },
    { label: 'Remove from Tabs…', click: () => void confirmRemove(c, id, name) },
    { type: 'separator' },
    { label: 'Manage extensions', click: () => openExtensionsPage(c) }
  ]
  Menu.buildFromTemplate(items).popup({ window: c.win })
}

/** The extensions (puzzle) button: every extension, and which ones stay in the toolbar. */
export function showExtensionsMenu(c: BrowserWindowController, anchor: Rect): void {
  const list = toolbarFor(c)
  const items: MenuItemConstructorOptions[] = list.length
    ? [
        ...list.map(
          (e): MenuItemConstructorOptions => ({
            label: escape(e.name),
            icon: icon16(e.icon),
            enabled: e.enabled,
            click: () => activateAction(c, e.id, anchor)
          })
        ),
        { type: 'separator' },
        {
          label: 'Keep in toolbar',
          submenu: list.map((e) => ({ label: escape(e.name), type: 'checkbox' as const, checked: e.pinned, click: () => setPinned(e.id, !e.pinned) }))
        },
        { label: 'Manage extensions', click: () => openExtensionsPage(c) }
      ]
    : [
        { label: 'No extensions yet', enabled: false },
        { type: 'separator' },
        { label: 'Chrome Web Store', click: () => c.createTab(WEB_STORE_URL) }
      ]
  Menu.buildFromTemplate(items).popup({ window: c.win, x: Math.round(anchor.x), y: Math.round(anchor.y + anchor.height + 4) })
}
