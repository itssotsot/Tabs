import { BrowserWindow, dialog, nativeImage, type MessageBoxOptions } from 'electron'
import { extensionDisplay } from '../../manager'
import { lastFocusedWindow } from '../../tabs-model'

/** Small helpers shared by the data and account APIs. */

export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const isString = (v: unknown): v is string => typeof v === 'string'

/** Chrome's `double` times from Date/number/ISO string arguments. NaN when unreadable. */
export function toMillis(v: unknown): number {
  if (isNumber(v)) return v
  if (typeof v === 'string') return Date.parse(v)
  if (v instanceof Date) return v.getTime()
  return NaN
}

/**
 * Asks the user to confirm something an extension wants to do, with the extension's icon.
 * Resolves true for the first button.
 */
export async function confirmForExtension(
  extensionId: string,
  options: { message: string; detail?: string; confirm: string; cancel?: string; type?: MessageBoxOptions['type'] }
): Promise<boolean> {
  const display = extensionDisplay(extensionId)
  const icon = display?.icon ? nativeImage.createFromDataURL(display.icon) : undefined
  const box: MessageBoxOptions = {
    type: options.type ?? 'question',
    buttons: [options.confirm, options.cancel ?? 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    message: options.message,
    detail: options.detail
  }
  const parent = lastFocusedWindow()?.win ?? BrowserWindow.getFocusedWindow()
  const { response } = await (parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box))
  return response === 0
}

/** The extension's name for dialogs. */
export function extensionName(extensionId: string): string {
  return extensionDisplay(extensionId)?.name ?? extensionId
}
