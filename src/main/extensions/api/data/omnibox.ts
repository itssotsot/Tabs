import { allLoadedExtensions, loadedExtension, manifestOf } from '../../access'
import { lifecycle } from '../../lifecycle'
import { extensionDisplay } from '../../manager'
import { defineApi, defineEvent, emit, emitForResponse, ExtensionError } from '../../router'
import { omniboxDescriptionText, omniboxSegments, type OmniboxSegment } from './omnibox-text'
import { isObject, isString } from './util'

/**
 * chrome.omnibox: extensions with `omnibox.keyword` in their manifest get a keyword mode in the
 * address bar ("keyword<space>text"). The address bar drives it through the exported functions
 * below; this module talks to the extension.
 */

export interface OmniboxSuggestion {
  /** What goes to onInputEntered when this suggestion is picked. */
  content: string
  /** The description as the extension wrote it (XML). */
  description: string
  /** Plain text of the description. */
  text: string
  segments: OmniboxSegment[]
  deletable: boolean
}

export interface OmniboxKeyword {
  extensionId: string
  keyword: string
  name: string
  icon: string | null
}

export interface OmniboxResult {
  /** setDefaultSuggestion's text with `%s` filled in, if the extension set one. */
  defaultSuggestion: { description: string; text: string; segments: OmniboxSegment[] } | null
  suggestions: OmniboxSuggestion[]
}

export type OmniboxDisposition = 'currentTab' | 'newForegroundTab' | 'newBackgroundTab'

const MAX_SUGGESTIONS = 12
const defaults = new Map<string, string>()

/** Every running extension's omnibox keyword. */
export function omniboxKeywords(): OmniboxKeyword[] {
  const out: OmniboxKeyword[] = []
  for (const ext of allLoadedExtensions()) {
    const keyword = (ext.manifest as { omnibox?: { keyword?: unknown } }).omnibox?.keyword
    if (!isString(keyword) || !keyword.trim()) continue
    const display = extensionDisplay(ext.id)
    out.push({ extensionId: ext.id, keyword: keyword.trim(), name: display?.name ?? ext.name, icon: display?.icon ?? null })
  }
  return out
}

/**
 * The extension whose keyword starts the typed text ("kw rest of text"), with the text after the
 * keyword. Null when the text doesn't start with a keyword followed by a space.
 */
export function omniboxKeywordFor(text: string): (OmniboxKeyword & { input: string }) | null {
  const trimmed = text.replace(/^\s+/, '')
  const space = trimmed.search(/\s/)
  if (space <= 0) return null
  const word = trimmed.slice(0, space).toLowerCase()
  const match = omniboxKeywords().find((k) => k.keyword.toLowerCase() === word)
  return match ? { ...match, input: trimmed.slice(space + 1) } : null
}

function hasOmnibox(extensionId: string): boolean {
  return !!loadedExtension(extensionId) && manifestOf(extensionId)?.omnibox !== undefined
}

/** The user entered the extension's keyword mode. */
export function omniboxInputStarted(extensionId: string): void {
  if (hasOmnibox(extensionId)) emit('omnibox.onInputStarted', [], { extensionId })
}

/** The text after the keyword changed: asks the extension for suggestions (empty if it has none within 5 s). */
export async function omniboxInputChanged(extensionId: string, text: string): Promise<OmniboxResult> {
  const defaultDescription = defaults.get(extensionId)
  const filled = defaultDescription?.replace(/%s/g, text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`))
  const result: OmniboxResult = {
    defaultSuggestion: filled ? { description: filled, text: omniboxDescriptionText(filled), segments: omniboxSegments(filled) } : null,
    suggestions: []
  }
  if (!hasOmnibox(extensionId)) return result
  const answer = await emitForResponse(extensionId, 'omnibox.onInputChanged', [text], 5000)
  if (!Array.isArray(answer)) return result
  for (const s of answer.slice(0, MAX_SUGGESTIONS)) {
    if (!isObject(s) || !isString(s.content) || !isString(s.description)) continue
    result.suggestions.push({
      content: s.content,
      description: s.description,
      text: omniboxDescriptionText(s.description),
      segments: omniboxSegments(s.description),
      deletable: s.deletable === true
    })
  }
  return result
}

/** The user accepted the text (or a suggestion's content). */
export function omniboxInputEntered(extensionId: string, text: string, disposition: OmniboxDisposition = 'currentTab'): void {
  if (hasOmnibox(extensionId)) emit('omnibox.onInputEntered', [text, disposition], { extensionId })
}

/** The user left keyword mode without accepting anything. */
export function omniboxInputCancelled(extensionId: string): void {
  if (hasOmnibox(extensionId)) emit('omnibox.onInputCancelled', [], { extensionId })
}

/** The user deleted one of the extension's suggestions marked deletable (by its description text). */
export function omniboxDeleteSuggestion(extensionId: string, text: string): void {
  if (hasOmnibox(extensionId)) emit('omnibox.onDeleteSuggestion', [text], { extensionId })
}

defineApi('omnibox', {
  manifestKey: 'omnibox',
  methods: {
    setDefaultSuggestion: (call, suggestion) => {
      if (!isObject(suggestion) || !isString(suggestion.description)) throw new ExtensionError('Invalid suggestion: description is required.')
      defaults.set(call.extensionId, suggestion.description)
    }
  }
})

for (const name of ['onInputStarted', 'onInputChanged', 'onInputEntered', 'onInputCancelled', 'onDeleteSuggestion']) {
  defineEvent(`omnibox.${name}`)
}

lifecycle.on('unloaded', (extensionId) => defaults.delete(extensionId))
