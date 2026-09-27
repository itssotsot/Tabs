/**
 * How the main process and web frames' preload (src/preload/page-scripts) run extension code in
 * pages: user scripts (chrome.userScripts), and chrome.scripting injections the main process does
 * itself (activeTab). Code runs in Electron isolated worlds the preload sets up, or the main world.
 */
export const PAGE_CHANNEL = {
  /** sendSync(DocumentStart) -> FramePlan | null — a frame's document starts: which user scripts to run. */
  start: 'tabs-page:start',
  /** main -> frame: (RunRequest) — run code or CSS in the frame. */
  run: 'tabs-page:run',
  /** frame -> main: (id, RunResult). */
  runResult: 'tabs-page:run-result',
  /** frame -> main: (WorldEnvelope) — a world's chrome.runtime message (sendMessage, connect, port traffic). */
  fromWorld: 'tabs-page:from-world',
  /** main -> frame: (WorldEnvelope) — to a world (message replies, port traffic). */
  toWorld: 'tabs-page:to-world'
} as const

export type RunAt = 'document_start' | 'document_end' | 'document_idle'

export interface DocumentStart {
  /** Random id of this document, used as its Chrome documentId. */
  token: string
  url: string
}

/** webFrame.setIsolatedWorldInfo for one world. World ids are assigned by the main process, stable per run. */
export interface WorldInfo {
  id: number
  name: string
  securityOrigin: string
  csp: string
}

/** What the world's chrome.runtime needs (see src/preload/page-scripts/world-runtime.ts). */
export interface WorldRuntimeConfig {
  /** Global the messaging bridge is exposed as, in the world. */
  bridgeKey: string
  extensionId: string
  /** `user`: a user-script world. `isolated`: the chrome.scripting fallback's world. */
  kind: 'user' | 'isolated'
  /** User worlds: the world id ('' for the default one). */
  worldId: string
  /** The extension's base URL, for runtime.getURL. */
  baseUrl: string
}

export interface WorldSetup {
  info: WorldInfo
  /** chrome.runtime messaging for the world, or null for none. */
  runtime: WorldRuntimeConfig | null
}

export interface PlannedScript {
  runAt: RunAt
  /** Null: the main world. */
  world: WorldSetup | null
  sources: string[]
}

export interface FramePlan {
  /** In the order they run within each runAt. */
  scripts: PlannedScript[]
}

export interface RunRequest {
  id: number
  /** The document it's meant for; a frame that has moved on refuses. */
  token: string
  op: 'exec' | 'insertCSS' | 'removeCSS'
  /** exec: null for the main world. */
  world: WorldSetup | null
  sources: string[]
  /** exec: wait until the document has been parsed. */
  waitForDocument: boolean
  userGesture: boolean
  css?: string
  cssOrigin?: 'user' | 'author'
  /** insertCSS/removeCSS: identifies an insertion, so removeCSS undoes the matching one. */
  cssKey?: string
}

export type RunResult = { ok: true; value: unknown } | { ok: false; error: string; scriptError: boolean }

export interface WorldEnvelope {
  token: string
  extensionId: string
  kind: 'user' | 'isolated'
  worldId: string
  /** The message, as JSON (like Chrome's messaging, which serializes to JSON). */
  json: string
}
