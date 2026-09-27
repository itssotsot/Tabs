/** Chrome's nine tab group colors and the app's site colors. No Electron here. */

export type Color = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'
export const COLORS: Color[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']

/** The site color an extension's choice becomes (from the app's own palette). */
export const HEX_FOR_COLOR: Record<Color, string> = {
  grey: '#64748b',
  blue: '#3b82f6',
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  pink: '#ec4899',
  purple: '#a855f7',
  cyan: '#06b6d4',
  orange: '#f97316'
}

/** The nearest of Chrome's group colors to a CSS hex color, by hue. */
export function chromeColor(hex: string): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m) return 'grey'
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.2 || l < 0.12 || l > 0.92) return 'grey'
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 15 || h >= 345) return 'red'
  if (h < 40) return 'orange'
  if (h < 70) return 'yellow'
  if (h < 165) return 'green'
  if (h < 200) return 'cyan'
  if (h < 250) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
}
