// Google sign-in for the desktop app.
//
// Google blocks OAuth inside embedded browsers, so sign-in happens in the user's
// normal browser: we start a one-off server on localhost (an authorized Firebase
// domain by default), open auth.html there, and it posts the Google credential
// back to us. The UI then calls signInWithCredential() with it.
import { net, shell } from 'electron'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GoogleCredential } from '@shared/types'
import { devServerUrl, isDev, rendererDir } from './env'

const TIMEOUT_MS = 5 * 60_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

let active: { server: Server; reject: (err: Error) => void } | null = null

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64_000) req.destroy()
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const file = normalize(join(rendererDir, pathname))
  if (!file.startsWith(rendererDir + sep)) {
    res.writeHead(404).end()
    return
  }
  try {
    const response = await net.fetch(pathToFileURL(file).toString())
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}

export function signInWithGoogle(): Promise<GoogleCredential> {
  // Only one sign-in at a time; a new request replaces the old one.
  if (active) {
    active.reject(new Error('Sign-in was restarted'))
    active.server.close()
    active = null
  }

  const state = randomBytes(32).toString('hex')

  return new Promise<GoogleCredential>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const origin = req.headers.origin ?? ''
      // In dev the page comes from the Vite server on another localhost port.
      if (/^http:\/\/localhost:\d+$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }

      if (req.method === 'POST' && url.pathname === '/callback') {
        try {
          const body = JSON.parse(await readBody(req)) as Partial<GoogleCredential> & { state?: string }
          if (typeof body.state !== 'string' || !sameSecret(body.state, state)) {
            res.writeHead(403).end('Invalid state')
            return
          }
          if (typeof body.idToken !== 'string') {
            res.writeHead(400).end('Missing token')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
          finish()
          resolve({ idToken: body.idToken, accessToken: typeof body.accessToken === 'string' ? body.accessToken : null })
        } catch {
          res.writeHead(400).end('Bad request')
        }
        return
      }

      if (req.method === 'GET' && !isDev) {
        await serveStatic(url.pathname === '/' ? '/auth.html' : url.pathname, res)
        return
      }
      res.writeHead(404).end()
    })

    const timeout = setTimeout(() => {
      finish()
      reject(new Error('Sign-in timed out'))
    }, TIMEOUT_MS)

    function finish(): void {
      clearTimeout(timeout)
      server.close()
      if (active?.server === server) active = null
    }

    active = {
      server,
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      }
    }

    server.on('error', (err) => {
      finish()
      reject(err)
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        finish()
        reject(new Error('Could not start sign-in server'))
        return
      }
      const params = new URLSearchParams({ port: String(address.port), state })
      const page = isDev
        ? `${devServerUrl}/auth.html?${params}`
        : `http://localhost:${address.port}/auth.html?${params}`
      void shell.openExternal(page)
    })
  })
}
