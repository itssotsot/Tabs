import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { clampRatio, SPLIT_PAD, SPLIT_RADIUS, splitAfterDrop, splitRects, type SplitSide, type SplitState } from '@shared/split'
import type { Rect, SplitDragStart, TabState, WindowState } from '@shared/types'
import { hostOf } from '@shared/url'
import { cx } from '../ui/util'
import { onTabDragStart } from './split-drag'
import { TabIcon } from './tabs/parts'

/** How long the pages take to slide into place as you pick a side (keep `--split-move` in chrome.css in step). */
const MOVE_MS = 340
/** After a drop, the least time the pictures take to settle before the pages come back. */
const SETTLE_MS = 180
/** The pages come back over the pictures; the pictures go a moment later, once the pages have drawn. */
const UNCOVER_MS = 120

interface StageDrag {
  tabId: number
  start: SplitDragStart
  /** Object URLs of the pictures of the pages on screen, by tab. */
  pictures: Map<number, string>
  /** The side of the page area the pointer is over. */
  over: SplitSide | null
  dropped: boolean
}

function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return size
}

/**
 * Where the page goes (the main process puts it there, over this). A split view's divider and the ring around the
 * page you're using show around its pages. While a tab is dragged, pictures of the pages stand in for them, and
 * move aside to make room for it on the side you're over.
 */
export function Viewport({ state }: { state: WindowState }): ReactNode {
  const api = window.browserr
  const ref = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(ref)
  const [drag, setDragState] = useState<StageDrag | null>(null)
  const dragRef = useRef<StageDrag | null>(null)
  const session = useRef(0)
  const movedAt = useRef(0)
  const setDrag = (d: StageDrag | null): void => {
    if (d?.over !== dragRef.current?.over) movedAt.current = performance.now()
    dragRef.current = d
    setDragState(d)
  }
  const clear = (): void => {
    for (const url of dragRef.current?.pictures.values() ?? []) URL.revokeObjectURL(url)
    setDrag(null)
  }

  useEffect(() => {
    const start = async (tabId: number): Promise<void> => {
      const id = ++session.current
      if (dragRef.current) clear()
      let ended = false
      // Without a drop on the page area. The tab list's drop (a reorder) or none: the pages just come back.
      const end = (): void => {
        if (ended) return
        ended = true
        document.removeEventListener('dragend', end, true)
        window.removeEventListener('pointermove', end, true)
        if (dragRef.current?.dropped || session.current !== id) return
        void api.split.finish(tabId, null).then(() => session.current === id && clear())
      }
      document.addEventListener('dragend', end, true)
      // The tab dragged may be gone from the list before the drag ends, and take its dragend with it. No pointer
      // moves during a drag, so one means it's over.
      window.addEventListener('pointermove', end, true)
      const found = await api.split.dragStart(tabId)
      if (!found || session.current !== id) return
      if (ended) return void api.split.finish(tabId, null)
      const pictures = new Map<number, string>()
      for (const pane of found.panes) {
        if (pane.image) pictures.set(pane.tabId, URL.createObjectURL(new Blob([pane.image as BlobPart], { type: 'image/jpeg' })))
      }
      await Promise.all(
        [...pictures.values()].map((src) => {
          const img = new Image()
          img.src = src
          return img.decode().catch(() => {})
        })
      )
      if (session.current !== id || ended) {
        for (const url of pictures.values()) URL.revokeObjectURL(url)
        return
      }
      setDrag({ tabId, start: found, pictures, over: null, dropped: false })
    }
    return onTabDragStart((tabId) => void start(tabId))
  }, [])

  // Once the pictures are on screen, the pages come off it.
  const shownStart = drag?.start
  useEffect(() => {
    if (!shownStart) return
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => !dragRef.current?.dropped && api.split.hold(true)))
    return () => cancelAnimationFrame(frame)
  }, [shownStart])

  // Which side the pointer is over, and the drop.
  const dragging = !!drag && !drag.dropped
  useEffect(() => {
    if (!dragging) return
    const sideAt = (e: DragEvent): SplitSide | null => {
      const r = ref.current?.getBoundingClientRect()
      if (!r || e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return null
      return e.clientX < r.left + r.width / 2 ? 'left' : 'right'
    }
    const over = (e: DragEvent): void => {
      const side = sideAt(e)
      if (side) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      }
      const d = dragRef.current
      if (d && d.over !== side) setDrag({ ...d, over: side })
    }
    // Out of the window.
    const leave = (e: DragEvent): void => {
      const d = dragRef.current
      if (!e.relatedTarget && d?.over) setDrag({ ...d, over: null })
    }
    const drop = (e: DragEvent): void => {
      const side = sideAt(e)
      const d = dragRef.current
      if (!side || !d) return
      e.preventDefault()
      const id = session.current
      const settle = Math.max(SETTLE_MS, MOVE_MS - (performance.now() - movedAt.current))
      setDrag({ ...d, over: side, dropped: true })
      setTimeout(() => {
        void api.split.finish(d.tabId, side).then(() => setTimeout(() => session.current === id && clear(), UNCOVER_MS))
      }, settle)
    }
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
    }
  }, [dragging])

  const activeSplit = state.htmlFullscreen ? undefined : state.splits.find((s) => s.left === state.activeTabId || s.right === state.activeTabId)
  return (
    <div ref={ref} className="viewport">
      {activeSplit && width > 0 && <SplitFrame split={activeSplit} activeTabId={state.activeTabId} width={width} height={height} />}
      {drag && width > 0 && <Stage drag={drag} tabs={state.tabs} width={width} height={height} />}
    </div>
  )
}

// ---- the split on screen: the ring around the page you're using, and the divider between them ----

