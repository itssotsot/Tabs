import { WebContentsView, type WebContents } from 'electron'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { asObject } from './util'

/**
 * chrome.tts on the system's speech voices, through the Web Speech API in a hidden page (a
 * WebContentsView that isn't shown anywhere, in its own in-memory session). The page reports
 * speech events as console messages; they reach the extension's `onEvent` callback through an
 * internal event (see installTtsSpeak in src/preload/extension-api/custom/platform.ts).
 */

type EventType = 'start' | 'end' | 'word' | 'sentence' | 'marker' | 'interrupted' | 'cancelled' | 'error' | 'pause' | 'resume'

interface Utterance {
  id: number
  extensionId: string
  requestId?: string
  desired: Set<string> | null
  started: boolean
}

const FINAL = new Set<EventType>(['end', 'interrupted', 'cancelled', 'error'])
const EVENT_TYPES: EventType[] = ['start', 'end', 'word', 'sentence', 'marker', 'interrupted', 'cancelled', 'error', 'pause', 'resume']
const MESSAGE_PREFIX = '__tabs_tts:'
const IDLE_MS = 2 * 60_000
const MAX_UTTERANCE = 32_768

/** Runs in the hidden page. */
const PAGE_SCRIPT = `(() => {
  if (window.__tts) return
  const post = (m) => console.log(${JSON.stringify(MESSAGE_PREFIX)} + JSON.stringify(m))
  const live = new Map()
  const list = () => speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, local: v.localService }))
  speechSynthesis.addEventListener('voiceschanged', () => post({ type: 'voiceschanged' }))
  window.__tts = {
    speak(id, text, o) {
      const u = new SpeechSynthesisUtterance(text)
      if (o.voiceName) {
        const v = speechSynthesis.getVoices().find((v) => v.name === o.voiceName)
        if (v) { u.voice = v; u.lang = v.lang }
      }
      if (o.lang) u.lang = o.lang
      if (typeof o.rate === 'number') u.rate = o.rate
      if (typeof o.pitch === 'number') u.pitch = o.pitch
      if (typeof o.volume === 'number') u.volume = o.volume
      const done = () => live.delete(id)
      u.onstart = () => post({ id, type: 'start', charIndex: 0 })
      u.onend = () => { done(); post({ id, type: 'end', charIndex: text.length }) }
      u.onerror = (e) => {
        done()
        const type = e.error === 'interrupted' ? 'interrupted' : e.error === 'canceled' ? 'cancelled' : 'error'
        post({ id, type, charIndex: e.charIndex || 0, errorMessage: e.error })
      }
      u.onboundary = (e) => post({ id, type: e.name === 'sentence' ? 'sentence' : 'word', charIndex: e.charIndex, length: e.charLength })
      u.onpause = (e) => post({ id, type: 'pause', charIndex: e.charIndex })
      u.onresume = (e) => post({ id, type: 'resume', charIndex: e.charIndex })
      u.onmark = (e) => post({ id, type: 'marker', charIndex: e.charIndex })
      // Held so the events keep coming (Chromium drops them for collected utterances).
      live.set(id, u)
      speechSynthesis.speak(u)
    },
    stop() { speechSynthesis.cancel() },
    pause() { speechSynthesis.pause() },
    resume() { speechSynthesis.resume() },
    voices() {
      if (list().length) return Promise.resolve(list())
      return new Promise((resolve) => {
        const finish = () => resolve(list())
        speechSynthesis.addEventListener('voiceschanged', finish, { once: true })
        setTimeout(finish, 1500)
      })
    }
  }
})()`

let engineView: WebContentsView | null = null
let engineReady: Promise<WebContents> | null = null
let idleTimer: NodeJS.Timeout | null = null
let queue: Utterance[] = []
let nextId = 1

function engine(): Promise<WebContents> {
  if (engineReady) return engineReady
  engineReady = (async () => {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'tabs-tts',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    engineView = view
    const wc = view.webContents
    wc.on('console-message', (details) => {
      const message = (details as unknown as { message?: string }).message ?? ''
      if (!message.startsWith(MESSAGE_PREFIX)) return
      try {
        onPageEvent(JSON.parse(message.slice(MESSAGE_PREFIX.length)))
      } catch {
        // Not ours.
      }
    })
    wc.once('destroyed', () => {
      if (engineView === view) {
        engineView = null
        engineReady = null
      }
    })
    await wc.loadURL('about:blank')
    await wc.executeJavaScript(PAGE_SCRIPT)
    return wc
  })()
  engineReady.catch(() => {
    engineReady = null
  })
  return engineReady
}

/** Runs a call in the speech page, with a user gesture (speechSynthesis needs one). */
async function run<T = unknown>(code: string): Promise<T> {
  const wc = await engine()
  return (await wc.executeJavaScript(code, true)) as T
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (queue.length || !engineView) return
    const wc = engineView.webContents
    engineView = null
    engineReady = null
    if (!wc.isDestroyed()) wc.close()
  }, IDLE_MS)
}

