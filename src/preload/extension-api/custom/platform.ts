/**
 * Platform installers that need more than a spec. Each runs in the extension's world (see
 * core.ts): self-contained, using only the helper at `globalThis[Symbol.for('tabs.extensions')]`.
 */

/**
 * ChromeSetting objects (get / set / clear / onChange) for chrome.privacy.* and chrome.proxy.settings,
 * all backed by the main process's internal `chromeSetting` namespace.
 */
export function installChromeSettings(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext) return
  const GROUPS: [string, string[]][] = [
    [
      'privacy',
      [
        'privacy.network.networkPredictionEnabled',
        'privacy.network.webRTCIPHandlingPolicy',
        'privacy.services.alternateErrorPagesEnabled',
        'privacy.services.autofillEnabled',
        'privacy.services.autofillAddressEnabled',
        'privacy.services.autofillCreditCardEnabled',
        'privacy.services.passwordSavingEnabled',
        'privacy.services.safeBrowsingEnabled',
        'privacy.services.safeBrowsingExtendedReportingEnabled',
        'privacy.services.searchSuggestEnabled',
        'privacy.services.spellingServiceEnabled',
        'privacy.services.translationServiceEnabled',
        'privacy.websites.thirdPartyCookiesAllowed',
        'privacy.websites.hyperlinkAuditingEnabled',
        'privacy.websites.referrersEnabled',
        'privacy.websites.doNotTrackEnabled',
        'privacy.websites.protectedContentEnabled',
        'privacy.websites.topicsEnabled',
        'privacy.websites.fledgeEnabled',
        'privacy.websites.adMeasurementEnabled',
        'privacy.websites.relatedWebsiteSetsEnabled'
      ]
    ],
    ['proxy', ['proxy.settings']]
  ]
  for (const [permission, paths] of GROUPS) {
    if (!ext.declares(permission)) continue
    for (const path of paths) {
      try {
        const dot = path.lastIndexOf('.')
        const parent = ext.namespace(path.slice(0, dot))
        const withPath = { before: (args: any[]) => [path, args[0] ?? {}] }
        ext.define(parent, {
          [path.slice(dot + 1)]: {
            get: ext.fn('chromeSetting', 'get', withPath),
            set: ext.fn('chromeSetting', 'set', withPath),
            clear: ext.fn('chromeSetting', 'clear', withPath),
            onChange: ext.event(`${path}.onChange`)
          }
        })
      } catch (err) {
        console.error(`[extensions] couldn't set up chrome.${path}`, err)
      }
    }
  }
}

/** chrome.contentSettings.<type>: ContentSetting objects that pass their type to the main process. */
export function installContentSettings(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('contentSettings')) return
  const TYPES = [
    'automaticDownloads',
    'autoVerify',
    'camera',
    'clipboard',
    'cookies',
    'images',
    'javascript',
    'location',
    'microphone',
    'notifications',
    'plugins',
    'popups',
    'unsandboxedPlugins'
  ]
  const target = ext.namespace('contentSettings')
  const props: Record<string, unknown> = {}
  for (const type of TYPES) {
    const withType = { before: (args: any[]) => [type, ...args] }
    props[type] = {
      get: ext.fn('contentSettings', 'get', withType),
      set: ext.fn('contentSettings', 'set', withType),
      clear: ext.fn('contentSettings', 'clear', withType),
      getResourceIdentifiers: ext.fn('contentSettings', 'getResourceIdentifiers', withType)
    }
  }
  ext.define(target, props)
}

/**
 * tts.speak: its `onEvent` callback stays here; the main process sends the utterance's events
 * back through an internal event, tagged with the id this context gave the utterance.
 */
export function installTtsSpeak(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('tts') || !chrome.tts) return
  const handlers = new Map<string, (event: any) => void>()
  const prefix = Math.random().toString(36).slice(2)
  let counter = 0
  let listening = false
  const listen = (): void => {
    if (listening) return
    listening = true
    ext.event('tts.__utteranceEvent').addListener((requestId: string, event: any) => {
      const handler = handlers.get(requestId)
      if (!handler) return
      if (event?.isFinalEvent) handlers.delete(requestId)
      try {
        handler(event)
      } catch (err) {
        console.error(err)
      }
    })
  }
  ext.define(chrome.tts as any, {
    speak: ext.fn('tts', 'speak', {
      before: (args: any[]) => {
        const [utterance, options] = args
        const opts = { ...(options && typeof options === 'object' ? options : {}) }
        const onEvent = opts.onEvent
        delete opts.onEvent
        if (typeof onEvent !== 'function') return [utterance, opts]
        const requestId = `${prefix}-${++counter}`
        handlers.set(requestId, onEvent)
        listen()
        return [utterance, opts, requestId]
      }
    })
  })
}

/**
 * notifications.create / update: images given as blob: URLs only exist in this context, so
 * they're turned into data: URLs before the options go to the main process.
 */
export function installNotificationImages(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('notifications') || !chrome.notifications) return
  const toDataUrl = async (url: unknown): Promise<unknown> => {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return url
    try {
      const blob = await (await fetch(url)).blob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
    } catch {
      return url
    }
  }
  const convert = async (options: any): Promise<any> => {
    if (!options || typeof options !== 'object') return options
    const out = { ...options }
    for (const key of ['iconUrl', 'imageUrl', 'appIconMaskUrl']) if (out[key] !== undefined) out[key] = await toDataUrl(out[key])
    if (Array.isArray(out.buttons)) out.buttons = await Promise.all(out.buttons.map(async (b: any) => (b && typeof b === 'object' ? { ...b, iconUrl: await toDataUrl(b.iconUrl) } : b)))
    return out
  }
  ext.define(chrome.notifications as any, {
    create: ext.fn('notifications', 'create', {
      before: async (args: any[]) => {
        if (args[0] && typeof args[0] === 'object') return [await convert(args[0])]
        return [args[0], await convert(args[1])]
      }
    }),
    update: ext.fn('notifications', 'update', { before: async (args: any[]) => [args[0], await convert(args[1])] })
  })
}

export const PLATFORM_INSTALLERS: (() => void)[] = [installChromeSettings, installContentSettings, installTtsSpeak, installNotificationImages]
