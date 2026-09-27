import { screen, type Display } from 'electron'
import { createHash } from 'node:crypto'
import { readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, listeningExtensions } from '../../router'

/**
 * chrome.system.cpu, system.memory, system.storage and system.display from Node's `os`, the file
 * system and Electron's `screen`. The display layout and calibration methods are ChromeOS-only
 * in Chrome and fail the same way here.
 */

// ---- cpu ----

function archName(): string {
  switch (os.arch()) {
    case 'x64':
      return 'x86_64'
    case 'ia32':
      return 'x86'
    case 'arm64':
      return 'arm64'
    case 'arm':
      return 'arm'
    default:
      return os.arch()
  }
}

function cpuInfo(): Record<string, unknown> {
  const cpus = os.cpus()
  return {
    numOfProcessors: cpus.length,
    archName: archName(),
    modelName: cpus[0]?.model?.trim() ?? '',
    features: [],
    processors: cpus.map(({ times }) => {
      const user = times.user + times.nice
      const kernel = times.sys + times.irq
      return { usage: { user, kernel, idle: times.idle, total: user + kernel + times.idle } }
    }),
    temperatures: []
  }
}

// ---- memory ----

function memoryInfo(): { capacity: number; availableCapacity: number } {
  return { capacity: os.totalmem(), availableCapacity: os.freemem() }
}

// ---- storage ----

interface Volume {
  id: string
  name: string
  type: 'fixed' | 'removable' | 'unknown'
  mount: string
}

const volumeId = (mount: string): string => createHash('sha256').update(mount).digest('hex').slice(0, 32)

/** Mounted volumes: the system disk plus whatever's mounted where the OS puts disks. */
async function volumes(): Promise<Volume[]> {
  const out: Volume[] = []
  const add = (mount: string, name: string, type: Volume['type']): void => {
    if (!out.some((v) => v.mount === mount)) out.push({ id: volumeId(mount), name, type, mount })
  }
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const mount = `${letter}:\\`
      if (await statfs(mount).then(() => true, () => false)) add(mount, `${letter}:`, letter === 'C' ? 'fixed' : 'unknown')
    }
    return out
  }
  add('/', process.platform === 'darwin' ? 'Macintosh HD' : '/', 'fixed')
  const roots = process.platform === 'darwin' ? ['/Volumes'] : ['/media', `/media/${os.userInfo().username}`, '/mnt', `/run/media/${os.userInfo().username}`]
  for (const root of roots) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const mount = join(root, name)
      // On macOS the system disk also shows up under /Volumes.
      if (process.platform === 'darwin' && name === 'Macintosh HD') continue
      const stats = await statfs(mount).catch(() => null)
      if (stats && stats.blocks > 0) add(mount, name, 'removable')
    }
  }
  return out
}

async function storageInfo(): Promise<Record<string, unknown>[]> {
  const list = await volumes()
  const infos = await Promise.all(
    list.map(async (v) => {
      const stats = await statfs(v.mount).catch(() => null)
      return stats ? { id: v.id, name: v.name, type: v.type, capacity: stats.blocks * stats.bsize } : null
    })
  )
  return infos.filter((i): i is NonNullable<typeof i> => !!i)
}

async function availableCapacity(id: unknown): Promise<{ id: string; availableCapacity: number }> {
  const volume = (await volumes()).find((v) => v.id === id)
  if (!volume) throw new ExtensionError('No storage unit with that id.')
  const stats = await statfs(volume.mount)
  return { id: volume.id, availableCapacity: stats.bavail * stats.bsize }
}

/** Polls for disks coming and going, only while an extension listens. */
let knownVolumes: Map<string, Record<string, unknown>> | null = null

