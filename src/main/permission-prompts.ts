// Questions under the address bar about what a site wants (PermissionPrompt), one at a time for each tab.
// The window shows the question of its tab (window.ts); a question goes away unanswered, allowing nothing,
// when its page does.
import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import type { PermissionAnswer, PermissionPrompt } from '@shared/types'

/** A prompt before it has an id. */
type Question = PermissionPrompt extends infer P ? (P extends PermissionPrompt ? Omit<P, 'id'> : never) : never

interface Waiting {
  prompt: PermissionPrompt
  resolve(answer: PermissionAnswer): void
}

const queues = new Map<WebContents, { waiting: Waiting[]; stop(): void }>()
let nextId = 1

/** `changed` (wc): the question for that page is another one now, or none. */
export const prompts = new EventEmitter()

export function askInPage(wc: WebContents, question: Question): Promise<PermissionAnswer> {
  return new Promise((resolve) => {
    const prompt = { ...question, id: nextId++ } as PermissionPrompt
    let queue = queues.get(wc)
    if (!queue) {
      const dismissAll = (): void => {
        const q = queues.get(wc)
        if (!q) return
        queues.delete(wc)
        q.stop()
        for (const w of q.waiting) w.resolve({ id: w.prompt.id, decision: 'dismiss' })
        prompts.emit('changed', wc)
      }
      wc.on('did-navigate', dismissAll)
      wc.once('destroyed', dismissAll)
      queue = { waiting: [], stop: () => !wc.isDestroyed() && wc.off('did-navigate', dismissAll) }
      queues.set(wc, queue)
    }
    queue.waiting.push({ prompt, resolve })
    if (queue.waiting.length === 1) prompts.emit('changed', wc)
  })
}

/** The question showing for the page, if any. */
export function currentPrompt(wc: WebContents): PermissionPrompt | null {
  return queues.get(wc)?.waiting[0]?.prompt ?? null
}

/** Answers the question with the answer's id; false if there's none (answered already, or its page left). */
export function answerPrompt(answer: PermissionAnswer): boolean {
  for (const [wc, queue] of queues) {
    const i = queue.waiting.findIndex((w) => w.prompt.id === answer.id)
    if (i < 0) continue
    const [waiting] = queue.waiting.splice(i, 1)
    if (!queue.waiting.length) {
      queues.delete(wc)
      queue.stop()
    }
    waiting.resolve(answer)
    prompts.emit('changed', wc)
    return true
  }
  return false
}
