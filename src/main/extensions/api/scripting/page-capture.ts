import { defineApi, ExtensionError, type CallContext } from '../../router'
import { send } from './cdp'
import { isObject, mayUsePageApi, tabPage } from './targets'

/**
 * chrome.pageCapture: saves a tab as MHTML through the DevTools protocol (Page.captureSnapshot,
 * which covers out-of-process frames too). The data goes back as text; the extension-side
 * wrapper (custom/scripting.ts) turns it into the Blob the API promises.
 */

async function saveAsMHTML(call: CallContext, details: unknown): Promise<string> {
  if (!isObject(details)) throw new ExtensionError('Invalid details.')
  const { wc, tabId } = tabPage(details.tabId)
  if (!mayUsePageApi(call.extensionId, wc.getURL(), tabId)) throw new ExtensionError("Don't have permissions required to capture this page.")
  try {
    const { data } = await send<{ data: string }>(wc, 'Page.captureSnapshot', { format: 'mhtml' })
    return data
  } catch (err) {
    throw new ExtensionError(`Failed to save the page: ${err instanceof Error ? err.message : String(err)}`)
  }
}

defineApi('pageCapture', {
  permissions: ['pageCapture'],
  methods: { saveAsMHTML }
})
