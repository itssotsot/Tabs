import type { NamespaceSpec } from '../namespaces'

/** userScripts, debugger, pageCapture, tabCapture (chrome.scripting's fallback is an installer). */
export const SCRIPTING_SPECS: NamespaceSpec[] = [
  {
    name: 'userScripts',
    permissions: ['userScripts'],
    methods: ['register', 'update', 'unregister', 'getScripts', 'configureWorld', 'getWorldConfigurations', 'resetWorldConfiguration', 'execute'],
    constants: { ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' } }
  },
  {
    // Electron has this event but never fires it. onUserScriptConnect is an installer (it hands out Ports).
    name: 'runtime',
    permissions: ['userScripts'],
    events: [{ name: 'onUserScriptMessage', response: true }]
  },
  {
    name: 'debugger',
    permissions: ['debugger'],
    methods: ['attach', 'detach', 'sendCommand', 'getTargets'],
    events: ['onEvent', 'onDetach'],
    constants: {
      DetachReason: { CANCELED_BY_USER: 'canceled_by_user', TARGET_CLOSED: 'target_closed' },
      TargetInfoType: { PAGE: 'page', BACKGROUND_PAGE: 'background_page', WORKER: 'worker', OTHER: 'other' }
    }
  },
  {
    // saveAsMHTML returns a Blob: see installPageCapture.
    name: 'pageCapture',
    permissions: ['pageCapture']
  },
  {
    name: 'tabCapture',
    permissions: ['tabCapture'],
    methods: ['getMediaStreamId', 'getCapturedTabs'],
    events: ['onStatusChanged'],
    constants: { TabCaptureState: { PENDING: 'pending', ACTIVE: 'active', STOPPED: 'stopped', ERROR: 'error' } }
  }
]
