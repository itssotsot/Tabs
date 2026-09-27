import { app, webContents, type Session, type WebContents } from 'electron'
import { addBlockingHandler, removeHandler } from '../../../web-request-hub'
import { lifecycle } from '../../lifecycle'
import { defineSetting, validators, type Setting } from './chrome-setting'
import { setThirdPartyCookiesBlocked } from './content-settings'

/**
 * chrome.privacy.network / services / websites. Each is a ChromeSetting (see chrome-setting.ts).
 * Applied: the WebRTC IP handling policy (on every page of the web session), Do Not Track (a
 * `DNT: 1` header), referrers and hyperlink auditing (through the web request hub), and
 * third-party cookie blocking (with contentSettings' cookie rules). The rest are remembered and
 * reported; see `privacySetting` for other parts of the browser that want to honor them.
 */

type IPHandlingPolicy = 'default' | 'default_public_and_private_interfaces' | 'default_public_interface_only' | 'disable_non_proxied_udp'

let ses: Session | null = null
let webRtcPolicy: IPHandlingPolicy = 'default'
const headerRules = { doNotTrack: false, stripReferrers: false }

function applyWebRtc(wc: WebContents): void {
  try {
    if (!wc.isDestroyed()) wc.setWebRTCIPHandlingPolicy(webRtcPolicy)
  } catch {
    // Not a page that has WebRTC.
  }
}

function updateHeaderHandler(): void {
  if (!ses) return
  if (!headerRules.doNotTrack && !headerRules.stripReferrers) {
    removeHandler(ses, 'onBeforeSendHeaders', 'ext-privacy-headers')
    return
  }
  addBlockingHandler(ses, 'onBeforeSendHeaders', {
    id: 'ext-privacy-headers',
    order: 50,
    handle: (details) => {
      const requestHeaders = { ...details.requestHeaders }
      if (headerRules.doNotTrack) requestHeaders.DNT = '1'
      if (headerRules.stripReferrers) {
        for (const key of Object.keys(requestHeaders)) if (key.toLowerCase() === 'referer') delete requestHeaders[key]
      }
      return { requestHeaders }
    }
  })
}

function setHyperlinkAuditing(enabled: boolean): void {
  if (!ses) return
  if (enabled) removeHandler(ses, 'onBeforeRequest', 'ext-privacy-ping')
  else addBlockingHandler(ses, 'onBeforeRequest', { id: 'ext-privacy-ping', handle: (d) => (d.resourceType === 'ping' ? { cancel: true } : undefined) })
}

const settings = new Map<string, Setting<unknown>>()

function define<T>(path: string, defaultValue: T, validate: (v: unknown) => T, apply?: (value: T) => void): void {
  const setting = defineSetting<T>({ path: `privacy.${path}`, permission: 'privacy', defaultValue, validate, apply })
  settings.set(path, setting as Setting<unknown>)
}

const bool = validators.boolean

// network
define('network.networkPredictionEnabled', true, bool)
define(
  'network.webRTCIPHandlingPolicy',
  'default' as IPHandlingPolicy,
  validators.oneOf<IPHandlingPolicy>('default', 'default_public_and_private_interfaces', 'default_public_interface_only', 'disable_non_proxied_udp'),
  (policy) => {
    webRtcPolicy = policy
    if (!ses) return
    for (const wc of webContents.getAllWebContents()) if (wc.session === ses) applyWebRtc(wc)
  }
)

// services
define('services.alternateErrorPagesEnabled', true, bool)
define('services.autofillEnabled', true, bool)
define('services.autofillAddressEnabled', true, bool)
define('services.autofillCreditCardEnabled', true, bool)
define('services.passwordSavingEnabled', true, bool)
define('services.safeBrowsingEnabled', true, bool)
define('services.safeBrowsingExtendedReportingEnabled', false, bool)
define('services.searchSuggestEnabled', true, bool)
define('services.spellingServiceEnabled', false, bool)
define('services.translationServiceEnabled', true, bool)

// websites
define('websites.thirdPartyCookiesAllowed', true, bool, (allowed) => setThirdPartyCookiesBlocked(!allowed))
define('websites.hyperlinkAuditingEnabled', true, bool, setHyperlinkAuditing)
define('websites.referrersEnabled', true, bool, (enabled) => {
  headerRules.stripReferrers = !enabled
  updateHeaderHandler()
})
define('websites.doNotTrackEnabled', false, bool, (enabled) => {
  headerRules.doNotTrack = enabled
  updateHeaderHandler()
})
define('websites.protectedContentEnabled', true, bool)
// Tabs doesn't run the Privacy Sandbox APIs.
define('websites.topicsEnabled', false, bool)
define('websites.fledgeEnabled', false, bool)
define('websites.adMeasurementEnabled', false, bool)
define('websites.relatedWebsiteSetsEnabled', true, bool)

/**
 * The effective value of a privacy setting (path under chrome.privacy, e.g.
 * `network.networkPredictionEnabled`), for parts of the browser that honor it.
 */
export function privacySetting<T = boolean>(path: string): T | undefined {
  return settings.get(path)?.value() as T | undefined
}

lifecycle.on('ready', (session) => {
  ses = session
  // New pages get the policy an extension set.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session === ses && webRtcPolicy !== 'default') applyWebRtc(wc)
  })
})
