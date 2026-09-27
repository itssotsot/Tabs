import { app, type Extension, type WebFrameMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { FramePlan, PlannedScript, WorldSetup } from '@shared/page-scripts'
import { JsonFile } from '../../../store'
import { hasApiPermission, hasHostAccess, loadedExtension } from '../../access'
import { lifecycle } from '../../lifecycle'
import { matchesAny, matchesGlobs, matchPattern } from '../../match-pattern'
import { defineApi, ExtensionError, type CallContext } from '../../router'
import { DEFAULT_WORLD_CSP, runInFrame, setPlanProvider, worldNumber } from './frames'
import { forgetWorldPorts, setUserWorldMessaging } from './messaging'
import { isObject, readExtensionFile, resolveTarget } from './targets'

/**
 * chrome.userScripts (Manifest V3): scripts an extension registers with code or files, injected
 * into matching frames of every page, in a USER_SCRIPT world (an isolated world per extension and
 * world id, with its configured CSP and no chrome.* APIs unless messaging is configured) or the
 * MAIN world.
 *
 * Injection is done by each web frame's preload (src/preload/page-scripts): as a document starts,
 * it asks (synchronously) which scripts match the frame, and this module answers from the frame's
 * URL, whether it's the top frame, the scripts' matches and globs, and the extension's host
 * access. The preload runs them at their runAt in Electron isolated worlds whose ids come from
 * frames.ts. Registrations apply to documents that start after them, like Chrome.
 *
 * Registrations and world configurations persist across restarts (a file per extension) and are
 * cleared when the extension updates or is uninstalled.
 */

type RunAt = 'document_start' | 'document_end' | 'document_idle'
type World = 'USER_SCRIPT' | 'MAIN'
type ScriptSource = { code: string } | { file: string }

interface StoredScript {
  id: string
  matches: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  js: ScriptSource[]
  runAt: RunAt
  allFrames: boolean
  world: World
  worldId?: string
}

interface WorldProperties {
  worldId?: string
  csp?: string
  messaging?: boolean
}

interface Persisted {
  scripts: StoredScript[]
  worlds: WorldProperties[]
}

interface ExtRuntime {
  readonly id: string
  readonly file: JsonFile<Persisted>
  /** Script id -> code of each js entry (files read from the extension). */
  readonly sources: Map<string, string[]>
}

const RUN_AT = new Set(['document_start', 'document_end', 'document_idle'])
/** The global the messaging bridge gets in a world; random per run. */
const BRIDGE_KEY = `__tabsUserScripts_${randomBytes(6).toString('hex')}`

const runtimes = new Map<string, ExtRuntime>()

const fileName = (extensionId: string): string => `extension-user-scripts-${extensionId}`

function runtimeFor(extensionId: string): ExtRuntime {
  let rt = runtimes.get(extensionId)
  if (!rt) {
    const file = new JsonFile<Persisted>(fileName(extensionId), { scripts: [], worlds: [] })
    rt = { id: extensionId, file, sources: new Map() }
    runtimes.set(extensionId, rt)
  }
  return rt
}

function persist(rt: ExtRuntime): void {
  rt.file.save()
}

app.on('will-quit', () => {
  for (const rt of runtimes.values()) {
    try {
      rt.file.flush()
    } catch {
      // Nothing more to do while quitting.
    }
  }
})

// ---- worlds ----

function worldConfig(rt: ExtRuntime, worldId: string): WorldProperties {
  const worlds = rt.file.data.worlds
  return worlds.find((w) => (w.worldId ?? '') === worldId) ?? worlds.find((w) => !w.worldId) ?? {}
}

function messagingFor(rt: ExtRuntime, worldId: string): boolean {
  return worldConfig(rt, worldId).messaging === true
}

setUserWorldMessaging((extensionId, worldId) => {
  const rt = runtimes.get(extensionId)
  return !!rt && messagingFor(rt, worldId)
})

/** How the preload sets up one of the extension's user-script worlds. */
function userWorld(rt: ExtRuntime, extension: Extension, worldId: string): WorldSetup {
  const config = worldConfig(rt, worldId)
  return {
    info: {
      id: worldNumber(`userScripts\n${rt.id}\n${worldId}`),
      name: worldId ? `User scripts: ${extension.name} (${worldId})` : `User scripts: ${extension.name}`,
      // Like Chrome, the world belongs to the extension; its CSP is the one configured.
      securityOrigin: `chrome-extension://${rt.id}`,
      csp: config.csp || DEFAULT_WORLD_CSP
    },
    runtime: config.messaging
      ? { bridgeKey: BRIDGE_KEY, extensionId: rt.id, kind: 'user', worldId, baseUrl: extension.url }
      : null
  }
}

// ---- which scripts a frame runs ----

/** Whether a stored script runs on a URL. */
function scriptMatches(extensionId: string, s: StoredScript, url: string): boolean {
  if (!hasHostAccess(extensionId, url)) return false
  if (!matchesAny(s.matches, url) || matchesAny(s.excludeMatches, url)) return false
  return matchesGlobs(url, s.includeGlobs, s.excludeGlobs)
}

function planFor(frame: WebFrameMain, url: string): FramePlan | null {
  const top = !frame.parent
  const scripts: PlannedScript[] = []
  for (const rt of runtimes.values()) {
    if (!rt.file.data.scripts.length) continue
    const extension = loadedExtension(rt.id)
    if (!extension || !hasApiPermission(rt.id, 'userScripts')) continue
    const worlds = new Map<string, WorldSetup>()
    for (const s of rt.file.data.scripts) {
      if ((!s.allFrames && !top) || !scriptMatches(rt.id, s, url)) continue
      let world: WorldSetup | null = null
      if (s.world === 'USER_SCRIPT') {
        const worldId = s.worldId ?? ''
        world = worlds.get(worldId) ?? userWorld(rt, extension, worldId)
        worlds.set(worldId, world)
      }
      scripts.push({ runAt: s.runAt, world, sources: rt.sources.get(s.id) ?? [] })
    }
  }
  return scripts.length ? { scripts } : null
}

setPlanProvider((frame, _wc, url) => planFor(frame, url))

// ---- validation ----

// ---- validation ----

const optionalStrings = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ExtensionError(`Invalid value for '${field}'.`)
  return value as string[]
}

