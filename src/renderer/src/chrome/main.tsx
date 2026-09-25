import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SocialProvider } from '../social/SocialProvider'
import '../styles/chrome.css'
import { App } from './App'

document.documentElement.dataset.platform = window.browserr.platform

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SocialProvider withShares>
      <App />
    </SocialProvider>
  </StrictMode>
)
