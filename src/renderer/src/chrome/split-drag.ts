const dragStarts = new Set<(tabId: number) => void>()

/** A tab started being dragged in the tab list: the page area becomes a place to drop it, for a split view. */
export function tabDragStarted(tabId: number): void {
  for (const start of dragStarts) start(tabId)
}

/** Calls `start` whenever a tab starts being dragged. Returns the way to stop. */
export function onTabDragStart(start: (tabId: number) => void): () => void {
  dragStarts.add(start)
  return () => void dragStarts.delete(start)
}
