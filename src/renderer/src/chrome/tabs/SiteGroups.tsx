import { ChevronRight, Globe } from 'lucide-react'
import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { colorFor } from '@shared/colors'
import type { TabState, WindowState } from '@shared/types'
import { hostOf } from '@shared/url'
import { cx, siteIcon } from '../../ui/util'
import { useStoredState, type TabDrag } from './parts'

type Run = { tab: TabState } | { group: string; tabs: TabState[] }

/**
 * The site groups first, each with its tabs together, then the tabs in no group, all in strip order. A group
 * needs two of the tabs in `tabs`: a layout that shows some tabs elsewhere (in a chat's group) can leave a site with one.
 */
function siteRuns(tabs: TabState[]): Run[] {
  const members = new Map<string, TabState[]>()
  for (const tab of tabs) if (tab.group) members.set(tab.group, [...(members.get(tab.group) ?? []), tab])
  const groups: Run[] = []
  const loose: Run[] = []
  const placed = new Set<string>()
  for (const tab of tabs) {
    const group = tab.group && members.get(tab.group)!.length > 1 ? tab.group : null
    if (!group) loose.push({ tab })
    else if (!placed.has(group)) {
      placed.add(group)
      groups.push({ group, tabs: members.get(group)! })
    }
  }
  return [...groups, ...loose]
}

/** The site groups `tabs` shows as groups. */
export function siteGroups(tabs: TabState[]): string[] {
  return siteRuns(tabs).flatMap((run) => ('group' in run ? [run.group] : []))
}

/** Which site groups are collapsed, kept across restarts. */
export function useCollapsedSites(): [string[], (groups: string[]) => void] {
  return useStoredState<string[]>('browserr.tabs.collapsedSites', [])
}

/** The site's own icon: from one of its pages on the site itself (not, say, consent.youtube.com), else looked up. */
function GroupIcon({ group, tabs }: { group: string; tabs: TabState[] }): ReactNode {
  const [broken, setBroken] = useState<string | null>(null)
  const own = tabs.find((t) => t.favicon && hostOf(t.url) === group)
  const src = own?.favicon ?? siteIcon(`https://${group}/`)
  if (!src || broken === src) return <Globe className="favicon" size={14} strokeWidth={1.75} />
  return <img className="favicon" src={src} alt="" draggable={false} onError={() => setBroken(src)} />
}

interface Props {
  state: WindowState
  /** The tabs to show, in strip order. */
  tabs: TabState[]
  drag: TabDrag
  collapsed: string[]
  setCollapsed: (groups: string[]) => void
  /** Draws one tab; `color` is set for tabs in a group. */
  renderTab: (tab: TabState, color?: string) => ReactNode
  /**
   * For a list that runs top to bottom: a group's tabs fold away and back instead of hiding at once, and a
   * dragged tab shows a line where it will land, which can be in another site's group.
   */
  vertical?: boolean
}

/** How long the pointer rests on a collapsed group's chip before its tabs show beside it. */
const PEEK_DELAY = 300
/** Until when a group's panel may still be open, so moving on to another chip shows that one straight away. */
let peekOpenUntil = 0

/** Closes a group's panel if one is open, e.g. when the list scrolls away from its chip. */
export function closeGroupPeek(): void {
  if (Date.now() >= peekOpenUntil) return
  window.browserr.tabs.unpeekGroup(true)
  peekOpenUntil = 0
}

/** Where a dragged tab would land in a vertical list. */
interface Drop {
  /** Its new place in the window. */
  to: number
  /** The group it joins, or null for none. */
  into: string | null
  /** Where the line goes, from the top of the list. */
  top: number
}

