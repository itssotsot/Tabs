import { Notification } from 'electron'
import type { AppNotification } from '@shared/types'
import { store } from './store'

// Every window's UI listens to Firestore, so the same event can arrive once per window.
const seen = new Set<string>()
// Keep references so click handlers survive garbage collection on macOS.
const live = new Set<Notification>()

export function showNotification(n: AppNotification, onClick: (n: AppNotification) => void): void {
  if (seen.has(n.key)) return
  seen.add(n.key)
  if (seen.size > 2000) seen.delete(seen.values().next().value!)

  if (!store.settings.notifications || !Notification.isSupported()) return

  const notification = new Notification({ title: n.title, body: n.body })
  live.add(notification)
  notification.on('click', () => {
    live.delete(notification)
    onClick(n)
  })
  notification.on('close', () => live.delete(notification))
  notification.show()
}
