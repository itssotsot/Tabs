import { CloudOff, ShieldAlert, ShieldX, Unplug, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { hostOf } from '@shared/url'

interface Explanation {
  icon: typeof CloudOff
  title: string
  detail: string
}

function explain(code: string, host: string): Explanation {
  const n = Number(code)
  if (code === 'crashed') {
    return { icon: Unplug, title: 'This page crashed', detail: 'Something went wrong while displaying this page. Try reloading it.' }
  }
  if (n === -106) return { icon: WifiOff, title: 'No internet', detail: 'Check your network connection and try again.' }
  if (n === -105) return { icon: CloudOff, title: 'This site can’t be reached', detail: `${host}’s server IP address could not be found.` }
  if (n === -102) return { icon: CloudOff, title: 'This site can’t be reached', detail: `${host} refused to connect.` }
  if (n === -118 || n === -7) return { icon: CloudOff, title: 'This site can’t be reached', detail: `${host} took too long to respond.` }
  if (n === -20) return { icon: ShieldX, title: 'Blocked', detail: `The ad and tracker blocker stopped ${host} from loading. You can turn blocking off in Settings.` }
  if (n <= -200 && n > -300) {
    return { icon: ShieldAlert, title: 'Your connection is not private', detail: `The certificate for ${host} isn't valid, so Tabs stopped the connection to protect you.` }
  }
  return { icon: CloudOff, title: 'This page isn’t working', detail: `${host} couldn't be loaded.` }
}

export function ErrorPage(): ReactNode {
  const params = new URLSearchParams(location.search)
  const url = params.get('url') ?? ''
  const code = params.get('code') ?? ''
  const description = params.get('description') ?? ''
  const host = hostOf(url)
  const { icon: Icon, title, detail } = explain(code, host)
  document.title = host || title

  return (
    <main className="error-page">
      <Icon size={44} strokeWidth={1.5} />
      <h1>{title}</h1>
      <p>{detail}</p>
      {description && code !== 'crashed' && <code>{description}</code>}
      {/^https?:/.test(url) && (
        <button className="primary-btn" autoFocus onClick={() => location.replace(url)}>
          Try again
        </button>
      )}
    </main>
  )
}
