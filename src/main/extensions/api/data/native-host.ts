import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { endianness, homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Native messaging hosts, found where Google Chrome and Chromium look for them, and the wire
 * format: each message is UTF-8 JSON after a 32-bit length in the machine's byte order.
 * No Electron here, so it can be tested with plain Node.
 */

/** Largest message a host may send. */
export const MAX_FROM_HOST = 1024 * 1024
/** Largest message sent to a host. */
export const MAX_TO_HOST = 64 * 1024 * 1024

export const NATIVE_ERRORS = {
  invalidName: 'Invalid native messaging host name specified.',
  notFound: 'Specified native messaging host not found.',
  forbidden: 'Access to the specified native messaging host is forbidden.',
  failedToStart: 'Failed to start native messaging host.',
  exited: 'Native host has exited.',
  protocol: 'Error when communicating with the native messaging host.'
} as const

export class NativeHostError extends Error {}

const LITTLE_ENDIAN = endianness() === 'LE'

/** Lowercase letters, digits, underscores and dots; no dot at either end or twice in a row. */
export function isValidHostName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(name)
}

export function encodeMessage(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  if (body.length > MAX_TO_HOST) throw new NativeHostError(NATIVE_ERRORS.protocol)
  const header = Buffer.alloc(4)
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length)
  else header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** Collects a host's stdout and splits it into messages. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0)

  /** The complete messages so far (parsed). Throws on a message that's too long or isn't JSON. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: unknown[] = []
    while (this.buffer.length >= 4) {
      const length = LITTLE_ENDIAN ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0)
      if (length > MAX_FROM_HOST) throw new NativeHostError(NATIVE_ERRORS.protocol)
      if (this.buffer.length < 4 + length) break
      const body = this.buffer.subarray(4, 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(4 + length)
      try {
        out.push(JSON.parse(body))
      } catch {
        throw new NativeHostError(NATIVE_ERRORS.protocol)
      }
    }
    return out
  }
}

/** Where manifests may be on macOS and Linux, in the order they're tried (user folders first, like Chrome). */
export function manifestDirs(platform: NodeJS.Platform = process.platform, home = homedir(), extra: string[] = []): string[] {
  if (platform === 'darwin') {
    return [
      ...extra,
      join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
      '/Library/Google/Chrome/NativeMessagingHosts',
      '/Library/Application Support/Chromium/NativeMessagingHosts'
    ]
  }
  if (platform === 'win32') return extra
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    ...extra,
    join(config, 'google-chrome/NativeMessagingHosts'),
    join(config, 'chromium/NativeMessagingHosts'),
    '/etc/opt/chrome/native-messaging-hosts',
    '/etc/chromium/native-messaging-hosts'
  ]
}

/** Registry keys holding a host's manifest path on Windows, in Chrome's order. */
export function registryKeys(name: string): { key: string; view?: '32' | '64' }[] {
  const keys: { key: string; view?: '32' | '64' }[] = []
  for (const vendor of ['Google\\Chrome', 'Chromium']) {
    keys.push({ key: `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${name}` })
    keys.push({ key: `HKLM\\Software\\${vendor}\\NativeMessagingHosts\\${name}`, view: '32' })
    keys.push({ key: `HKLM\\Software\\${vendor}\\NativeMessagingHosts\\${name}`, view: '64' })
  }
  return keys
}

/** The default value from `reg query <key> /ve` output. (The "(Default)" label is translated, so it's found by type.) */
export function parseRegDefault(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ\s+(.*\S)\s*$/.exec(line)
    if (m) return m[1].replace(/%([^%]+)%/g, (all, v: string) => process.env[v] ?? all)
  }
  return null
}

function regQuery(key: string, view?: '32' | '64'): Promise<string | null> {
  const args = ['query', key, '/ve', ...(view ? [`/reg:${view}`] : [])]
  return new Promise((done) => {
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => done(err ? null : parseRegDefault(stdout)))
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The path of a host's manifest, or null. `extraDirs` are searched first (macOS and Linux). */
export async function findManifest(name: string, extraDirs: string[] = []): Promise<string | null> {
  if (process.platform === 'win32') {
    for (const dir of extraDirs) {
      const candidate = join(dir, `${name}.json`)
      if (await exists(candidate)) return candidate
    }
    for (const { key, view } of registryKeys(name)) {
      const path = await regQuery(key, view)
      if (path && (await exists(path))) return path
    }
    return null
  }
  for (const dir of manifestDirs(process.platform, homedir(), extraDirs)) {
    const candidate = join(dir, `${name}.json`)
    if (await exists(candidate)) return candidate
  }
  return null
}

export interface HostManifest {
  name: string
  path: string
  type: string
  allowed_origins?: unknown
}

/**
 * Checks a host manifest for an extension: the right name, stdio, the extension's origin allowed,
 * and the program's absolute path (relative paths are only allowed on Windows, from the manifest's folder).
 */
export function checkManifest(raw: unknown, name: string, extensionId: string, manifestPath: string, platform = process.platform): string {
  const m = raw as Partial<HostManifest> | null
  if (!m || typeof m !== 'object' || m.name !== name || m.type !== 'stdio' || typeof m.path !== 'string' || !m.path) {
    throw new NativeHostError(NATIVE_ERRORS.notFound)
  }
  const origins = Array.isArray(m.allowed_origins) ? m.allowed_origins : []
  if (!origins.includes(`chrome-extension://${extensionId}/`)) throw new NativeHostError(NATIVE_ERRORS.forbidden)
  if (isAbsolute(m.path)) return m.path
  if (platform !== 'win32') throw new NativeHostError(NATIVE_ERRORS.notFound)
  return resolve(dirname(manifestPath), m.path)
}

/** Finds and checks a host for an extension. Resolves with the program to run. */
export async function resolveHost(name: unknown, extensionId: string, extraDirs: string[] = []): Promise<string> {
  if (!isValidHostName(name)) throw new NativeHostError(NATIVE_ERRORS.invalidName)
  const manifestPath = await findManifest(name, extraDirs)
  if (!manifestPath) throw new NativeHostError(NATIVE_ERRORS.notFound)
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw new NativeHostError(NATIVE_ERRORS.notFound)
  }
  return checkManifest(raw, name, extensionId, manifestPath)
}
