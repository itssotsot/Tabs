import type { ProxyConfig, Session } from 'electron'
import { addObserver, removeHandler } from '../../../web-request-hub'
import { lifecycle } from '../../lifecycle'
import { defineEvent, emit, ExtensionError } from '../../router'
import { defineSetting } from './chrome-setting'
import { isObject } from './util'

/**
 * chrome.proxy: `proxy.settings` is a ChromeSetting whose value (a ProxyConfig) is applied to the
 * web session. Without an extension in control, the system's proxy settings apply. Failed
 * requests that look like proxy failures are reported through onProxyError.
 */

interface ProxyServer {
  scheme?: string
  host: string
  port?: number
}

interface ChromeProxyConfig {
  mode: 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system'
  pacScript?: { url?: string; data?: string; mandatory?: boolean }
  rules?: {
    singleProxy?: ProxyServer
    proxyForHttp?: ProxyServer
    proxyForHttps?: ProxyServer
    proxyForFtp?: ProxyServer
    fallbackProxy?: ProxyServer
    bypassList?: string[]
  }
}

const MODES = new Set(['direct', 'auto_detect', 'pac_script', 'fixed_servers', 'system'])
const SCHEMES = new Set(['http', 'https', 'quic', 'socks4', 'socks5'])
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080 }
const RULE_KEYS = ['singleProxy', 'proxyForHttp', 'proxyForHttps', 'proxyForFtp', 'fallbackProxy'] as const

let ses: Session | null = null

function readServer(value: unknown, name: string): ProxyServer {
  if (!isObject(value) || typeof value.host !== 'string' || !value.host) throw new ExtensionError(`Invalid proxy server in '${name}'.`)
  const scheme = value.scheme === undefined ? 'http' : value.scheme
  if (typeof scheme !== 'string' || !SCHEMES.has(scheme)) throw new ExtensionError(`Invalid proxy scheme in '${name}': ${String(value.scheme)}.`)
  const out: ProxyServer = { scheme, host: value.host }
  if (value.port !== undefined) {
    if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535) {
      throw new ExtensionError(`Invalid proxy port in '${name}'.`)
    }
    out.port = value.port
  }
  return out
}

function validate(value: unknown): ChromeProxyConfig {
  if (!isObject(value) || typeof value.mode !== 'string' || !MODES.has(value.mode)) throw new ExtensionError("Invalid proxy mode: expected one of direct, auto_detect, pac_script, fixed_servers, system.")
  const config: ChromeProxyConfig = { mode: value.mode as ChromeProxyConfig['mode'] }
  if (config.mode === 'pac_script') {
    const pac = value.pacScript
    if (!isObject(pac) || (typeof pac.url !== 'string' && typeof pac.data !== 'string')) {
      throw new ExtensionError("Proxy mode 'pac_script' needs a pacScript with 'url' or 'data'.")
    }
    config.pacScript = {}
    if (typeof pac.url === 'string') config.pacScript.url = pac.url
    if (typeof pac.data === 'string') config.pacScript.data = pac.data
    if (typeof pac.mandatory === 'boolean') config.pacScript.mandatory = pac.mandatory
  }
  if (config.mode === 'fixed_servers') {
    const rules = value.rules
    if (!isObject(rules)) throw new ExtensionError("Proxy mode 'fixed_servers' needs 'rules'.")
    config.rules = {}
    for (const key of RULE_KEYS) if (rules[key] !== undefined) config.rules[key] = readServer(rules[key], key)
    if (rules.singleProxy !== undefined && RULE_KEYS.some((k) => k !== 'singleProxy' && rules[k] !== undefined)) {
      throw new ExtensionError("'singleProxy' can't be combined with per-scheme proxies.")
    }
    if (!RULE_KEYS.some((k) => config.rules![k])) throw new ExtensionError("Proxy rules need at least one proxy server.")
    if (rules.bypassList !== undefined) {
      if (!Array.isArray(rules.bypassList) || rules.bypassList.some((b) => typeof b !== 'string')) throw new ExtensionError("Invalid 'bypassList'.")
      config.rules.bypassList = rules.bypassList as string[]
    }
  }
  return config
}

function serverString(s: ProxyServer): string {
  const scheme = s.scheme ?? 'http'
  const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host
  return `${scheme}://${host}:${s.port ?? DEFAULT_PORTS[scheme] ?? 80}`
}

/** A PAC script given inline, as a data: URL Chromium's PAC fetcher accepts. */
function pacDataUrl(data: string): string {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(data, 'utf8').toString('base64')}`
}

/** Chrome's ProxyConfig as Electron's. */
export function toElectronProxy(config: ChromeProxyConfig): ProxyConfig {
  switch (config.mode) {
    case 'direct':
    case 'auto_detect':
    case 'system':
      return { mode: config.mode }
    case 'pac_script': {
      const pac = config.pacScript ?? {}
      return { mode: 'pac_script', pacScript: pac.data !== undefined ? pacDataUrl(pac.data) : pac.url }
    }
    case 'fixed_servers': {
      const r = config.rules ?? {}
      let proxyRules: string
      if (r.singleProxy) proxyRules = serverString(r.singleProxy)
      else {
        const parts: string[] = []
        if (r.proxyForHttp) parts.push(`http=${serverString(r.proxyForHttp)}`)
        if (r.proxyForHttps) parts.push(`https=${serverString(r.proxyForHttps)}`)
        if (r.proxyForFtp) parts.push(`ftp=${serverString(r.proxyForFtp)}`)
        if (r.fallbackProxy) parts.push(`socks=${serverString(r.fallbackProxy)}`)
        proxyRules = parts.join(';')
      }
      const out: ProxyConfig = { mode: 'fixed_servers', proxyRules }
      if (r.bypassList?.length) out.proxyBypassRules = r.bypassList.join(',')
      return out
    }
  }
}

const PROXY_ERROR_RE = /PROXY|TUNNEL_CONNECTION|SOCKS|PAC_/

function watchErrors(on: boolean): void {
  if (!ses) return
  if (!on) {
    removeHandler(ses, 'onErrorOccurred', 'ext-proxy-errors')
    return
  }
  addObserver(ses, 'onErrorOccurred', {
    id: 'ext-proxy-errors',
    handle: (details) => {
      if (!PROXY_ERROR_RE.test(details.error)) return
      const error = details.error.startsWith('net::') ? details.error : `net::${details.error}`
      emit('proxy.onProxyError', [{ fatal: true, error, details: details.url ? `Request to ${details.url} failed.` : '' }])
    }
  })
}

defineSetting<ChromeProxyConfig>({
  path: 'proxy.settings',
  permission: 'proxy',
  defaultValue: { mode: 'system' },
  validate,
  apply: (config, controller) => {
    watchErrors(!!controller)
    ses?.setProxy(toElectronProxy(config)).catch((err) => console.error('[extensions] proxy settings failed', err))
  }
})

defineEvent('proxy.onProxyError', { permissions: ['proxy'] })

lifecycle.on('ready', (session) => {
  ses = session
})
