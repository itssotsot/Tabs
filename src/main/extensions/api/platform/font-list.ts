import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

/**
 * The font families installed on this computer, for chrome.fontSettings.getFontList. Reads the
 * family names straight from the fonts' OpenType `name` tables in the system's font folders, so
 * it needs no extra tools and works the same on every platform.
 */

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const MAX_DEPTH = 5
/** Name tables are small; anything bigger is broken. */
const MAX_NAME_TABLE = 1 << 20

async function fontFolders(): Promise<string[]> {
  const home = homedir()
  if (process.platform === 'darwin') {
    // Fonts macOS downloads on demand live in versioned asset folders.
    const assets = '/System/Library/AssetsV2'
    const downloaded = (await readdir(assets).catch(() => [] as string[])).filter((d) => d.startsWith('com_apple_MobileAsset_Font')).map((d) => join(assets, d))
    return [
      '/System/Library/Fonts',
      '/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved',
      '/Library/Fonts',
      join(home, 'Library/Fonts'),
      ...downloaded
    ]
  }
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR ?? 'C:\\Windows'
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(windir, 'Fonts'), join(local, 'Microsoft', 'Windows', 'Fonts')]
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts'), join(home, '.local/share/fonts')]
}

async function collect(dir: string, depth: number, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await collect(path, depth + 1, out)
    } else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(path)
    }
  }
}

function utf16be(buf: Buffer): string {
  const swapped = Buffer.from(buf)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** The family name in one font's name table: the typographic family (16) if present, else the family (1). */
function familyFromNameTable(table: Buffer): string | null {
  if (table.length < 6) return null
  const count = table.readUInt16BE(2)
  const stringOffset = table.readUInt16BE(4)
  let best: { score: number; name: string } | null = null
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (rec + 12 > table.length) break
    const platformId = table.readUInt16BE(rec)
    const encodingId = table.readUInt16BE(rec + 2)
    const languageId = table.readUInt16BE(rec + 4)
    const nameId = table.readUInt16BE(rec + 6)
    const length = table.readUInt16BE(rec + 8)
    const offset = stringOffset + table.readUInt16BE(rec + 10)
    if ((nameId !== 1 && nameId !== 16) || offset + length > table.length || !length) continue
    const raw = table.subarray(offset, offset + length)
    let name: string
    let score: number
    if (platformId === 3 && (encodingId === 1 || encodingId === 10)) {
      name = utf16be(raw)
      score = languageId === 0x409 ? 30 : 20
    } else if (platformId === 0) {
      name = utf16be(raw)
      score = 15
    } else if (platformId === 1 && encodingId === 0) {
      name = raw.toString('latin1')
      score = languageId === 0 ? 10 : 5
    } else continue
    if (nameId === 16) score += 100
    name = name.replace(/\0/g, '').trim()
    if (name && (!best || score > best.score)) best = { score, name }
  }
  return best?.name ?? null
}

async function familiesInFile(path: string): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, position)
      return buf.subarray(0, bytesRead)
    }
    const header = await read(0, 12)
    if (header.length < 12) return []
    const tag = header.toString('latin1', 0, 4)
    let offsets: number[]
    if (tag === 'ttcf') {
      const num = Math.min(header.readUInt32BE(8), 64)
      const table = await read(12, num * 4)
      offsets = Array.from({ length: Math.floor(table.length / 4) }, (_, i) => table.readUInt32BE(i * 4))
    } else if (tag === '\0\x01\0\0' || tag === 'OTTO' || tag === 'true') {
      offsets = [0]
    } else return []
    const names: string[] = []
    for (const offset of offsets) {
      const dir = await read(offset, 12)
      if (dir.length < 12) continue
      const numTables = dir.readUInt16BE(4)
      const records = await read(offset + 12, numTables * 16)
      for (let i = 0; i + 16 <= records.length; i += 16) {
        if (records.toString('latin1', i, i + 4) !== 'name') continue
        const tableOffset = records.readUInt32BE(i + 8)
        const length = Math.min(records.readUInt32BE(i + 12), MAX_NAME_TABLE)
        const name = familyFromNameTable(await read(tableOffset, length))
        if (name) names.push(name)
        break
      }
    }
    return names
  } finally {
    await handle.close()
  }
}

/** Installed font family names, sorted. Hidden system fonts (names starting with a dot) are left out, like in Chrome. */
export async function installedFontFamilies(): Promise<string[]> {
  const files: string[] = []
  for (const dir of await fontFolders()) await collect(dir, 0, files)
  const families = new Set<string>()
  // A few at a time: some folders hold thousands of fonts.
  for (let i = 0; i < files.length; i += 32) {
    const batch = await Promise.all(files.slice(i, i + 32).map((f) => familiesInFile(f).catch(() => [])))
    for (const names of batch) for (const name of names) if (!name.startsWith('.')) families.add(name)
  }
  return [...families].sort((a, b) => a.localeCompare(b))
}
