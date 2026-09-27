import { ipcRenderer } from 'electron'
import { IPC } from '@shared/api'
import { pageKey } from '@shared/url'

/** Asks the browser to open `url` in a new tab, which it does if this tab shows a chat's link. */
function openedInNewTab(url: string): boolean {
  if (!/^https?:/i.test(url) || pageKey(url) === pageKey(location.href)) return false
  return ipcRenderer.sendSync(IPC.pageLeaveSharedLink, url) === true
}

/** A link or form that already opens somewhere else (a new tab, a frame). */
function opensElsewhere(target: string): boolean {
  return !!target && !['_self', '_top', '_parent'].includes(target.toLowerCase())
}

/**
 * A tab showing a link from a chat stays on it: following a link or a search form to another page opens that
 * page in a new tab. These run before the page's own handlers, so single-page sites (YouTube) can't go there in place.
 */
export function installSharedLinkGuard(): void {
  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = e.composedPath().find((el): el is HTMLAnchorElement | HTMLAreaElement => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement)
      if (!link?.href || link.hasAttribute('download') || opensElsewhere(link.target)) return
      if (openedInNewTab(link.href)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )

  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target
      if (!e.isTrusted || !(form instanceof HTMLFormElement)) return
      const submitter = e.submitter as HTMLButtonElement | HTMLInputElement | null
      const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
      const target = submitter?.getAttribute('formtarget') ?? form.target
      // Only searches and the like: a POST (signing in, a cookie banner) can't be moved to another tab.
      if (method !== 'get' || opensElsewhere(target)) return
      let url: URL
      try {
        url = new URL(submitter?.hasAttribute('formaction') ? submitter.formAction : form.action)
      } catch {
        return
      }
      url.search = new URLSearchParams(
        [...new FormData(form, submitter)].flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : []))
      ).toString()
      if (openedInNewTab(url.href)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    true
  )
}
