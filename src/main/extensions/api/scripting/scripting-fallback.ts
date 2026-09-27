import { createHash, randomBytes } from 'node:crypto'
import type { WorldSetup } from '@shared/page-scripts'
import { defineApi, ExtensionError, type CallContext } from '../../router'
import { DEFAULT_WORLD_CSP, runInFrame, worldNumber } from './frames'
import { isObject, readExtensionFile, resolveTarget, type ResolvedTarget } from './targets'

/**
 * chrome.scripting where Electron's own implementation refuses: it doesn't know about activeTab
 * (or optional host permissions granted later), so executeScript after a click on the extension's
 * button fails with "Cannot access contents of url". The extension-side wrapper
 * (custom/scripting.ts) calls Electron first and, on that error, calls these, which inject through
 * the frames' preload (src/preload/page-scripts) when hasHostAccess says the extension may.
 *
 * ISOLATED injections go into an Electron isolated world of the extension's own (not the one
 * Electron's content scripts run in, which the preload can't reach). It gets a minimal
 * chrome.runtime: id, getURL, and sendMessage to the extension's runtime.onMessage listeners.
 */

const BRIDGE_KEY = `__tabsScripting_${randomBytes(6).toString('hex')}`

function isolatedWorld(call: CallContext): WorldSetup {
  return {
    info: {
      id: worldNumber(`scripting\n${call.extensionId}`),
      name: call.extension.name,
      securityOrigin: `chrome-extension://${call.extensionId}`,
      csp: DEFAULT_WORLD_CSP
    },
    runtime: { bridgeKey: BRIDGE_KEY, extensionId: call.extensionId, kind: 'isolated', worldId: '', baseUrl: call.extension.url }
  }
}

function target(call: CallContext, injection: Record<string, unknown>, nativeError: unknown): ResolvedTarget {
  const denied = typeof nativeError === 'string' && nativeError ? nativeError : undefined
  return resolveTarget(call, injection.target, denied)
}

function sourcesOf(call: CallContext, injection: Record<string, unknown>, key: 'code' | 'css'): string[] {
  const inline = injection[key]
  const files = injection.files
  const message = `Exactly one of '${key === 'code' ? 'func' : 'css'}' and 'files' must be specified.`
  if (typeof inline === 'string' && Array.isArray(files)) throw new ExtensionError(message)
  if (typeof inline === 'string') return [inline]
  if (Array.isArray(files) && files.length) return files.map((f) => readExtensionFile(call.extension, f))
  throw new ExtensionError(message)
}

/** injection: { target, code (the serialized func call), files, world, injectImmediately }. */
async function executeScript(call: CallContext, injection: unknown, nativeError: unknown): Promise<chrome.scripting.InjectionResult<unknown>[]> {
  if (!isObject(injection)) throw new ExtensionError('Invalid injection.')
  const sources = sourcesOf(call, injection, 'code')
  const resolved = target(call, injection, nativeError)
  const world = injection.world === 'MAIN' ? null : isolatedWorld(call)
  const results = await Promise.all(
    resolved.frames.map(async (f) => {
      const result = await runInFrame(f.frame, { op: 'exec', world, sources, waitForDocument: injection.injectImmediately !== true, userGesture: true })
      // Like Chrome: a script that throws gives no result (the error goes to the page's console).
      if (!result.ok && result.scriptError) console.warn(`[extensions] script from ${call.extensionId} threw:`, result.error)
      return { frameId: f.frameId, documentId: f.documentId ?? '', result: result.ok ? result.value : null, failed: !result.ok && !result.scriptError, error: result.ok ? '' : result.error }
    })
  )
  // A single frame that couldn't be injected is an error; with several, the failed ones are skipped.
  if (results.length === 1 && results[0].failed) throw new ExtensionError(results[0].error || 'Script injection failed.')
  return results.filter((r) => !r.failed).map(({ frameId, documentId, result }) => ({ frameId, documentId, result }) as chrome.scripting.InjectionResult<unknown>)
}

async function changeCSS(call: CallContext, injection: unknown, nativeError: unknown, add: boolean): Promise<void> {
  if (!isObject(injection)) throw new ExtensionError('Invalid injection.')
  const css = sourcesOf(call, injection, 'css').join('\n')
  const cssOrigin = injection.origin === 'USER' ? 'user' : 'author'
  const cssKey = createHash('sha1').update(`${call.extensionId}\n${cssOrigin}\n${css}`).digest('hex')
  const resolved = target(call, injection, nativeError)
  await Promise.all(
    resolved.frames.map((f) =>
      runInFrame(f.frame, { op: add ? 'insertCSS' : 'removeCSS', world: null, sources: [], waitForDocument: false, userGesture: false, css, cssOrigin, cssKey })
    )
  )
}

defineApi('scripting', {
  permissions: ['scripting'],
  methods: {
    _executeScript: executeScript,
    _insertCSS: (call, injection, nativeError) => changeCSS(call, injection, nativeError, true),
    _removeCSS: (call, injection, nativeError) => changeCSS(call, injection, nativeError, false)
  }
})
