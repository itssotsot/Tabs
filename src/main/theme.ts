import { nativeTheme } from 'electron'
import { themeInfo, type WindowColors } from '@shared/constants'
import { store } from './store'

/** What's behind the browser UI in the current theme, light or dark with the system. */
export function chromeColors(): WindowColors {
  const { window } = themeInfo(store.settings.theme)
  return nativeTheme.shouldUseDarkColors ? window.dark : window.light
}
