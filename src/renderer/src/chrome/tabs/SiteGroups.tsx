import { ChevronRight, Globe } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { defaultSiteColor } from '@shared/colors'
import type { SplitSide } from '@shared/split'
import type { TabState, WindowState } from '@shared/types'
import { hostOf } from '@shared/url'
import { cx, siteIcon, useFailingIcon } from '../../ui/util'
import { hasMediaBar } from './media'
import { TabIcon, useStoredState, type TabDrag } from './parts'

type Run = { tab: TabState } | { group: string; tabs: TabState[] } | { pair: [TabState, TabState] }

/** The tabs a run shows, in order. */
function runTabs(run: Run): TabState[] {
  return 'tab' in run ? [run.tab] : 'pair' in run ? run.pair : run.tabs
}

/**
 * The site groups first, each with its tabs together, then the tabs in no group, all in strip order. A group
 * needs two of the tabs in `tabs`: a layout that shows some tabs elsewhere (in a chat's group) can leave a site with one.
 * A split view's two tabs, which the window keeps next to each other and out of groups, are one run.
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
  const joined: Run[] = []
  for (let i = 0; i < loose.length; i++) {
    const tab = (loose[i] as { tab: TabState }).tab
    const next = (loose[i + 1] as { tab: TabState } | undefined)?.tab
    if (tab.split?.side === 'left' && next && tab.split.with === next.id) {
      joined.push({ pair: [tab, next] })
      i++
    } else joined.push(loose[i])
  }
  return [...groups, ...joined]
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
  const own = tabs.find((t) => t.favicon && hostOf(t.url) === group)
  const src = own?.favicon ?? siteIcon(`https://${group}/`)
  const [failing, onError] = useFailingIcon(src)
  if (!src || failing) return <Globe className="favicon" size={14} strokeWidth={1.75} />
  return <img className="favicon" src={src} alt="" draggable={false} onError={onError} />
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

/**
 * While a group is dragged, the pointer carries the whole group: its chip and the tabs showing (all of them when
 * it's open, the tab you're on when it's collapsed). The browser takes the picture once, from a copy made here.
 */
function setGroupDragImage(e: DragEvent<HTMLElement>, vertical: boolean): void {
  const chip = e.currentTarget
  const group = chip.closest<HTMLElement>('.tab-group')
  const root = chip.closest<HTMLElement>('.chrome')
  if (!group?.parentElement || !root) return
  const parts = [...group.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.getBoundingClientRect().height > 0)
  if (parts.length < 2) return

  // The copy sits in bare copies of the list's containers, so the list's styles still apply to it.
  const chain: HTMLElement[] = []
  for (let el: HTMLElement | null = group; el && el !== root.parentElement; el = el.parentElement) chain.unshift(el)
  const shells = chain.map((el) => {
    const shell = el.cloneNode(false) as HTMLElement
    shell.removeAttribute('id')
    return shell
  })
  shells.reduce((outer, inner) => (outer.appendChild(inner), inner))
  const host = shells[0]
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', height: 'auto', pointerEvents: 'none' })

  const image = document.createElement('div')
  image.className = cx('group-drag-image', vertical && 'vertical')
  shells[shells.length - 1].appendChild(image)
  for (const part of parts) {
    const copy = part.cloneNode(true) as HTMLElement
    Object.assign(copy.style, { width: `${part.getBoundingClientRect().width}px`, flex: 'none' })
    image.appendChild(copy)
  }
  document.body.appendChild(host)

  const at = chip.getBoundingClientRect()
  const box = image.getBoundingClientRect()
  const copied = image.firstElementChild!.getBoundingClientRect()
  e.dataTransfer.setDragImage(image, e.clientX - at.left + copied.left - box.left, e.clientY - at.top + copied.top - box.top)
  setTimeout(() => host.remove())
}

/** Where a dragged tab (or site group) would land in a vertical list. */
interface Drop {
  /** Its new place in the window. For a group, the tab it goes next to. */
  to: number
  /** The group it joins, or null for none. */
  into: string | null
  /** Which side of `to` a group goes: it never lands inside another group. */
  place?: 'before' | 'after'
  /** Where the line goes, from the top of the list. */
  top: number
  /**
   * Dropped onto another tab instead: the two side by side, in a split view. Where the dragged tab would go in that
   * tab's row, from the list's top left.
   */
  split?: { target: number; side: SplitSide; left: number; width: number; height: number }
}

/**
 * How much of a tab, at its top and at its bottom, is for moving another tab above or below it. Dropped between
 * those, onto the tab itself, the two make a split view: on the half of it the pointer is over.
 */
const MOVE_BAND = 0.28

/** How long a dragged tab stays over a collapsed group before the group opens. */
const EXPAND_DELAY = 1500

