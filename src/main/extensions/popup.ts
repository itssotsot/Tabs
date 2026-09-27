import { BrowserWindow, Menu } from 'electron'
import type { Rect } from '@shared/types'
import { webSession } from '../env'
import type { BrowserWindowController } from '../window'
import { registerSurface } from './router'

/**
 * An extension's popup: a borderless window under its toolbar button that sizes itself to the
 * page (between 25×25 and 800×600, like Chrome) and closes when it loses focus.
 */

const MIN = 25
const MAX_WIDTH = 800
const MAX_HEIGHT = 600

interface OpenPopup {
  win: BrowserWindow
  extensionId: string
}

let current: OpenPopup | null = null
/** When a popup last closed from losing focus, so clicking its button again closes it instead of reopening. */
let lastBlurClose: { extensionId: string; at: number } | null = null

export interface PopupRequest {
  controller: BrowserWindowController
  extensionId: string
  url: string
  /** The button, in the window's content coordinates. */
  anchor: Rect
  tabId: number
}

export function closeActionPopup(): void {
  const popup = current
  current = null
  if (popup && !popup.win.isDestroyed()) popup.win.close()
}

export function openActionPopup({ controller, extensionId, url, anchor, tabId }: PopupRequest): void {
  if (current?.extensionId === extensionId) return closeActionPopup()
  if (lastBlurClose?.extensionId === extensionId && Date.now() - lastBlurClose.at < 300) return
  closeActionPopup()

  const parent = controller.win
  const win = new BrowserWindow({
    parent,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    width: MIN,
    height: MIN,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: webSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      enablePreferredSizeMode: true
    }
  })
  const popup: OpenPopup = { win, extensionId }
  current = popup
  const wc = win.webContents
  registerSurface(wc, { type: 'POPUP', windowId: parent.id, tabId })

  const place = (width: number, height: number): void => {
    const content = parent.getContentBounds()
    const w = Math.max(MIN, Math.min(MAX_WIDTH, Math.ceil(width)))
    const h = Math.max(MIN, Math.min(MAX_HEIGHT, Math.ceil(height)))
    // Right edge under the button's right edge, like Chrome's toolbar popups; kept inside the window.
    const right = content.x + anchor.x + anchor.width
    const x = Math.max(content.x, Math.min(right - w, content.x + content.width - w))
    const y = content.y + anchor.y + anchor.height + 2
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h })
  }
  let sized = false
  const show = (): void => {
    if (win.isDestroyed() || win.isVisible()) return
    win.show()
    win.focus()
  }
  wc.on('preferred-size-changed', (_e, size) => {
    place(size.width, size.height)
    if (!sized) {
      sized = true
      show()
    }
  })
  wc.once('did-finish-load', () => setTimeout(show, 150))
  place(MIN, MIN)

  win.on('blur', () => {
    if (wc.isDevToolsOpened()) return
    lastBlurClose = { extensionId, at: Date.now() }
    if (current === popup) closeActionPopup()
    else if (!win.isDestroyed()) win.close()
  })
  win.on('closed', () => {
    if (current === popup) current = null
  })
  parent.once('closed', () => {
    if (!win.isDestroyed()) win.close()
  })
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      e.preventDefault()
      closeActionPopup()
    }
  })
  // Links and window.open from the popup open as tabs in its window.
  wc.setWindowOpenHandler(({ url: target }) => {
    controller.createTab(target)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, target) => {
    if (!target.startsWith(`chrome-extension://${extensionId}/`)) {
      e.preventDefault()
      controller.createTab(target)
      closeActionPopup()
    }
  })
  wc.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      {
        label: 'Inspect',
        click: () => {
          wc.openDevTools({ mode: 'detach' })
          wc.inspectElement(params.x, params.y)
        }
      }
    ]).popup({ window: win })
  })

  void wc.loadURL(url).catch(() => {})
}