function checkPatterns(id: string, field: string, patterns: string[] | undefined): void {
  patterns?.forEach((p, i) => {
    if (!matchPattern(p)) throw new ExtensionError(`Script with ID '${id}' has invalid value for ${field}[${i}]: '${p}' is not a valid match pattern.`)
  })
}

function checkWorldId(worldId: unknown): string | undefined {
  if (worldId === undefined || worldId === null) return undefined
  if (typeof worldId !== 'string') throw new ExtensionError("Invalid value for 'worldId'.")
  if (worldId.startsWith('_')) throw new ExtensionError('World IDs beginning with \'_\' are reserved.')
  return worldId
}

function checkSources(id: string, js: unknown): ScriptSource[] {
  if (!Array.isArray(js) || !js.length) throw new ExtensionError(`Script with ID '${id}' must specify at least one js source.`)
  return js.map((source) => {
    if (!isObject(source)) throw new ExtensionError(`Script with ID '${id}' has an invalid js source.`)
    const hasCode = typeof source.code === 'string'
    const hasFile = typeof source.file === 'string'
    if (hasCode === hasFile) throw new ExtensionError(`Script with ID '${id}': exactly one of 'code' and 'file' must be specified for each source.`)
    return hasCode ? { code: source.code as string } : { file: source.file as string }
  })
}

/** A full, valid script from what register() got (or update() merged). */
function normalize(input: Record<string, unknown>): StoredScript {
  const id = input.id
  if (typeof id !== 'string' || !id) throw new ExtensionError("Script's ID must be a non-empty string.")
  if (id.startsWith('_')) throw new ExtensionError(`Script's ID '${id}' must not start with '_'.`)
  const matches = optionalStrings(input.matches, 'matches')
  if (!matches?.length) throw new ExtensionError(`Script with ID '${id}' must specify at least one match.`)
  const excludeMatches = optionalStrings(input.excludeMatches, 'excludeMatches')
  checkPatterns(id, 'matches', matches)
  checkPatterns(id, 'excludeMatches', excludeMatches)
  const runAt = input.runAt ?? 'document_idle'
  if (typeof runAt !== 'string' || !RUN_AT.has(runAt)) throw new ExtensionError(`Script with ID '${id}' has an invalid runAt.`)
  const world = input.world ?? 'USER_SCRIPT'
  if (world !== 'USER_SCRIPT' && world !== 'MAIN') throw new ExtensionError(`Script with ID '${id}' has an invalid world.`)
  const worldId = checkWorldId(input.worldId)
  if (worldId !== undefined && world === 'MAIN') throw new ExtensionError(`Script with ID '${id}': 'worldId' can only be used with the USER_SCRIPT world.`)
  if (input.allFrames !== undefined && typeof input.allFrames !== 'boolean') throw new ExtensionError(`Script with ID '${id}' has an invalid allFrames.`)
  const out: StoredScript = { id, matches, js: checkSources(id, input.js), runAt: runAt as RunAt, allFrames: input.allFrames === true, world }
  if (excludeMatches) out.excludeMatches = excludeMatches
  const includeGlobs = optionalStrings(input.includeGlobs, 'includeGlobs')
  const excludeGlobs = optionalStrings(input.excludeGlobs, 'excludeGlobs')
  if (includeGlobs) out.includeGlobs = includeGlobs
  if (excludeGlobs) out.excludeGlobs = excludeGlobs
  if (worldId !== undefined) out.worldId = worldId
  return out
}