function SplitFrame({ split, activeTabId, width, height }: { split: SplitState; activeTabId: number | null; width: number; height: number }): ReactNode {
  const api = window.browserr
  // While the divider is dragged, where it is, ahead of the window's state.
  const [live, setLive] = useState<number | null>(null)
  const rects = splitRects(width, height, live ?? split.ratio)
  const focused = rects[split.left === activeTabId ? 'left' : 'right']
  const ring = SPLIT_PAD / 2
  return (
    <div className={cx('split-frame', live !== null && 'resizing')}>
      <div
        className="split-ring"
        style={{
          left: focused.x - ring,
          top: focused.y - ring,
          width: focused.width + ring * 2,
          height: focused.height + ring * 2,
          borderRadius: SPLIT_RADIUS + ring
        }}
      />
      <div
        className={cx('split-divider', live !== null && 'dragging')}
        style={{ left: rects.left.x + rects.left.width, width: SPLIT_PAD }}
        title="Drag to resize. Double-click to make them even."
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          const handle = e.currentTarget
          const left = handle.parentElement!.getBoundingClientRect().left
          let frame = 0
          let ratio = split.ratio
          const move = (ev: PointerEvent): void => {
            ratio = clampRatio((ev.clientX - left - SPLIT_PAD * 1.5) / (width - SPLIT_PAD * 3), width)
            setLive(ratio)
            if (!frame) {
              frame = requestAnimationFrame(() => {
                frame = 0
                api.split.resize(ratio)
              })
            }
          }
          const end = (): void => {
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('lostpointercapture', end)
            document.documentElement.classList.remove('resizing-split')
            cancelAnimationFrame(frame)
            api.split.resize(ratio)
            // Until the window's state has the new place.
            setTimeout(() => setLive(null), 150)
          }
          handle.setPointerCapture(e.pointerId)
          handle.addEventListener('pointermove', move)
          handle.addEventListener('lostpointercapture', end)
          document.documentElement.classList.add('resizing-split')
          setLive(ratio)
        }}
        onDoubleClick={() => api.split.resize(0.5)}
      />
    </div>
  )
}

// ---- while a tab is dragged ----

interface Box {
  tabId: number
  rect: Rect
  radius: number
  picture: string | undefined
  /** The tab being dragged in. */
  incoming: boolean
  /** Not on screen yet, or no longer (replaced by the tab dragged in). */
  hidden: boolean
  side: SplitSide | null
}

/**
 * Where each page goes: where it is now until the pointer is over a side, then where the split would put it.
 * Every tab that could show gets a box, so it can fade in and out rather than pop.
 */
function stageBoxes(drag: StageDrag, width: number, height: number): { boxes: Box[]; divider: number | null } {
  const { start, tabId: dragged, pictures, over } = drag
  const next = over && splitAfterDrop(dragged, over, start.split, start.partner)
  const rects = next && splitRects(width, height, next.ratio)
  const boxes: Box[] = []
  const box = (tabId: number, rect: Rect, radius: number, hidden: boolean, side: SplitSide | null): void => {
    if (boxes.some((b) => b.tabId === tabId)) return
    boxes.push({ tabId, rect, radius, picture: pictures.get(tabId), incoming: tabId === dragged, hidden, side })
  }
  if (next && rects) {
    box(next.left, rects.left, SPLIT_RADIUS, false, 'left')
    box(next.right, rects.right, SPLIT_RADIUS, false, 'right')
  }
  for (const pane of start.panes) box(pane.tabId, pane.rect, start.split ? SPLIT_RADIUS : 0, !!next, null)
  // Waiting in the middle for a side to go to.
  const middle = { x: width * 0.25, y: height * 0.2, width: width * 0.5, height: height * 0.6 }
  box(dragged, middle, SPLIT_RADIUS, true, null)
  if (start.partner !== null) box(start.partner, middle, SPLIT_RADIUS, true, null)
  return { boxes, divider: rects ? rects.left.x + rects.left.width + SPLIT_PAD / 2 : null }
}

function Stage({ drag, tabs, width, height }: { drag: StageDrag; tabs: TabState[]; width: number; height: number }): ReactNode {
  const { boxes, divider } = stageBoxes(drag, width, height)
  return (
    <div className={cx('split-stage', drag.over && 'over', drag.dropped && 'dropped')}>
      {boxes.map((b) => {
        const tab = tabs.find((t) => t.id === b.tabId)
        const style = { left: b.rect.x, top: b.rect.y, width: b.rect.width, height: b.rect.height, borderRadius: b.radius } as CSSProperties
        return (
          <div key={b.tabId} className={cx('split-box', b.incoming && 'incoming', b.hidden && 'hidden', !b.picture && 'card')} style={style}>
            {b.picture ? <img src={b.picture} alt="" draggable={false} /> : <TabCard tab={tab} />}
            {b.incoming && b.side && <span className="split-hint">{b.side === 'left' ? 'Opens on the left' : 'Opens on the right'}</span>}
          </div>
        )
      })}
      <div className="split-stage-divider" style={{ left: divider ?? width / 2 }} />
    </div>
  )
}

/** A page with no picture (a sleeping tab, or one not on screen): its icon and name, in its color. */
function TabCard({ tab }: { tab: TabState | undefined }): ReactNode {
  const style = tab?.color ? ({ '--tint': tab.color } as CSSProperties) : undefined
  return (
    <div className="split-card" style={style}>
      {tab && (
        <span className="split-card-icon">
          <TabIcon tab={tab} />
        </span>
      )}
      <span className="split-card-title">{tab?.title}</span>
      {tab?.url && <span className="split-card-host">{hostOf(tab.url)}</span>}
    </div>
  )
}
