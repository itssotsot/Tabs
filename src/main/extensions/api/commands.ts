import type { Input } from 'electron'
import type { BrowserWindowController } from '../../window'
import { allLoadedExtensions, grantActiveTab, manifestOf } from '../access'
import { localizedManifestString } from '../manager'
import { defineApi, defineEvent, emit } from '../router'
import { chromeTabId, toChromeTab } from '../tabs-model'
import { openSidePanel } from './side-panel'

/**
 * chrome.commands: keyboard shortcuts extensions declare in their manifest. `_execute_action`
 * opens the extension's popup (or clicks its button); other commands go to commands.onCommand.
 */

const isMac = process.platform === 'darwin'

interface ManifestCommand {
  suggested_key?: string | Record<string, string>
  description?: string
  global?: boolean
}

interface Shortcut {
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  /** The real Control key on macOS ("MacCtrl"). */
  macCtrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

const KEY_NAMES: Record<string, string> = {
  comma: ',',
  period: '.',
  space: ' ',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  mediatracknext: 'MediaTrackNext',
  medianexttrack: 'MediaTrackNext',
  mediatrackprevious: 'MediaTrackPrevious',
  mediaprevioustrack: 'MediaTrackPrevious',
  mediaplaypause: 'MediaPlayPause',
  mediastop: 'MediaStop'
}

/** Shortcuts the app itself uses; extensions can't take them (Chrome reserves its own the same way). */
const RESERVED = new Set(['t', 'n', 'w', 'q', 'l', 'r', 'p', 's', 'f', 'd', 'y', 'h', ',', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '=', '-', '+'])
const RESERVED_SHIFT = new Set(['t', 'w', 'a', 's', 'l', 'n'])

function platformKey(suggested: string | Record<string, string> | undefined): string | null {
  if (!suggested) return null
  if (typeof suggested === 'string') return suggested
  const platform = isMac ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
  return suggested[platform] ?? suggested.default ?? null
}

function parseShortcut(text: string): Shortcut | null {
  const parts = text.split('+').map((p) => p.trim())
  if (parts.length < 2) return /^Media/i.test(text) ? { mod: false, macCtrl: false, alt: false, shift: false, key: KEY_NAMES[text.toLowerCase()] ?? text } : null
  const s: Shortcut = { mod: false, macCtrl: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    const p = part.toLowerCase()
    if (p === 'ctrl' || p === 'command') s.mod = true
    else if (p === 'macctrl') s.macCtrl = true
    else if (p === 'alt' || p === 'option') s.alt = true
    else if (p === 'shift') s.shift = true
    else if (p.length === 1) s.key = p
    else if (KEY_NAMES[p]) s.key = KEY_NAMES[p]
    else if (/^f\d{1,2}$/.test(p)) s.key = p.toUpperCase()
    else return null
  }
  if (!s.key || (!s.mod && !s.macCtrl && !s.alt)) return null
  return s
}

function formatShortcut(s: Shortcut): string {
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key.replace(/^Arrow/, '')
  if (isMac) return `${s.macCtrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${key}`
  return [s.mod && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', key].filter(Boolean).join('+')
}

function isReserved(s: Shortcut): boolean {
  if (!s.mod || s.alt || s.macCtrl) return false
  return s.shift ? RESERVED_SHIFT.has(s.key) : RESERVED.has(s.key)
}

interface Command {
  name: string
  description: string
  shortcut: Shortcut | null
}

function commandsOf(extensionId: string): Command[] {
  const declared = (manifestOf(extensionId)?.commands ?? {}) as Record<string, ManifestCommand>
  return Object.entries(declared).map(([name, c]) => {
    const text = platformKey(c.suggested_key)
    const shortcut = text ? parseShortcut(text) : null
    const description =
      localizedManifestString(extensionId, c.description) ||
      (name === '_execute_action' || name === '_execute_browser_action' ? 'Activate the extension' : name === '_execute_side_panel' ? 'Open the side panel' : '')
    return { name, description, shortcut: shortcut && !isReserved(shortcut) ? shortcut : null }
  })
}

/** An extension's shortcuts, for the extensions page. */
export function shortcutsFor(extensionId: string): { description: string; shortcut: string }[] {
  return commandsOf(extensionId)
    .filter((c) => c.shortcut)
    .map((c) => ({ description: c.description, shortcut: formatShortcut(c.shortcut!) }))
}

function matches(s: Shortcut, input: Input): boolean {
  const mod = isMac ? input.meta : input.control
  const macCtrl = isMac ? input.control : false
  if (s.mod !== mod || s.macCtrl !== macCtrl || s.alt !== input.alt || s.shift !== input.shift) return false
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (key === s.key) return true
  // With Alt/Shift held, key is the typed character (e.g. "Ω"); compare the physical key too.
  const code = input.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase() === s.key
  if (/^Digit\d$/.test(code)) return code.slice(5) === s.key
  return (code === 'Comma' && s.key === ',') || (code === 'Period' && s.key === '.') || (code === 'Space' && s.key === ' ')
}

/** Runs an extension shortcut for a key press in a window. Returns true when one matched. */
export function handleExtensionShortcut(input: Input, c: BrowserWindowController): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false
  for (const extension of allLoadedExtensions()) {
    const command = commandsOf(extension.id).find((cmd) => cmd.shortcut && matches(cmd.shortcut, input))
    if (!command) continue
    const tab = c.activeTab
    if (tab) grantActiveTab(extension.id, chromeTabId(tab))
    if (command.name === '_execute_action' || command.name === '_execute_browser_action' || command.name === '_execute_page_action') {
      // The browser UI knows where the button is; the popup opens from there.
      c.sendCommand({ type: 'open-extension-popup', extensionId: extension.id })
    } else if (command.name === '_execute_side_panel') {
      try {
        openSidePanel(c, extension.id)
      } catch {
        // No panel for this tab.
      }
    } else {
      emit('commands.onCommand', (id) => [command.name, tab ? toChromeTab(tab, c, id) : undefined], { extensionId: extension.id, force: true })
    }
    return true
  }
  return false
}

defineApi('commands', {
  methods: {
    getAll: (call) =>
      commandsOf(call.extensionId).map((c) => ({ name: c.name, description: c.description, shortcut: c.shortcut ? formatShortcut(c.shortcut) : '' }))
  }
})

defineEvent('commands.onCommand')
