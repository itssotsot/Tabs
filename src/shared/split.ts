import type { Rect } from './types'

/** Which half of the window a tab takes in a split view. */
export type SplitSide = 'left' | 'right'

/** Two tabs side by side: which is on each side (tab ids), and how much of the width the left one gets. */
export interface SplitState {
  left: number
  right: number
  ratio: number
}

/** Room around each page of a split, where the divider and the ring around the page you're using show. */
export const SPLIT_PAD = 6
/** The pages of a split have rounded corners, like cards. */
export const SPLIT_RADIUS = 10
/** Neither page gets narrower than this, dragging the divider. */
export const SPLIT_MIN_WIDTH = 280

/** Where the two pages go in the page area (`width` × `height`), relative to its top left. */
export function splitRects(width: number, height: number, ratio: number): Record<SplitSide, Rect> {
  const inner = Math.max(0, width - SPLIT_PAD * 3)
  const leftWidth = Math.round(inner * clampRatio(ratio, width))
  const y = SPLIT_PAD
  const h = Math.max(0, height - SPLIT_PAD * 2)
  return {
    left: { x: SPLIT_PAD, y, width: leftWidth, height: h },
    right: { x: SPLIT_PAD * 2 + leftWidth, y, width: inner - leftWidth, height: h }
  }
}

/** Keeps both pages at least SPLIT_MIN_WIDTH wide, when the area has room for that. */
export function clampRatio(ratio: number, width: number): number {
  const inner = width - SPLIT_PAD * 3
  const min = inner > SPLIT_MIN_WIDTH * 2 ? SPLIT_MIN_WIDTH / inner : 0.5
  return Math.min(1 - min, Math.max(min, Number.isFinite(ratio) ? ratio : 0.5))
}

/**
 * The split you get dropping tab `dragged` on a side of the page area. With a split showing, it takes that side's
 * place (or the two swap, when it's the one on the other side). Otherwise it shares the window with `partner`.
 */
export function splitAfterDrop(dragged: number, side: SplitSide, current: SplitState | null, partner: number | null): SplitState | null {
  const other: SplitSide = side === 'left' ? 'right' : 'left'
  if (current) {
    const next = { ...current, [side]: dragged }
    // Dragged to the other side, the two swap, each keeping its width.
    if (current[other] === dragged) Object.assign(next, { [other]: current[side], ratio: 1 - current.ratio })
    return next
  }
  if (partner === null || partner === dragged) return null
  return side === 'left' ? { left: dragged, right: partner, ratio: 0.5 } : { left: partner, right: dragged, ratio: 0.5 }
}
