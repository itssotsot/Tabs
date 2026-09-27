import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { OverlayState } from '@shared/types'
import { SocialProvider } from '../social/SocialProvider'
import '../styles/chrome.css'
import { disableMiddleClickAutoscroll } from '../ui/util'
import { GroupPeek } from './GroupPeek'
import { SendPicker } from './SendPicker'
import { Suggestions } from './Suggestions'

document.documentElement.dataset.platform = window.browserr.platform
disableMiddleClickAutoscroll()

function Overlay(): ReactNode {
  const [state, setState] = useState<OverlayState>({ mode: 'hidden' })
  // A fresh key per opening resets the picker (query, note, "sent" ticks).
  const [openCount, setOpenCount] = useState(0)
  const mode = useRef<OverlayState['mode']>('hidden')

  useEffect(
    () =>
      window.browserr.overlay.onState((next) => {
        // An open picker being moved (the window resized) isn't a new opening.
        if (next.mode === 'send' && mode.current !== 'send') setOpenCount((n) => n + 1)
        mode.current = next.mode
        setState(next)
      }),
    []
  )

  if (state.mode === 'suggestions') return <Suggestions items={state.items} selected={state.selected} />
  if (state.mode === 'send') return <SendPicker key={openCount} draft={state.draft} more={state.more} anchor={state.anchor} windowWidth={state.windowWidth} />
  if (state.mode === 'group') return <GroupPeek state={state} />
  return null
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SocialProvider>
      <Overlay />
    </SocialProvider>
  </StrictMode>
)