/** A list of tabs where tabs from the same site sit together behind a chip that collapses them. */
export function SiteGroupedTabs({ state, tabs, drag, collapsed, setCollapsed, renderTab, vertical }: Props): ReactNode {
  const [drop, setDrop] = useState<Drop | null>(null)
  const peekTimer = useRef<number | undefined>(undefined)
  // Vertically, resting on a collapsed group's chip shows its tabs in a panel beside it.
  const peekSoon = (group: string, chip: HTMLElement): void => {
    window.clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(
      () => {
        const { x, y, width, height } = chip.getBoundingClientRect()
        window.browserr.tabs.peekGroup(group, { x, y, width, height })
        peekOpenUntil = Infinity
      },
      Date.now() < peekOpenUntil ? 0 : PEEK_DELAY
    )
  }
  const unpeek = (now = false): void => {
    window.clearTimeout(peekTimer.current)
    window.browserr.tabs.unpeekGroup(now)
    peekOpenUntil = now ? 0 : Date.now() + 250
  }
  const toggle = (group: string): void =>
    setCollapsed(collapsed.includes(group) ? collapsed.filter((g) => g !== group) : [...collapsed, group])

  const runs = siteRuns(tabs)
  const items = runs.map((run) => {
    if ('tab' in run) return renderTab(run.tab)
    const { group, tabs: members } = run
    const color = state.groupColors[group] ?? colorFor(group)
    const open = !collapsed.includes(group)
    const name = state.groupNames[group] ?? group
    // A collapsed group still shows the tab you're on.
    const active = members.find((t) => t.id === state.activeTabId)
    const first = state.tabs.indexOf(members[0])
    return (
      <div key={`group:${group}`} role="group" aria-label={name} className={cx('tab-group', 'site-group', open && 'open')} style={{ '--group': color } as CSSProperties}>
        <button
          className={cx('group-chip', drag.dragGroup === group && 'dragging')}
          data-group={group}
          // A collapsed group in the sidebar shows its tabs on hover instead.
          title={vertical && !open ? undefined : `${name} · ${members.length} tabs\nClick to ${open ? 'collapse' : 'expand'}`}
          aria-expanded={open}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            if (vertical) unpeek(true)
            drag.startGroup(group)
          }}
          onMouseEnter={(e) => vertical && !open && peekSoon(group, e.currentTarget)}
          onMouseLeave={() => vertical && unpeek()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            // A tab dropped on the chip goes in front of the group.
            const from = drag.dragId === null ? -1 : state.tabs.findIndex((t) => t.id === drag.dragId)
            drag.drop(from !== -1 && from < first ? first - 1 : first)
          }}
          onClick={() => {
            if (vertical) unpeek(true)
            toggle(group)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (vertical) unpeek(true)
            window.browserr.tabs.groupMenu(group)
          }}
        >
          <GroupIcon group={group} tabs={members} />
          <span className="group-name">{name}</span>
          <span className="group-count">{members.length}</span>
          <ChevronRight size={12} className="group-chevron" />
        </button>
        {vertical
          ? members.map((t, j) => {
              // The tabs either side of the one that stays out fold away as two drawers: `--i` is a tab's
              // place in its drawer and `--k` the drawer's size. Every tab is wrapped the same way, so switching
              // tabs doesn't rebuild them (which would drop a drag that's starting).
              const at = active ? members.indexOf(active) : members.length
              const stays = j === at
              const drawer = stays ? {} : j < at ? { '--i': j, '--k': at } : { '--i': j - at - 1, '--k': members.length - at - 1 }
              const folded = !open && !stays
              return (
                <div key={t.id} className={cx('group-fold', stays && 'stays', folded && 'folded')} style={drawer as CSSProperties} inert={folded}>
                  <div className="group-fold-inner">{renderTab(t, color)}</div>
                </div>
              )
            })
          : open
            ? members.map((t) => renderTab(t, color))
            : active && renderTab(active, color)}
      </div>
    )
  })
  if (!vertical) return items

  // Dragging an unpinned tab, this list places it (the tabs and chips inside don't).
  const dragged = drag.dragId === null ? undefined : tabs.find((t) => t.id === drag.dragId)
  const shownIn = new Map<number, string>()
  for (const run of runs) if ('group' in run) for (const t of run.tabs) shownIn.set(t.id, run.group)

  const dropAt = (e: DragEvent<HTMLElement>): Drop | null => {
    const el = (e.target as Element).closest<HTMLElement>('[data-tab-id], [data-group]')
    const list = el?.closest('.vtab-list')
    if (!dragged || !el || !list) return null
    const box = el.getBoundingClientRect()
    const group = el.dataset.group
    // On a chip it goes first in the group; on a tab, above or below it, in whatever group that tab is in.
    const target = group ? tabs.find((t) => shownIn.get(t.id) === group) : tabs.find((t) => t.id === Number(el.dataset.tabId))
    if (!target || target === dragged) return null
    const after = !group && e.clientY > box.top + box.height / 2
    const into = group ?? shownIn.get(target.id) ?? null
    const from = state.tabs.indexOf(dragged)
    const at = state.tabs.indexOf(target)
    const to = (after ? at + 1 : at) - (from < at ? 1 : 0)
    if (to === from && into === (shownIn.get(dragged.id) ?? null)) return null
    // In the 1px between rows (a chip has 1px more below it).
    const edge = group ? box.bottom + 1 : after ? box.bottom + 0.5 : box.top - 0.5
    return { to, into, top: edge - list.getBoundingClientRect().top }
  }

  return (
    <div
      className="vtab-drop"
      onDragOverCapture={(e) => {
        if (!dragged) return
        e.preventDefault()
        const next = dropAt(e)
        if (next?.to !== drop?.to || next?.into !== drop?.into || next?.top !== drop?.top) setDrop(next)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
      }}
      onDropCapture={(e) => {
        if (!dragged) return
        e.preventDefault()
        e.stopPropagation()
        // Where the line is, so it lands exactly where it said it would.
        if (drop) window.browserr.tabs.move(dragged.id, drop.to, drop.into)
        setDrop(null)
        drag.end()
      }}
    >
      {items}
      {dragged && drop && (
        <div
          className={cx('drop-line', drop.into && 'grouped')}
          style={{ top: drop.top, '--group': drop.into ? (state.groupColors[drop.into] ?? colorFor(drop.into)) : undefined } as CSSProperties}
        />
      )}
    </div>
  )
}
