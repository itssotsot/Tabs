import { lifecycle } from '../../lifecycle'
import { defineApi, defineEvent, emit, ExtensionError, type CallContext } from '../../router'
import { defineSetting, storedSettingPaths, type Setting } from './chrome-setting'
import { installedFontFamilies } from './font-list'
import { asObject } from './util'

/**
 * chrome.fontSettings. Each font and size is a ChromeSetting underneath (so the most recently
 * installed extension wins and levelOfControl is right), with fontSettings' own methods and
 * events on top. Values are remembered and reported; pages keep their normal fonts.
 */

const FAMILIES = ['standard', 'sansserif', 'serif', 'fixed', 'cursive', 'fantasy', 'math'] as const
type Family = (typeof FAMILIES)[number]
const DEFAULT_SCRIPT = 'Zyyy'

/** Chrome's default fonts for the common script, per platform. */
const DEFAULT_FONTS: Record<Family, string> =
  process.platform === 'darwin'
    ? { standard: 'Times', serif: 'Times', sansserif: 'Helvetica', fixed: 'Courier', cursive: 'Apple Chancery', fantasy: 'Papyrus', math: 'STIX Two Math' }
    : process.platform === 'win32'
      ? { standard: 'Times New Roman', serif: 'Times New Roman', sansserif: 'Arial', fixed: 'Consolas', cursive: 'Comic Sans MS', fantasy: 'Impact', math: 'Cambria Math' }
      : { standard: 'Times New Roman', serif: 'Times New Roman', sansserif: 'Arial', fixed: 'Monospace', cursive: 'Comic Sans MS', fantasy: 'Impact', math: 'Latin Modern Math' }

const fontSettings = new Map<string, Setting<string>>()

const fontPath = (script: string, family: Family): string => `fontSettings.font.${script}.${family}`

function readFamily(value: unknown): Family {
  if (typeof value !== 'string' || !(FAMILIES as readonly string[]).includes(value)) throw new ExtensionError(`Invalid genericFamily: ${String(value)}.`)
  return value as Family
}

function readScript(value: unknown): string {
  if (value === undefined) return DEFAULT_SCRIPT
  if (typeof value !== 'string' || !/^[A-Z][a-z]{3}$/.test(value)) throw new ExtensionError(`Invalid script: ${String(value)}.`)
  return value
}

function fontSetting(script: string, family: Family): Setting<string> {
  const path = fontPath(script, family)
  let setting = fontSettings.get(path)
  if (!setting) {
    setting = defineSetting<string>({
      path,
      permission: 'fontSettings',
      // Only the common script has defaults; other scripts fall back to it.
      defaultValue: script === DEFAULT_SCRIPT ? DEFAULT_FONTS[family] : '',
      validate: (value) => {
        if (typeof value !== 'string') throw new ExtensionError("Invalid 'fontId'.")
        return value
      },
      notify: (s) =>
        emit('fontSettings.onFontChanged', (id) => {
          const details: Record<string, unknown> = { fontId: s.value(), genericFamily: family, levelOfControl: s.levelOfControl(id) }
          if (script !== DEFAULT_SCRIPT) details.script = script
          return [details]
        })
    })
    fontSettings.set(path, setting)
  }
  return setting
}

function sizeSetting(name: string, event: string, defaultValue: number, min: number): Setting<number> {
  return defineSetting<number>({
    path: `fontSettings.${name}`,
    permission: 'fontSettings',
    defaultValue,
    validate: (value) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 72) throw new ExtensionError(`Invalid 'pixelSize': expected a whole number from ${min} to 72.`)
      return value
    },
    notify: (s) => emit(`fontSettings.${event}`, (id) => [{ pixelSize: s.value(), levelOfControl: s.levelOfControl(id) }])
  })
}

const sizes = {
  defaultFontSize: sizeSetting('defaultFontSize', 'onDefaultFontSizeChanged', 16, 6),
  defaultFixedFontSize: sizeSetting('defaultFixedFontSize', 'onDefaultFixedFontSizeChanged', 13, 6),
  minimumFontSize: sizeSetting('minimumFontSize', 'onMinimumFontSizeChanged', 0, 0)
}

// Fonts set in an earlier session need their settings back before extensions load.
lifecycle.on('ready', () => {
  for (const path of storedSettingPaths()) {
    const m = /^fontSettings\.font\.([A-Z][a-z]{3})\.(\w+)$/.exec(path)
    if (m && (FAMILIES as readonly string[]).includes(m[2])) fontSetting(m[1], m[2] as Family)
  }
})

let fontList: Promise<{ fontId: string; displayName: string }[]> | null = null

function getFontList(): Promise<{ fontId: string; displayName: string }[]> {
  fontList ??= installedFontFamilies()
    .then((names) => (names.length ? names : [...new Set(Object.values(DEFAULT_FONTS))].sort()))
    .then((names) => names.map((name) => ({ fontId: name, displayName: name })))
    .catch(() => {
      fontList = null
      return [...new Set(Object.values(DEFAULT_FONTS))].sort().map((name) => ({ fontId: name, displayName: name }))
    })
  return fontList
}

function sizeMethods(setting: Setting<number>): [(call: CallContext) => unknown, (call: CallContext, d: unknown) => void, (call: CallContext) => void] {
  return [
    (call) => ({ pixelSize: setting.value(), levelOfControl: setting.levelOfControl(call.extensionId) }),
    (call, d) => {
      const details = asObject(d)
      if (!('pixelSize' in details)) throw new ExtensionError("Missing required property 'pixelSize'.")
      setting.set(call.extensionId, details.pixelSize)
    },
    (call) => setting.clear(call.extensionId)
  ]
}

const [getDefaultFontSize, setDefaultFontSize, clearDefaultFontSize] = sizeMethods(sizes.defaultFontSize)
const [getDefaultFixedFontSize, setDefaultFixedFontSize, clearDefaultFixedFontSize] = sizeMethods(sizes.defaultFixedFontSize)
const [getMinimumFontSize, setMinimumFontSize, clearMinimumFontSize] = sizeMethods(sizes.minimumFontSize)

defineApi('fontSettings', {
  permissions: ['fontSettings'],
  methods: {
    getFont: (call, d) => {
      const details = asObject(d)
      const setting = fontSetting(readScript(details.script), readFamily(details.genericFamily))
      return { fontId: setting.value(), levelOfControl: setting.levelOfControl(call.extensionId) }
    },
    setFont: (call, d) => {
      const details = asObject(d)
      fontSetting(readScript(details.script), readFamily(details.genericFamily)).set(call.extensionId, details.fontId)
    },
    clearFont: (call, d) => {
      const details = asObject(d)
      fontSetting(readScript(details.script), readFamily(details.genericFamily)).clear(call.extensionId)
    },
    getFontList,
    getDefaultFontSize,
    setDefaultFontSize,
    clearDefaultFontSize,
    getDefaultFixedFontSize,
    setDefaultFixedFontSize,
    clearDefaultFixedFontSize,
    getMinimumFontSize,
    setMinimumFontSize,
    clearMinimumFontSize
  }
})

for (const name of ['onFontChanged', 'onDefaultFontSizeChanged', 'onDefaultFixedFontSizeChanged', 'onMinimumFontSizeChanged']) {
  defineEvent(`fontSettings.${name}`, { permissions: ['fontSettings'] })
}
