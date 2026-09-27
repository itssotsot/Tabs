import type { ContextMenuParams, Input, MenuItemConstructorOptions } from 'electron'
import type { Tab } from './tab'
import type { BrowserWindowController } from './window'

/**
 * Places where the browser asks Chrome extensions for something (menu items, shortcuts, the new
 * tab page). The extensions code registers these at startup, so the window, tab and menu code
 * doesn't import it (which would be a cycle).
 */
export const extensionHooks = {
  /** Items extensions add to a page's right-click menu. */
  pageMenuItems: (_c: BrowserWindowController, _tab: Tab, _params: ContextMenuParams): MenuItemConstructorOptions[] => [],
  /** Runs an extension's keyboard shortcut. True when one matched. */
  shortcut: (_input: Input, _c: BrowserWindowController): boolean => false,
  /** An extension's page that replaces the new tab page, or null. */
  newTabOverride: (): string | null => null,
  /** chrome.contentSettings: 'allow' | 'block' | 'ask' | 'session_only' an extension set for a site, or undefined. */
  contentSetting: (_type: string, _url: string, _topUrl?: string): string | undefined => undefined,
  /** A web permission for an extension's own page, from its manifest permissions: true, or undefined to ask as usual. */
  extensionPagePermission: (_permission: string, _url: string): boolean | undefined => undefined,
  /** chrome.privacy: the value an extension set for a setting (e.g. 'network.networkPredictionEnabled'), or undefined. */
  privacySetting: (_path: string): unknown => undefined
}