async function pollVolumes(): Promise<void> {
  const listening = listeningExtensions('system.storage.onAttached').length + listeningExtensions('system.storage.onDetached').length > 0
  if (!listening) {
    knownVolumes = null
    return
  }
  const current = new Map((await storageInfo()).map((i) => [i.id as string, i]))
  if (knownVolumes) {
    for (const [id, info] of current) if (!knownVolumes.has(id)) emit('system.storage.onAttached', [info])
    for (const id of knownVolumes.keys()) if (!current.has(id)) emit('system.storage.onDetached', [id])
  }
  knownVolumes = current
}

// ---- display ----

function displayInfo(d: Display, primaryId: number): Record<string, unknown> {
  const dpi = 96 * d.scaleFactor
  return {
    id: String(d.id),
    name: d.label || `Display ${d.id}`,
    mirroringSourceId: '',
    mirroringDestinationIds: [],
    isPrimary: d.id === primaryId,
    isInternal: d.internal,
    isEnabled: true,
    isUnified: false,
    dpiX: dpi,
    dpiY: dpi,
    rotation: d.rotation,
    bounds: { left: d.bounds.x, top: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    overscan: { left: 0, top: 0, right: 0, bottom: 0 },
    workArea: { left: d.workArea.x, top: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
    modes: [
      {
        width: d.bounds.width,
        height: d.bounds.height,
        widthInNativePixels: d.size.width * d.scaleFactor,
        heightInNativePixels: d.size.height * d.scaleFactor,
        deviceScaleFactor: d.scaleFactor,
        refreshRate: d.displayFrequency,
        isNative: true,
        isSelected: true
      }
    ],
    hasTouchSupport: d.touchSupport === 'available',
    hasAccelerometerSupport: d.accelerometerSupport === 'available',
    availableDisplayZoomFactors: [],
    displayZoomFactor: 1,
    activeState: 'active'
  }
}

function displays(): Record<string, unknown>[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => displayInfo(d, primaryId))
}

const chromeOsOnly = (): never => {
  throw new ExtensionError('Function available only on ChromeOS.')
}

defineApi('system.cpu', { permissions: ['system.cpu'], methods: { getInfo: cpuInfo } })
defineApi('system.memory', { permissions: ['system.memory'], methods: { getInfo: memoryInfo } })
defineApi('system.storage', {
  permissions: ['system.storage'],
  methods: {
    getInfo: storageInfo,
    getAvailableCapacity: (_call, id) => availableCapacity(id),
    // Tabs doesn't eject disks.
    ejectDevice: async (_call, id) => ((await volumes()).some((v) => v.id === id) ? 'failure' : 'no_such_device')
  }
})
defineApi('system.display', {
  permissions: ['system.display'],
  methods: {
    getInfo: () => displays(),
    getDisplayLayout: () => [],
    setDisplayProperties: chromeOsOnly,
    setDisplayLayout: chromeOsOnly,
    enableUnifiedDesktop: chromeOsOnly,
    overscanCalibrationStart: chromeOsOnly,
    overscanCalibrationAdjust: chromeOsOnly,
    overscanCalibrationReset: chromeOsOnly,
    overscanCalibrationComplete: chromeOsOnly,
    showNativeTouchCalibration: chromeOsOnly,
    startCustomTouchCalibration: chromeOsOnly,
    completeCustomTouchCalibration: chromeOsOnly,
    clearTouchCalibration: chromeOsOnly,
    setMirrorMode: chromeOsOnly
  }
})

defineEvent('system.storage.onAttached', { permissions: ['system.storage'] })
defineEvent('system.storage.onDetached', { permissions: ['system.storage'] })
defineEvent('system.display.onDisplayChanged', { permissions: ['system.display'] })

lifecycle.on('ready', () => {
  const changed = (): void => {
    if (listeningExtensions('system.display.onDisplayChanged').length) emit('system.display.onDisplayChanged', [])
  }
  screen.on('display-added', changed)
  screen.on('display-removed', changed)
  screen.on('display-metrics-changed', changed)
  setInterval(() => void pollVolumes().catch(() => {}), 5000).unref()
})
