import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve('src/shared') }

/** The dev server injects inline scripts (React Refresh), so the CSP only applies to builds. */
function stripCspInDev(): Plugin {
  return {
    name: 'strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/g, '')
  }
}

export default defineConfig({
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preloads can't require sibling chunks, so each entry must be standalone.
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          chrome: resolve('src/preload/chrome.ts'),
          tab: resolve('src/preload/tab.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    base: './',
    resolve: { alias: { ...shared, '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), stripCspInDev()],
    server: {
      // Internal pages load through the browserr:// scheme, so pin the HMR socket to the dev server.
      hmr: { host: 'localhost' }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          internal: resolve('src/renderer/internal.html'),
          auth: resolve('src/renderer/auth.html')
        }
      }
    }
  }
})
