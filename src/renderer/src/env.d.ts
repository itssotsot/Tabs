/// <reference types="vite/client" />
import type { BrowserrAPI, InternalAPI } from '@shared/api'

declare global {
  interface Window {
    browserr: BrowserrAPI
    browserrInternal: InternalAPI
  }
}
