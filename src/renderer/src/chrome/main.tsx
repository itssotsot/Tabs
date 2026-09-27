import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SocialProvider } from '../social/SocialProvider'
import '../styles/chrome.css'
import { disableMiddleClickAutoscroll } from '../ui/util'
import { App } from './App'

document.documentElement.dataset.platform = window.browserr.platform
disableMiddleClickAutoscroll()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SocialProvider withNotifications>
      <App />
    </SocialProvider>
  </StrictMode>
)
