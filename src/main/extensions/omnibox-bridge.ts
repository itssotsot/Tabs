import type { Suggestion } from '@shared/types'
import {
  omniboxInputCancelled,
  omniboxInputChanged,
  omniboxInputEntered,
  omniboxInputStarted,
  omniboxKeywordFor,
  type OmniboxDisposition
} from './api/data/index'

/**
 * The address bar side of chrome.omnibox: typing an extension's keyword and a space switches to
 * keyword mode, where the extension supplies the suggestions and Enter goes to the extension.
 * Its suggestions travel as `tabs-omnibox://<extension id>/?q=<content>` so the rest of the
 * address bar treats them like any other.
 */

const SCHEME = 'tabs-omnibox:'

/** The extension whose keyword mode is on, until the input is entered or abandoned. */
let session: string | null = null
let cancelTimer: NodeJS.Timeout | null = null

function end(): void {
  if (cancelTimer) clearTimeout(cancelTimer)
  cancelTimer = null
  if (session) omniboxInputCancelled(session)
  session = null
}

/** Entering: keyword mode ends without onInputCancelled. */
function entered(): void {
  if (cancelTimer) clearTimeout(cancelTimer)
  cancelTimer = null
  session = null
}

function suggestionUrl(extensionId: string, content: string): string {
  return `${SCHEME}//${extensionId}/?q=${encodeURIComponent(content)}`
}

/** The extension's suggestions when the text starts with its keyword, else null (and keyword mode ends). */
export async function keywordSuggestions(text: string): Promise<Suggestion[] | null> {
  const match = omniboxKeywordFor(text)
  if (!match) {
    end()
    return null
  }
  if (cancelTimer && session === match.extensionId) {
    // Typing again before the pending cancel: still the same keyword session.
    clearTimeout(cancelTimer)
    cancelTimer = null
  }
  if (session !== match.extensionId) {
    end()
    session = match.extensionId
    omniboxInputStarted(match.extensionId)
  }
  const result = await omniboxInputChanged(match.extensionId, match.input)
  const first: Suggestion = {
    type: 'extension',
    url: suggestionUrl(match.extensionId, match.input),
    title: result.defaultSuggestion?.text || match.input || match.name,
    detail: match.name
  }
  return [
    first,
    ...result.suggestions.map((s) => ({ type: 'extension' as const, url: suggestionUrl(match.extensionId, s.content), title: s.text, detail: match.name }))
  ]
}

/**
 * Handles what the address bar is about to open when it's for an extension (a keyword suggestion,
 * or keyword text entered as typed). Returns true when it went to the extension instead.
 */
export function enterOmniboxInput(input: string, disposition: OmniboxDisposition): boolean {
  if (input.startsWith(`${SCHEME}//`)) {
    try {
      const url = new URL(input)
      omniboxInputEntered(url.hostname, url.searchParams.get('q') ?? '', disposition)
    } catch {
      return true
    }
    entered()
    return true
  }
  const match = omniboxKeywordFor(input)
  if (!match) return false
  omniboxInputEntered(match.extensionId, match.input, disposition)
  entered()
  return true
}

/** The address bar lost focus or was cleared without entering anything. */
export function omniboxClosed(): void {
  // The address bar hides its list just before sending what was entered; wait for that first.
  if (!session || cancelTimer) return
  cancelTimer = setTimeout(end, 150)
}
