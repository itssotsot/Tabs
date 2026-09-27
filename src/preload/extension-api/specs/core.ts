import type { NamespaceSpec } from '../namespaces'

/** tabs, windows, runtime additions, action, contextMenus, commands, sidePanel. */
export const CORE_SPECS: NamespaceSpec[] = [
  {
    name: 'tabs',
    methods: [
      'get',
      'getCurrent',
      'query',
      'create',
      'update',
      'remove',
      'reload',
      'duplicate',
      'move',
      'highlight',
      'discard',
      'captureVisibleTab',
      'detectLanguage',
      'goBack',
      'goForward',
      'getZoom',
      'setZoom',
      'getZoomSettings',
      'setZoomSettings',
      'group',
      'ungroup'
    ],
    events: [
      'onCreated',
      'onUpdated',
      'onMoved',
      'onActivated',
      'onHighlighted',
      'onDetached',
      'onAttached',
      'onRemoved',
      'onReplaced',
      'onZoomChange',
      'onActiveChanged',
      'onHighlightChanged',
      'onSelectionChanged'
    ],
    constants: {
      TAB_ID_NONE: -1,
      TAB_INDEX_NONE: -1,
      MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
      TabStatus: { UNLOADED: 'unloaded', LOADING: 'loading', COMPLETE: 'complete' },
      WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
      MutedInfoReason: { USER: 'user', CAPTURE: 'capture', EXTENSION: 'extension' },
      ZoomSettingsMode: { AUTOMATIC: 'automatic', MANUAL: 'manual', DISABLED: 'disabled' },
      ZoomSettingsScope: { PER_ORIGIN: 'per-origin', PER_TAB: 'per-tab' }
    }
  },
  {
    name: 'windows',
    methods: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'],
    events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
    constants: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
      WindowState: { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized', FULLSCREEN: 'fullscreen', LOCKED_FULLSCREEN: 'locked-fullscreen' },
      CreateType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel' }
    }
  },
  {
    // Electron has these but they don't work: onInstalled/onStartup never fire, openOptionsPage does nothing.
    name: 'runtime',
    methods: ['openOptionsPage', 'setUninstallURL', 'getContexts', 'reload', 'requestUpdateCheck'],
    events: ['onInstalled', 'onStartup'],
    constants: {
      ContextType: {
        TAB: 'TAB',
        POPUP: 'POPUP',
        BACKGROUND: 'BACKGROUND',
        OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
        SIDE_PANEL: 'SIDE_PANEL',
        DEVELOPER_TOOLS: 'DEVELOPER_TOOLS'
      },
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' }
    }
  },
  {
    // Electron's chrome.extension only has inIncognitoContext.
    name: 'extension',
    methods: ['isAllowedFileSchemeAccess', 'isAllowedIncognitoAccess', 'setUpdateUrlData'],
    constants: { ViewType: { TAB: 'tab', POPUP: 'popup' } }
  },
  {
    // Electron's action API accepts calls but shows nothing and remembers nothing.
    name: 'action',
    manifestKey: 'action',
    replace: true,
    methods: [
      'setIcon',
      'setTitle',
      'getTitle',
      'setPopup',
      'getPopup',
      'setBadgeText',
      'getBadgeText',
      'setBadgeBackgroundColor',
      'getBadgeBackgroundColor',
      'setBadgeTextColor',
      'getBadgeTextColor',
      'enable',
      'disable',
      'isEnabled',
      'getUserSettings',
      'openPopup'
    ],
    events: ['onClicked', 'onUserSettingsChanged']
  },
  {
    name: 'contextMenus',
    permissions: ['contextMenus'],
    methods: ['create', 'update', 'remove', 'removeAll'],
    events: ['onClicked'],
    constants: {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      ContextType: {
        ALL: 'all',
        PAGE: 'page',
        FRAME: 'frame',
        SELECTION: 'selection',
        LINK: 'link',
        EDITABLE: 'editable',
        IMAGE: 'image',
        VIDEO: 'video',
        AUDIO: 'audio',
        LAUNCHER: 'launcher',
        BROWSER_ACTION: 'browser_action',
        PAGE_ACTION: 'page_action',
        ACTION: 'action'
      },
      ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' }
    }
  },
  {
    name: 'commands',
    methods: ['getAll'],
    events: ['onCommand']
  },
  {
    name: 'sidePanel',
    permissions: ['sidePanel'],
    replace: true,
    methods: ['setOptions', 'getOptions', 'setPanelBehavior', 'getPanelBehavior', 'open', 'close', 'getLayout'],
    events: ['onOpened', 'onClosed'],
    constants: { Side: { LEFT: 'left', RIGHT: 'right' } }
  }
]
