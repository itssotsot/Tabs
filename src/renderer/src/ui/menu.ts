import type { MenuSpec } from '@shared/api'

/** A menu item with the code to run when it's clicked. */
export interface MenuItem extends Omit<MenuSpec, 'id' | 'submenu'> {
  run?: () => void
  submenu?: MenuItem[]
}

export const MENU_SEPARATOR: MenuItem = { type: 'separator' }

/** Shows a native menu at the pointer and runs the handler of the item that was clicked. */
export async function popupMenu(items: MenuItem[]): Promise<void> {
  const handlers = new Map<string, () => void>()
  const toSpecs = (list: MenuItem[]): MenuSpec[] =>
    list.map(({ run, submenu, ...spec }) => {
      if (submenu) return { ...spec, submenu: toSpecs(submenu) }
      if (!run) return spec
      const id = String(handlers.size)
      handlers.set(id, run)
      return { ...spec, id }
    })
  const chosen = await window.browserr.showMenu(toSpecs(items))
  if (chosen) handlers.get(chosen)?.()
}

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {})
}

/** The text selected inside `el`, if any. */
export function selectionIn(el: Element): string {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return ''
  return sel.toString().trim()
}