function deliver(u: Utterance, type: EventType, extra: Record<string, unknown> = {}): void {
  const isFinalEvent = FINAL.has(type)
  if (!u.requestId || (!isFinalEvent && u.desired && !u.desired.has(type))) return
  const event: Record<string, unknown> = { type, isFinalEvent, charIndex: 0, ...extra }
  emit('tts.__utteranceEvent', [u.requestId, event], { extensionId: u.extensionId, wake: false })
}

function onPageEvent(message: { id?: number; type?: string; charIndex?: number; length?: number; errorMessage?: string }): void {
  if (message.type === 'voiceschanged') {
    emit('tts.onVoicesChanged', [])
    return
  }
  const u = queue.find((q) => q.id === message.id)
  const type = message.type as EventType
  if (!u || !EVENT_TYPES.includes(type)) return
  if (type === 'start') u.started = true
  if (FINAL.has(type)) {
    queue = queue.filter((q) => q !== u)
    if (!queue.length) scheduleIdle()
  }
  const extra: Record<string, unknown> = { charIndex: message.charIndex ?? 0 }
  if (typeof message.length === 'number') extra.length = message.length
  if (type === 'error') extra.errorMessage = message.errorMessage ?? 'Error'
  deliver(u, type, extra)
}

/** Ends everything queued: the one speaking is interrupted, the rest are cancelled. */
function cancelAll(): void {
  const pending = queue
  queue = []
  pending.forEach((u, i) => deliver(u, i === 0 && u.started ? 'interrupted' : 'cancelled'))
}

function readOptions(value: unknown): Record<string, unknown> {
  const o = asObject(value)
  const range = (key: string, min: number, max: number): void => {
    const v = o[key]
    if (v !== undefined && (typeof v !== 'number' || v < min || v > max)) throw new ExtensionError(`Invalid ${key}.`)
  }
  range('rate', 0.1, 10)
  range('pitch', 0, 2)
  range('volume', 0, 1)
  if (o.lang !== undefined && (typeof o.lang !== 'string' || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*$/.test(o.lang))) throw new ExtensionError('Invalid lang.')
  return o
}

async function speak(call: CallContext, utterance: unknown, rawOptions: unknown, requestId?: unknown): Promise<void> {
  if (typeof utterance !== 'string') throw new ExtensionError('Invalid utterance.')
  if (utterance.length > MAX_UTTERANCE) throw new ExtensionError('Utterance length is too long.')
  const options = readOptions(rawOptions)
  // The system voices speak SSML markup literally; read just the text.
  const text = /^\s*<speak[\s>]/i.test(utterance) ? utterance.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : utterance
  const desired = Array.isArray(options.desiredEventTypes) ? new Set(options.desiredEventTypes.map(String)) : null
  if (!options.enqueue) {
    cancelAll()
    await run('window.__tts.stop()')
  }
  const u: Utterance = { id: nextId++, extensionId: call.extensionId, requestId: typeof requestId === 'string' ? requestId : undefined, desired, started: false }
  queue.push(u)
  if (idleTimer) clearTimeout(idleTimer)
  const pageOptions = { voiceName: options.voiceName, lang: options.lang, rate: options.rate, pitch: options.pitch, volume: options.volume }
  try {
    await run(`window.__tts.speak(${u.id}, ${JSON.stringify(text)}, ${JSON.stringify(pageOptions)})`)
  } catch (err) {
    queue = queue.filter((q) => q !== u)
    deliver(u, 'error', { errorMessage: String(err) })
    throw new ExtensionError('Speech is not available.')
  }
}

async function getVoices(): Promise<chrome.tts.TtsVoice[]> {
  const voices = await run<{ name: string; lang: string; local: boolean }[]>('window.__tts.voices()')
  if (!queue.length) scheduleIdle()
  return voices.map(
    (v) =>
      ({
        voiceName: v.name,
        lang: v.lang,
        remote: !v.local,
        eventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error', 'pause', 'resume']
      }) as chrome.tts.TtsVoice
  )
}

defineApi('tts', {
  permissions: ['tts'],
  methods: {
    speak,
    stop: async () => {
      cancelAll()
      if (engineReady) await run('window.__tts.stop()')
    },
    pause: async () => {
      if (engineReady) await run('window.__tts.pause()')
    },
    resume: async () => {
      if (engineReady) await run('window.__tts.resume()')
    },
    isSpeaking: () => queue.length > 0,
    getVoices
  }
})

defineEvent('tts.onVoicesChanged', { permissions: ['tts'] })
/** Carries speak()'s onEvent callbacks back to the extension (not part of the API). */
defineEvent('tts.__utteranceEvent', { permissions: ['tts'] })
