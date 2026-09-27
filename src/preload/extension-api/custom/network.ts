/**
 * Installers for the network APIs that need more than a spec. Each runs in the extension's world
 * (see core.ts): self-contained, using only the helper at `globalThis[Symbol.for('tabs.extensions')]`.
 */

/**
 * chrome.webRequest's events: Chrome's filter and extraInfoSpec checks, details trimmed to what
 * each listener asked for, and listener return values handled. Only onAuthRequired may answer
 * (for webRequestAuthProvider); a blocking response from any other listener is ignored and
 * reported through onActionIgnored.
 */
export function installWebRequestEvents(): void {
  const ext = (globalThis as any)[Symbol.for('tabs.extensions')]
  if (!ext || !ext.declares('webRequest') || !chrome.webRequest) return
  const SPECS: Record<string, string[]> = {
    onBeforeRequest: ['blocking', 'requestBody', 'extraHeaders'],
    onBeforeSendHeaders: ['requestHeaders', 'blocking', 'extraHeaders'],
    onSendHeaders: ['requestHeaders', 'extraHeaders'],
    onHeadersReceived: ['blocking', 'responseHeaders', 'extraHeaders', 'securityInfo', 'securityInfoRawDer'],
    onAuthRequired: ['responseHeaders', 'blocking', 'asyncBlocking', 'extraHeaders'],
    onResponseStarted: ['responseHeaders', 'extraHeaders'],
    onBeforeRedirect: ['responseHeaders', 'extraHeaders'],
    onCompleted: ['responseHeaders', 'extraHeaders'],
    onErrorOccurred: ['extraHeaders']
  }
  const TYPES = [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'webtransport',
    'webbundle',
    'other'
  ]
  const PATTERN = /^(\*|https?|wss?|ftp|file|urn|chrome-extension):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/

  const ignoredListeners = new Set<(details: any) => void>()
  const fireIgnored = (action: string, requestId: string): void => {
    for (const cb of ignoredListeners) {
      try {
        cb({ action, requestId })
      } catch (err) {
        console.error(err)
      }
    }
  }
  const onActionIgnored = {
    addListener(callback: (details: any) => void) {
      if (typeof callback !== 'function') throw new TypeError('webRequest.onActionIgnored.addListener needs a function.')
      ignoredListeners.add(callback)
    },
    removeListener(callback: (details: any) => void) {
      ignoredListeners.delete(callback)
    },
    hasListener(callback: (details: any) => void) {
      return ignoredListeners.has(callback)
    },
    hasListeners() {
      return ignoredListeners.size > 0
    }
  }

  const makeEvent = (name: string): Record<string, unknown> => {
    const inner = ext.event(`webRequest.${name}`, name === 'onAuthRequired' ? { response: true } : {})
    const allowed = SPECS[name]
    const signature = `webRequest.${name}.addListener(function callback, webRequest.RequestFilter filter, optional array extraInfoSpec)`
    const invalid = (message: string): TypeError => new TypeError(`Error in invocation of ${signature}: ${message}`)
    const wrappers = new Map<(...args: any[]) => any, (...args: any[]) => any>()
    return {
      addListener(callback: (...args: any[]) => any, filter?: any, extraInfoSpec?: any) {
        if (typeof callback !== 'function') throw invalid('No matching signature.')
        if (!filter || typeof filter !== 'object') throw invalid("Error at parameter 'filter': Invalid type: expected webRequest.RequestFilter.")
        if (!Array.isArray(filter.urls)) throw invalid("Error at parameter 'filter': Missing required property 'urls'.")
        for (const url of filter.urls) {
          if (typeof url !== 'string' || (url !== '<all_urls>' && !PATTERN.test(url))) throw new Error(`'${String(url)}' is not a valid URL pattern.`)
        }
        if (filter.types !== undefined) {
          if (!Array.isArray(filter.types)) throw invalid("Error at parameter 'filter': Error at property 'types': Invalid type: expected array.")
          filter.types.forEach((t: unknown, i: number) => {
            if (!TYPES.includes(t as string)) {
              throw invalid(`Error at parameter 'filter': Error at property 'types': Error at index ${i}: Value must be one of ${TYPES.join(', ')}.`)
            }
          })
        }
        for (const key of ['tabId', 'windowId']) {
          if (filter[key] !== undefined && !Number.isInteger(filter[key])) {
            throw invalid(`Error at parameter 'filter': Error at property '${key}': Invalid type: expected integer.`)
          }
        }
        const spec: string[] = extraInfoSpec === undefined || extraInfoSpec === null ? [] : extraInfoSpec
        if (!Array.isArray(spec)) throw invalid("Error at parameter 'extraInfoSpec': Invalid type: expected array.")
        spec.forEach((s, i) => {
          if (!allowed.includes(s)) throw invalid(`Error at parameter 'extraInfoSpec': Error at index ${i}: Value must be one of ${allowed.join(', ')}.`)
        })
        if (spec.includes('blocking') && spec.includes('asyncBlocking')) throw new Error('Only one of blocking or asyncBlocking can be specified.')
        if (wrappers.has(callback)) return
        const trim = (details: any): any => {
          const d = { ...details }
          if (!spec.includes('requestHeaders')) delete d.requestHeaders
          if (!spec.includes('responseHeaders')) delete d.responseHeaders
          if (!spec.includes('requestBody')) delete d.requestBody
          return d
        }
        const wrapper = function (this: unknown, details: any, sendResponse?: (response: unknown) => void): unknown {
          const d = trim(details)
          if (name === 'onAuthRequired' && sendResponse) {
            if (spec.includes('asyncBlocking')) {
              callback.call(this, d, (response: unknown) => sendResponse(response ?? {}))
              return true
            }
            const result = callback.call(this, d)
            if (spec.includes('blocking') && result && typeof result === 'object') sendResponse(result)
            return undefined
          }
          const result = callback.call(this, d)
          if (result && typeof result === 'object') {
            if (result.redirectUrl) fireIgnored('redirect', d.requestId)
            if (result.requestHeaders) fireIgnored('request_headers', d.requestId)
            if (result.responseHeaders) fireIgnored('response_headers', d.requestId)
            if (result.authCredentials) fireIgnored('auth_credentials', d.requestId)
          }
          return undefined
        }
        wrappers.set(callback, wrapper)
        const clean: Record<string, unknown> = { urls: [...filter.urls] }
        if (filter.types) clean.types = [...filter.types]
        if (filter.tabId !== undefined) clean.tabId = filter.tabId
        if (filter.windowId !== undefined) clean.windowId = filter.windowId
        inner.addListener(wrapper, clean, [...spec])
        // So the main process starts sending this event right away.
        ext.call('webRequest', 'listenersChanged', []).catch(() => {})
      },
      removeListener(callback: (...args: any[]) => any) {
        const wrapper = wrappers.get(callback)
        if (!wrapper) return
        wrappers.delete(callback)
        inner.removeListener(wrapper)
      },
      hasListener(callback: (...args: any[]) => any) {
        return wrappers.has(callback)
      },
      hasListeners() {
        return wrappers.size > 0
      }
    }
  }

  const props: Record<string, unknown> = { onActionIgnored }
  for (const name of Object.keys(SPECS)) props[name] = makeEvent(name)
  ext.define(chrome.webRequest as any, props)
}

export const NETWORK_INSTALLERS: (() => void)[] = [installWebRequestEvents]
