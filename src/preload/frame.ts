/**
 * `fn`, run at most once a frame however often it's asked for: for work set off by page changes, which
 * can come by the hundred a frame. `late` runs it a frame later, once that frame is on screen.
 */
export function oncePerFrame(fn: () => void, { late = false } = {}): () => void {
  let queued = false
  const run = (): void => {
    queued = false
    fn()
  }
  return () => {
    if (queued) return
    queued = true
    requestAnimationFrame(late ? () => requestAnimationFrame(run) : run)
  }
}
