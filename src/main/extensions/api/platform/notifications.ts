import { Notification, type NativeImage, type NotificationConstructorOptions, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { lifecycle } from '../../lifecycle'
import { extensionDisplay } from '../../manager'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { asObject, isObject, loadImage } from './util'

/**
 * chrome.notifications, shown as system notifications. Buttons become notification actions
 * (macOS), list items and progress are folded into the text, and requireInteraction keeps the
 * notification up where the system allows it.
 */

type Options = Record<string, unknown>

interface Live {
  notification: Notification
  options: Options
  /** Closed by us (clear, update, unload); the close event isn't the user's doing. */
  closing: boolean
}

const TEMPLATE_TYPES = new Set(['basic', 'image', 'list', 'progress'])
/** Extension id -> notification id -> the notification. Also keeps click handlers from being garbage collected. */
const live = new Map<string, Map<string, Live>>()
let ses: Session | null = null

lifecycle.on('ready', (session) => {
  ses = session
})

function forExtension(extensionId: string): Map<string, Live> {
  let map = live.get(extensionId)
  if (!map) live.set(extensionId, (map = new Map()))
  return map
}

function validate(options: Options, creating: boolean): void {
  if (creating) {
    const missing = ['type', 'title', 'message'].filter((k) => options[k] === undefined)
    if (missing.length) throw new ExtensionError(`Some of the required properties are missing: ${missing.join(', ')}.`)
  }
  if (options.type !== undefined && !TEMPLATE_TYPES.has(options.type as string)) throw new ExtensionError(`Invalid notification type: ${String(options.type)}.`)
  for (const key of ['title', 'message', 'contextMessage', 'iconUrl', 'imageUrl']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') throw new ExtensionError(`Invalid '${key}'.`)
  }
  if (options.buttons !== undefined && (!Array.isArray(options.buttons) || options.buttons.length > 2)) {
    throw new ExtensionError('Invalid buttons: at most two are allowed.')
  }
  if (options.progress !== undefined) {
    const p = options.progress
    if (typeof p !== 'number' || p < 0 || p > 100) throw new ExtensionError('The progress value should range from 0 to 100.')
    if ((options.type ?? 'progress') !== 'progress') throw new ExtensionError('The progress value should not be specified for non-progress notification.')
  }
  if (options.type === 'image' && creating && !options.imageUrl) throw new ExtensionError('Unable to download all specified images.')
  if (options.items !== undefined && !Array.isArray(options.items)) throw new ExtensionError("Invalid 'items'.")
}

/** The text a system notification can show for each template. */
function bodyOf(options: Options): string {
  const lines: string[] = []
  if (options.message) lines.push(String(options.message))
  if (options.type === 'list' && Array.isArray(options.items)) {
    for (const item of options.items) {
      if (!isObject(item)) continue
      lines.push([item.title, item.message].filter(Boolean).join(': '))
    }
  }
  if (options.type === 'progress' && typeof options.progress === 'number') lines.push(`${Math.round(options.progress)}%`)
  // Only macOS shows a subtitle; elsewhere the context message goes at the end.
  if (options.contextMessage && process.platform !== 'darwin') lines.push(String(options.contextMessage))
  return lines.join('\n')
}

async function iconFor(call: CallContext, options: Options): Promise<NativeImage | undefined> {
  const icon = (await loadImage(call, options.iconUrl as string | undefined, ses)) ?? (await loadImage(call, options.imageUrl as string | undefined, ses))
  if (icon) return icon
  // Chrome requires an icon; fall back to the extension's own.
  const fallback = extensionDisplay(call.extensionId)?.icon
  return fallback ? (await loadImage(call, fallback, null)) ?? undefined : undefined
}

async function show(call: CallContext, id: string, options: Options): Promise<void> {
  const buttons = Array.isArray(options.buttons) ? options.buttons.filter(isObject) : []
  const priority = typeof options.priority === 'number' ? options.priority : 0
  const init: NotificationConstructorOptions = {
    title: String(options.title ?? ''),
    body: bodyOf(options),
    silent: options.silent === true,
    icon: await iconFor(call, options),
    urgency: priority >= 2 ? 'critical' : priority < 0 ? 'low' : 'normal',
    timeoutType: options.requireInteraction === true ? 'never' : 'default',
    actions: buttons.map((b) => ({ type: 'button' as const, text: String(b.title ?? '') })),
    ...(buttons.length ? { closeButtonText: 'Close' } : {}),
    ...(options.contextMessage && process.platform === 'darwin' ? { subtitle: String(options.contextMessage) } : {})
  }
  const extensionId = call.extensionId
  const map = forExtension(extensionId)
  const notification = new Notification(init)
  const entry: Live = { notification, options, closing: false }
  const current = (): boolean => map.get(id) === entry
  notification.on('click', () => {
    if (current()) emit('notifications.onClicked', [id], { extensionId })
  })
  notification.on('action', (_e, index) => {
    if (current()) emit('notifications.onButtonClicked', [id, index], { extensionId })
  })
  notification.on('close', (e) => {
    if (!current()) return
    map.delete(id)
    const byUser = !entry.closing && (e as { reason?: string }).reason !== 'timedOut'
    emit('notifications.onClosed', [id, byUser], { extensionId })
  })
  notification.on('failed', () => {
    if (current()) map.delete(id)
  })
  map.set(id, entry)
  notification.show()
}

function close(extensionId: string, id: string, announce: boolean): boolean {
  const map = live.get(extensionId)
  const entry = map?.get(id)
  if (!map || !entry) return false
  entry.closing = true
  if (!announce) map.delete(id)
  try {
    entry.notification.close()
  } catch {
    // Already gone.
  }
  if (announce && map.get(id) === entry) {
    // Some systems don't report the close of a notification we took down.
    map.delete(id)
    emit('notifications.onClosed', [id, false], { extensionId })
  }
  return true
}

async function create(call: CallContext, a: unknown, b: unknown): Promise<string> {
  const [rawId, rawOptions] = isObject(a) ? [undefined, a] : [a, b]
  if (rawId !== undefined && rawId !== null && typeof rawId !== 'string') throw new ExtensionError('Invalid notification id.')
  const options = asObject(rawOptions)
  validate(options, true)
  const id = (rawId as string | undefined) || randomUUID()
  // Creating with an existing id replaces that notification.
  close(call.extensionId, id, false)
  await show(call, id, options)
  return id
}

async function update(call: CallContext, id: unknown, rawOptions: unknown): Promise<boolean> {
  if (typeof id !== 'string') throw new ExtensionError('Invalid notification id.')
  const existing = live.get(call.extensionId)?.get(id)
  if (!existing) return false
  const options = { ...existing.options, ...asObject(rawOptions) }
  validate(options, false)
  close(call.extensionId, id, false)
  await show(call, id, options)
  return true
}

defineApi('notifications', {
  permissions: ['notifications'],
  methods: {
    create,
    update,
    clear: (call, id) => {
      if (typeof id !== 'string') throw new ExtensionError('Invalid notification id.')
      return close(call.extensionId, id, true)
    },
    getAll: (call) => Object.fromEntries([...(live.get(call.extensionId)?.keys() ?? [])].map((id) => [id, true])),
    getPermissionLevel: () => (Notification.isSupported() ? 'granted' : 'denied')
  }
})

for (const name of ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged', 'onShowSettings']) {
  defineEvent(`notifications.${name}`, { permissions: ['notifications'] })
}

lifecycle.on('unloaded', (extensionId) => {
  for (const id of [...(live.get(extensionId)?.keys() ?? [])]) close(extensionId, id, false)
  live.delete(extensionId)
})