/** Reads each js entry's code (files from the extension folder). */
function resolveSources(extension: Extension, s: StoredScript): string[] {
  return s.js.map((source) => ('code' in source ? source.code : readExtensionFile(extension, source.file)))
}

function toPublic(s: StoredScript): chrome.userScripts.RegisteredUserScript {
  return JSON.parse(JSON.stringify(s)) as chrome.userScripts.RegisteredUserScript
}

function idsFilter(filter: unknown): string[] | null {
  if (filter === undefined || filter === null) return null
  if (!isObject(filter)) throw new ExtensionError('Invalid filter.')
  return optionalStrings(filter.ids, 'ids') ?? null
}


// ---- API ----

function register(call: CallContext, scripts: unknown): void {
  if (!Array.isArray(scripts)) throw new ExtensionError('Invalid scripts.')
  const rt = runtimeFor(call.extensionId)
  const existing = new Set(rt.file.data.scripts.map((s) => s.id))
  const added = scripts.map((input) => {
    if (!isObject(input)) throw new ExtensionError('Invalid script.')
    const s = normalize(input)
    if (existing.has(s.id)) throw new ExtensionError(`Duplicate script ID '${s.id}'`)
    existing.add(s.id)
    return s
  })
  const sources = added.map((s) => resolveSources(call.extension, s))
  added.forEach((s, i) => rt.sources.set(s.id, sources[i]))
  rt.file.data.scripts = [...rt.file.data.scripts, ...added]
  persist(rt)
}

function update(call: CallContext, scripts: unknown): void {
  if (!Array.isArray(scripts)) throw new ExtensionError('Invalid scripts.')
  const rt = runtimeFor(call.extensionId)
  const list = [...rt.file.data.scripts]
  const changed = new Map<string, StoredScript>()
  for (const input of scripts) {
    if (!isObject(input) || typeof input.id !== 'string') throw new ExtensionError('Invalid script.')
    const index = list.findIndex((s) => s.id === input.id)
    if (index < 0) throw new ExtensionError(`Script with ID '${input.id}' does not exist.`)
    const merged: Record<string, unknown> = { ...list[index] }
    for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value
    // Moving to the MAIN world drops a world id that came from before.
    if (merged.world === 'MAIN' && input.worldId === undefined) delete merged.worldId
    list[index] = normalize(merged)
    changed.set(list[index].id, list[index])
  }
  const sources = new Map([...changed.values()].map((s) => [s.id, resolveSources(call.extension, s)]))
  for (const [id, code] of sources) rt.sources.set(id, code)
  rt.file.data.scripts = list
  persist(rt)
}

function unregister(call: CallContext, filter: unknown): void {
  const rt = runtimeFor(call.extensionId)
  const ids = idsFilter(filter)
  if (ids) {
    for (const id of ids) if (!rt.file.data.scripts.some((s) => s.id === id)) throw new ExtensionError(`Nonexistent script ID '${id}'`)
  }
  const removed = new Set(ids ?? rt.file.data.scripts.map((s) => s.id))
  rt.file.data.scripts = rt.file.data.scripts.filter((s) => !removed.has(s.id))
  for (const id of removed) rt.sources.delete(id)
  persist(rt)
}

function getScripts(call: CallContext, filter: unknown): chrome.userScripts.RegisteredUserScript[] {
  const ids = idsFilter(filter)
  const scripts = runtimeFor(call.extensionId).file.data.scripts
  return (ids ? scripts.filter((s) => ids.includes(s.id)) : scripts).map(toPublic)
}

