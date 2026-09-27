import { CORE_INSTALLERS } from './custom/core'
import { DATA_INSTALLERS } from './custom/data'
import { NETWORK_INSTALLERS } from './custom/network'
import { PLATFORM_INSTALLERS } from './custom/platform'
import { SCRIPTING_INSTALLERS } from './custom/scripting'
import type { NamespaceSpec } from './namespaces'
import { CORE_SPECS } from './specs/core'
import { DATA_SPECS } from './specs/data'
import { NETWORK_SPECS } from './specs/network'
import { PLATFORM_SPECS } from './specs/platform'
import { SCRIPTING_SPECS } from './specs/scripting'

export const ALL_SPECS: NamespaceSpec[] = [...CORE_SPECS, ...NETWORK_SPECS, ...SCRIPTING_SPECS, ...PLATFORM_SPECS, ...DATA_SPECS]

/** Run after the specs, in this order. */
export const ALL_INSTALLERS: (() => void)[] = [
  ...CORE_INSTALLERS,
  ...NETWORK_INSTALLERS,
  ...SCRIPTING_INSTALLERS,
  ...PLATFORM_INSTALLERS,
  ...DATA_INSTALLERS
]