/** A list of tabs where tabs from the same site sit together behind a chip that collapses them. */
export function SiteGroupedTabs({ state, tabs, drag, collapsed, setCollapsed, renderTab, vertical }: Props): ReactNode {
  const [drop, setDrop] = useState<Drop | null>(null)
  // The group a dragged tab is over, lit up (vertical lists only).
  const [overGroup, setOverGroup] = useState<string | null>(null)
  const hovered = drag.dragId !== null ? overGroup : null
  useEffect(() => {
    if (drag.dragId === null) setOverGroup(null)
  }, [drag.dragId])
  const hoveredCollapsed = !!hovered && collapsed.includes(hovered)
  const latest = useRef({ collapsed, setCollapsed })
  latest.current = { collapsed, setCollapsed }
  // Held over a collapsed group, the tab opens it. Moving around inside the group doesn't restart the wait.
  useEffect(() => {
    if (!hovered || !hoveredCollapsed) return
    const timer = window.setTimeout(() => {
      const { collapsed, setCollapsed } = latest.current
      setCollapsed(collapsed.filter((g) => g !== hovered))
    }, EXPAND_DELAY)
    return () => window.clearTimeout(timer)
  }, [hovered, hoveredCollapsed])
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
    if ('pair' in run) {
      const [left, right] = run.pair
      return (
        <div
          key={`split:${left.id}`}
          role="group"
          aria-label="Split view"
          className={cx('tab-split', (left.onScreen || right.onScreen) && 'on-screen')}
          data-split={left.id}
        >
          {renderTab(left)}
          {renderTab(right)}
        </div>
      )
    }
    const { group, tabs: members } = run
    const color = state.groupColors[group] ?? defaultSiteColor(group)
    const open = !collapsed.includes(group)
    const name = state.groupNames[group] ?? group
    // A collapsed group still shows the tab you're on.
    const active = members.find((t) => t.id === state.activeTabId)
    const first = state.tabs.indexOf(members[0])
    return (
      <div
        key={`group:${group}`}
        role="group"
        aria-label={name}
        className={cx('tab-group', 'site-group', open && 'open', drag.dragGroup === group && 'dragging', hovered === group && 'drop-target')}
        style={{ '--group': color } as CSSProperties}
      >
        <button
          className="group-chip"
          data-group={group}
          // A collapsed group in the sidebar shows its tabs on hover instead.
          title={vertical && !open ? undefined : `${name} · ${members.length} tabs\nClick to ${open ? 'collapse' : 'expand'}`}
          aria-expanded={open}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            if (vertical) unpeek(true)
            setGroupDragImage(e, !!vertical)
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
              // The tabs either side of the one that stays out fold away as two drawers. Each tab is told how
              // many tabs of its drawer are above and below it, and how many of those are taller ones with a
              // video, so it knows its drawer's extent. Every tab is wrapped the same way, so switching tabs
              // doesn't rebuild them (which would drop a drag that's starting).
              const at = active ? members.indexOf(active) : members.length
              const stays = j === at
              const [start, end] = j < at ? [0, at] : [at + 1, members.length]
              const count = (list: TabState[]): Record<string, number> => ({ n: list.length, m: list.filter(hasMediaBar).length })
              const above = count(members.slice(start, j))
              const below = count(members.slice(j + 1, end))
              const drawer = stays ? {} : { '--above': above.n, '--above-media': above.m, '--below': below.n, '--below-media': below.m }
              const folded = !open && !stays
              return (
                <div
                  key={t.id}
                  className={cx('group-fold', stays && 'stays', folded && 'folded', hasMediaBar(t) && 'has-media')}
                  style={drawer as CSSProperties}
                  inert={folded}
                >
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

  // Dragging an unpinned tab or a group's chip, this list places it (the tabs and chips inside don't).
  const dragged = drag.dragId === null ? undefined : tabs.find((t) => t.id === drag.dragId)
  const draggedGroup = drag.dragGroup !== null && runs.some((r) => 'group' in r && r.group === drag.dragGroup) ? drag.dragGroup : null
  const shownIn = new Map<number, string>()
  for (const run of runs) if ('group' in run) for (const t of run.tabs) shownIn.set(t.id, run.group)

  // A group goes above or below whatever it's over: a lone tab, or another group as a whole.
  const groupDropAt = (e: DragEvent<HTMLElement>): Drop | null => {
    const el = (e.target as Element).closest<HTMLElement>('[data-tab-id], [data-group]')
    const list = el?.closest('.vtab-list')
    if (!draggedGroup || !el || !list) return null
    const over = el.dataset.group ?? shownIn.get(Number(el.dataset.tabId))
    const index = runs.findIndex((r) => ('group' in r ? r.group === over : runTabs(r).some((t) => t.id === Number(el.dataset.tabId))))
    const from = runs.findIndex((r) => 'group' in r && r.group === draggedGroup)
    const run = runs[index]
    if (!run || index === from) return null
    // A group's wrapper has no box of its own (display: contents): it spans its chip and the tabs showing.
    const group = 'group' in run ? el.closest<HTMLElement>('.site-group') : null
    const row = 'pair' in run ? el.closest<HTMLElement>('.tab-split') : null
    const boxes = (group ? [...group.children] : [row ?? el]).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0)
    if (!boxes.length) return null
    const box = { top: Math.min(...boxes.map((r) => r.top)), bottom: Math.max(...boxes.map((r) => r.bottom)) }
    const after = e.clientY > (box.top + box.bottom) / 2
    // Right next to where it already is: nothing would move.
    if (index + (after ? 1 : 0) === from || index + (after ? 1 : 0) === from + 1) return null
    const members = runTabs(run)
    const anchor = after ? members[members.length - 1] : members[0]
    const edge = after ? box.bottom + 0.5 : box.top - 0.5
    return { to: state.tabs.indexOf(anchor), into: null, place: after ? 'after' : 'before', top: edge - list.getBoundingClientRect().top }
  }

  // Onto another tab, away from its top and bottom: side by side with it, on the half the pointer is over.
  const splitDropAt = (e: DragEvent<HTMLElement>, el: HTMLElement, list: Element): Drop | null => {
    const over = el.dataset.tabId ? tabs.find((t) => t.id === Number(el.dataset.tabId)) : undefined
    if (!over || !dragged || over === dragged) return null
    const r = el.getBoundingClientRect()
    const band = r.height * MOVE_BAND
    if (e.clientY < r.top + band || e.clientY > r.bottom - band) return null
    const side: SplitSide = e.clientX < r.left + r.width / 2 ? 'left' : 'right'
    const l = list.getBoundingClientRect()
    const left = r.left - l.left + (side === 'right' ? r.width / 2 : 0)
    return { to: -1, into: null, top: r.top - l.top, split: { target: over.id, side, left, width: r.width / 2, height: r.height } }
  }

  const dropAt = (e: DragEvent<HTMLElement>): Drop | null => {
    if (draggedGroup) return groupDropAt(e)
    const el = (e.target as Element).closest<HTMLElement>('[data-tab-id], [data-group]')
    const list = el?.closest('.vtab-list')
    if (!dragged || !el || !list) return null
    const beside = splitDropAt(e, el, list)
    if (beside) return beside
    const group = el.dataset.group
    // A split's row is one row: a tab goes above it or below it, never between its two tabs.
    const pair = runs.find((r): r is { pair: [TabState, TabState] } => 'pair' in r && r.pair.some((t) => t.id === Number(el.dataset.tabId)))
    const box = (pair ? el.closest<HTMLElement>('.tab-split')! : el).getBoundingClientRect()
    const below = e.clientY > box.top + box.height / 2
    // On a chip it goes first in the group; on a tab, above or below it, in whatever group that tab is in.
    const target = group
      ? tabs.find((t) => shownIn.get(t.id) === group)
      : pair
        ? pair.pair[below ? 1 : 0]
        : tabs.find((t) => t.id === Number(el.dataset.tabId))
    if (!target || (target === dragged && !pair) || pair?.pair.includes(dragged)) return null
    const after = !group && below
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
        if (!dragged && !draggedGroup) return
        e.preventDefault()
        if (dragged) {
          // Between rows (the 1px gaps) it's still over the same group.
          const el = (e.target as Element).closest<HTMLElement>('[data-tab-id], [data-group]')
          const over = el ? (el.dataset.group ?? shownIn.get(Number(el.dataset.tabId)) ?? null) : overGroup
          if (over !== overGroup) setOverGroup(over)
        }
        const next = dropAt(e)
        const moved = next?.to !== drop?.to || next?.into !== drop?.into || next?.top !== drop?.top
        if (moved || next?.split?.target !== drop?.split?.target || next?.split?.side !== drop?.split?.side) setDrop(next)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDrop(null)
        setOverGroup(null)
      }}
      onDropCapture={(e) => {
        if (!dragged && !draggedGroup) return
        e.preventDefault()
        e.stopPropagation()
        // Where the line is, so it lands exactly where it said it would.
        if (drop?.split && dragged) window.browserr.split.pair(dragged.id, drop.split.target, drop.split.side)
        else if (drop && dragged) window.browserr.tabs.move(dragged.id, drop.to, drop.into)
        if (drop && draggedGroup) window.browserr.tabs.moveGroup(draggedGroup, drop.to, drop.place)
        setDrop(null)
        setOverGroup(null)
        drag.end()
      }}
    >
      {items}
      {dragged && drop?.split && (
        <>
          {/* The tab it's dropped beside makes room, as if they were already one row. */}
          <style>{`.vtab-list .tab[data-tab-id="${drop.split.target}"] { padding-${drop.split.side}: calc(50% + 10px); box-shadow: inset 0 0 0 1px var(--border); }`}</style>
          <div
            className={cx('split-drop', drop.split.side)}
            style={{ left: drop.split.left, top: drop.top, width: drop.split.width, height: drop.split.height }}
          >
            <TabIcon tab={dragged} />
            <span className="split-drop-title">{dragged.title}</span>
          </div>
        </>
      )}
      {(dragged || draggedGroup) && drop && !drop.split && (
        <div
          className={cx('drop-line', drop.into && 'grouped')}
          style={{ top: drop.top, '--group': drop.into ? (state.groupColors[drop.into] ?? defaultSiteColor(drop.into)) : undefined } as CSSProperties}
        />
      )}
    </div>
  )
}