function configureWorld(call: CallContext, properties: unknown): void {
  if (!isObject(properties)) throw new ExtensionError('Invalid world properties.')
  const worldId = checkWorldId(properties.worldId)
  if (properties.csp !== undefined && typeof properties.csp !== 'string') throw new ExtensionError("Invalid value for 'csp'.")
  if (properties.messaging !== undefined && typeof properties.messaging !== 'boolean') throw new ExtensionError("Invalid value for 'messaging'.")
  const rt = runtimeFor(call.extensionId)
  const entry: WorldProperties = {}
  if (worldId !== undefined) entry.worldId = worldId
  if (typeof properties.csp === 'string') entry.csp = properties.csp
  if (typeof properties.messaging === 'boolean') entry.messaging = properties.messaging
  rt.file.data.worlds = [...rt.file.data.worlds.filter((w) => (w.worldId ?? '') !== (worldId ?? '')), entry]
  persist(rt)
}

function resetWorldConfiguration(call: CallContext, worldId: unknown): void {
  const id = checkWorldId(worldId) ?? ''
  const rt = runtimeFor(call.extensionId)
  rt.file.data.worlds = rt.file.data.worlds.filter((w) => (w.worldId ?? '') !== id)
  persist(rt)
}

async function execute(call: CallContext, injection: unknown): Promise<unknown[]> {
  if (!isObject(injection)) throw new ExtensionError('Invalid injection.')
  const world: World = injection.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT'
  if (injection.world !== undefined && injection.world !== 'MAIN' && injection.world !== 'USER_SCRIPT') throw new ExtensionError('Invalid world.')
  const worldId = checkWorldId(injection.worldId)
  if (worldId !== undefined && world === 'MAIN') throw new ExtensionError("'worldId' can only be used with the USER_SCRIPT world.")
  const sources = checkSources('execute', injection.js).map((source) => ('code' in source ? source.code : readExtensionFile(call.extension, source.file)))
  const target = resolveTarget(call, injection.target)
  const setup = world === 'MAIN' ? null : userWorld(runtimeFor(call.extensionId), call.extension, worldId ?? '')
  return Promise.all(
    target.frames.map(async (f) => {
      const base = { frameId: f.frameId, documentId: f.documentId ?? '' }
      const result = await runInFrame(f.frame, { op: 'exec', world: setup, sources, waitForDocument: injection.injectImmediately !== true, userGesture: false })
      return result.ok ? { ...base, result: result.value } : { ...base, error: result.error }
    })
  )
}

defineApi('userScripts', {
  permissions: ['userScripts'],
  methods: {
    register,
    update,
    unregister,
    getScripts,
    configureWorld,
    getWorldConfigurations: (call) => runtimeFor(call.extensionId).file.data.worlds.map((w) => ({ ...w })),
    resetWorldConfiguration,
    execute
  }
})

// ---- lifecycle ----

function deleteFile(extensionId: string): void {
  const rt = runtimes.get(extensionId)
  runtimes.delete(extensionId)
  try {
    // Writes out (and cancels) a pending save, so it can't bring the file back.
    rt?.file.flush()
  } catch {
    // Deleting it anyway.
  }
  try {
    unlinkSync(join(app.getPath('userData'), `${fileName(extensionId)}.json`))
  } catch {
    // Never saved.
  }
}

lifecycle.on('loaded', (extension, reason) => {
  if (!hasApiPermission(extension.id, 'userScripts')) return
  // Like Chrome, an update starts over (registrations and world configurations).
  if (reason === 'update' || reason === 'install') deleteFile(extension.id)
  const rt = runtimeFor(extension.id)
  for (const s of rt.file.data.scripts) {
    try {
      rt.sources.set(s.id, resolveSources(extension, s))
    } catch (err) {
      console.warn(`[extensions] user script ${s.id} of ${extension.id} has a missing file`, err)
      rt.sources.set(s.id, [])
    }
  }
})

lifecycle.on('unloaded', (extensionId) => {
  forgetWorldPorts(extensionId)
  const rt = runtimes.get(extensionId)
  if (!rt) return
  try {
    rt.file.flush()
  } catch {
    // Keep going.
  }
  runtimes.delete(extensionId)
})

lifecycle.on('uninstalled', (extensionId) => deleteFile(extensionId))
