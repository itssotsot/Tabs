/** Turning one version of the bookmark list into another as Chrome's bookmark events. No Electron here. */

export interface SeenBookmark {
  id: string
  url: string
  title: string
}

/** Longest increasing run of old positions, in new order: the items that didn't move. */
function stayed(order: { id: string; from: number }[]): Set<string> {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(order.length).fill(-1)
  for (let i = 0; i < order.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < order[i].from) lo = mid + 1
      else hi = mid
    }
    tails[lo] = order[i].from
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  }
  const keep = new Set<string>()
  for (let i = tailIdx[tails.length - 1] ?? -1; i >= 0; i = prev[i]) keep.add(order[i].id)
  return keep
}

export interface BookmarkChange {
  type: 'created' | 'removed' | 'moved' | 'changed'
  id: string
  index?: number
  oldIndex?: number
  item?: SeenBookmark
}

/** The events that turn list `before` into `after`, each index valid at the moment it happens. */
export function diffBookmarks(before: SeenBookmark[], after: SeenBookmark[]): BookmarkChange[] {
  const changes: BookmarkChange[] = []
  const afterIds = new Set(after.map((b) => b.id))
  const list = before.map((b) => b.id)
  for (const b of before) {
    if (afterIds.has(b.id)) continue
    const index = list.indexOf(b.id)
    list.splice(index, 1)
    changes.push({ type: 'removed', id: b.id, index, item: b })
  }
  const kept = stayed(after.filter((b) => list.includes(b.id)).map((b) => ({ id: b.id, from: list.indexOf(b.id) })))
  after.forEach((b, i) => {
    if (kept.has(b.id)) return
    const at = i === 0 ? 0 : list.indexOf(after[i - 1].id) + 1
    const from = list.indexOf(b.id)
    if (from === -1) {
      list.splice(at, 0, b.id)
      changes.push({ type: 'created', id: b.id, index: at, item: b })
    } else {
      list.splice(from, 1)
      const to = from < at ? at - 1 : at
      list.splice(to, 0, b.id)
      if (to !== from) changes.push({ type: 'moved', id: b.id, index: to, oldIndex: from })
    }
  })
  const beforeById = new Map(before.map((b) => [b.id, b]))
  for (const b of after) {
    const old = beforeById.get(b.id)
    if (old && (old.title !== b.title || old.url !== b.url)) changes.push({ type: 'changed', id: b.id, item: b })
  }
  return changes
}
