import { Puzzle } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { Rect, ToolbarExtension } from '@shared/types'

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/** Buttons for pinned extensions, and the extensions menu for the rest. */
export function ExtensionButtons({ extensions }: { extensions: ToolbarExtension[] }): ReactNode {
  const api = window.browserr
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const menuButton = useRef<HTMLButtonElement>(null)

  // A shortcut or action.openPopup opens the popup from the extension's button (or the menu button if it isn't pinned).
  useEffect(
    () =>
      api.onCommand((cmd) => {
        if (cmd.type !== 'open-extension-popup') return
        const el = buttons.current.get(cmd.extensionId) ?? menuButton.current
        if (el) api.extensions.activate(cmd.extensionId, rectOf(el))
      }),
    []
  )

  if (!extensions.length) return null

  return (
    <div className="ext-buttons">
      {extensions
        .filter((e) => e.pinned)
        .map((e) => (
          <button
            key={e.id}
            ref={(el) => {
              if (el) buttons.current.set(e.id, el)
              else buttons.current.delete(e.id)
            }}
            className={e.enabled ? 'icon-btn ext-btn' : 'icon-btn ext-btn inactive'}
            title={e.title || e.name}
            onClick={(ev) => api.extensions.activate(e.id, rectOf(ev.currentTarget))}
            onContextMenu={(ev) => {
              ev.preventDefault()
              api.extensions.contextMenu(e.id)
            }}
          >
            {e.icon ? <img src={e.icon} width={16} height={16} alt="" draggable={false} /> : <Puzzle size={15} />}
            {e.badgeText && (
              <span className="ext-badge" style={{ background: e.badgeColor, color: e.badgeTextColor }}>
                {e.badgeText}
              </span>
            )}
          </button>
        ))}
      <button ref={menuButton} className="icon-btn" title="Extensions" onClick={(ev) => api.extensions.menu(rectOf(ev.currentTarget))}>
        <Puzzle size={16} />
      </button>
    </div>
  )
}
