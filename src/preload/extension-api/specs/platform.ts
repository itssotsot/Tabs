import type { NamespaceSpec } from '../namespaces'

/**
 * permissions, notifications, cookies, webNavigation, browsingData, contentSettings, privacy,
 * proxy, fontSettings, tts and system.*. ChromeSetting and ContentSetting objects (privacy.*,
 * proxy.settings, contentSettings.*) and tts.speak come from custom/platform.ts.
 */

const LEVEL_OF_CONTROL = {
  NOT_CONTROLLABLE: 'not_controllable',
  CONTROLLED_BY_OTHER_EXTENSIONS: 'controlled_by_other_extensions',
  CONTROLLABLE_BY_THIS_EXTENSION: 'controllable_by_this_extension',
  CONTROLLED_BY_THIS_EXTENSION: 'controlled_by_this_extension'
}

export const PLATFORM_SPECS: NamespaceSpec[] = [
  {
    // Electron has no chrome.permissions; extensions like Dark Reader need it.
    name: 'permissions',
    methods: ['contains', 'getAll', 'request', 'remove', 'addHostAccessRequest', 'removeHostAccessRequest'],
    events: ['onAdded', 'onRemoved']
  },
  {
    name: 'notifications',
    permissions: ['notifications'],
    methods: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'],
    events: ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged', 'onShowSettings'],
    constants: {
      TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' },
      PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' }
    }
  },
  {
    name: 'cookies',
    permissions: ['cookies'],
    methods: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores', 'getPartitionKey'],
    events: ['onChanged'],
    constants: {
      SameSiteStatus: { NO_RESTRICTION: 'no_restriction', LAX: 'lax', STRICT: 'strict', UNSPECIFIED: 'unspecified' },
      OnChangedCause: { EVICTED: 'evicted', EXPIRED: 'expired', EXPLICIT: 'explicit', EXPIRED_OVERWRITE: 'expired_overwrite', OVERWRITE: 'overwrite' }
    }
  },
  {
    name: 'webNavigation',
    permissions: ['webNavigation'],
    methods: ['getFrame', 'getAllFrames'],
    events: [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onErrorOccurred',
      'onCreatedNavigationTarget',
      'onReferenceFragmentUpdated',
      'onHistoryStateUpdated',
      'onTabReplaced'
    ],
    constants: {
      TransitionType: {
        LINK: 'link',
        TYPED: 'typed',
        AUTO_BOOKMARK: 'auto_bookmark',
        AUTO_SUBFRAME: 'auto_subframe',
        MANUAL_SUBFRAME: 'manual_subframe',
        GENERATED: 'generated',
        START_PAGE: 'start_page',
        FORM_SUBMIT: 'form_submit',
        RELOAD: 'reload',
        KEYWORD: 'keyword',
        KEYWORD_GENERATED: 'keyword_generated'
      },
      TransitionQualifier: {
        CLIENT_REDIRECT: 'client_redirect',
        SERVER_REDIRECT: 'server_redirect',
        FORWARD_BACK: 'forward_back',
        FROM_ADDRESS_BAR: 'from_address_bar'
      }
    }
  },
  {
    name: 'browsingData',
    permissions: ['browsingData'],
    methods: [
      'settings',
      'remove',
      'removeAppcache',
      'removeCache',
      'removeCacheStorage',
      'removeCookies',
      'removeDownloads',
      'removeFileSystems',
      'removeFormData',
      'removeHistory',
      'removeIndexedDB',
      'removeLocalStorage',
      'removePasswords',
      'removePluginData',
      'removeServiceWorkers',
      'removeWebSQL'
    ]
  },
  {
    name: 'contentSettings',
    permissions: ['contentSettings'],
    constants: {
      Scope: { REGULAR: 'regular', INCOGNITO_SESSION_ONLY: 'incognito_session_only' },
      CookiesContentSetting: { ALLOW: 'allow', BLOCK: 'block', SESSION_ONLY: 'session_only' },
      ImagesContentSetting: { ALLOW: 'allow', BLOCK: 'block' },
      JavascriptContentSetting: { ALLOW: 'allow', BLOCK: 'block' },
      LocationContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' },
      PluginsContentSetting: { BLOCK: 'block' },
      PopupsContentSetting: { ALLOW: 'allow', BLOCK: 'block' },
      NotificationsContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' },
      FullscreenContentSetting: { ALLOW: 'allow' },
      MouselockContentSetting: { ALLOW: 'allow' },
      MicrophoneContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' },
      CameraContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' },
      PpapiBrokerContentSetting: { BLOCK: 'block' },
      MultipleAutomaticDownloadsContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' },
      AutoVerifyContentSetting: { ALLOW: 'allow', BLOCK: 'block' },
      ClipboardContentSetting: { ALLOW: 'allow', BLOCK: 'block', ASK: 'ask' }
    }
  },
  {
    name: 'privacy',
    permissions: ['privacy'],
    constants: {
      IPHandlingPolicy: {
        DEFAULT: 'default',
        DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: 'default_public_and_private_interfaces',
        DEFAULT_PUBLIC_INTERFACE_ONLY: 'default_public_interface_only',
        DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp'
      }
    }
  },
  {
    name: 'proxy',
    permissions: ['proxy'],
    events: ['onProxyError'],
    constants: {
      Mode: { DIRECT: 'direct', AUTO_DETECT: 'auto_detect', PAC_SCRIPT: 'pac_script', FIXED_SERVERS: 'fixed_servers', SYSTEM: 'system' },
      Scheme: { HTTP: 'http', HTTPS: 'https', QUIC: 'quic', SOCKS4: 'socks4', SOCKS5: 'socks5' }
    }
  },
  {
    name: 'types',
    constants: {
      ChromeSettingScope: {
        REGULAR: 'regular',
        REGULAR_ONLY: 'regular_only',
        INCOGNITO_PERSISTENT: 'incognito_persistent',
        INCOGNITO_SESSION_ONLY: 'incognito_session_only'
      },
      LevelOfControl: LEVEL_OF_CONTROL
    }
  },
  {
    name: 'fontSettings',
    permissions: ['fontSettings'],
    methods: [
      'getFont',
      'setFont',
      'clearFont',
      'getFontList',
      'getDefaultFontSize',
      'setDefaultFontSize',
      'clearDefaultFontSize',
      'getDefaultFixedFontSize',
      'setDefaultFixedFontSize',
      'clearDefaultFixedFontSize',
      'getMinimumFontSize',
      'setMinimumFontSize',
      'clearMinimumFontSize'
    ],
    events: ['onFontChanged', 'onDefaultFontSizeChanged', 'onDefaultFixedFontSizeChanged', 'onMinimumFontSizeChanged'],
    constants: {
      GenericFamily: { STANDARD: 'standard', SANSSERIF: 'sansserif', SERIF: 'serif', FIXED: 'fixed', CURSIVE: 'cursive', FANTASY: 'fantasy', MATH: 'math' },
      LevelOfControl: LEVEL_OF_CONTROL
    }
  },
  {
    // speak comes from installTtsSpeak (its onEvent callback can't cross to the main process).
    name: 'tts',
    permissions: ['tts'],
    methods: ['stop', 'pause', 'resume', 'isSpeaking', 'getVoices'],
    events: ['onVoicesChanged'],
    constants: {
      EventType: {
        START: 'start',
        END: 'end',
        WORD: 'word',
        SENTENCE: 'sentence',
        MARKER: 'marker',
        INTERRUPTED: 'interrupted',
        CANCELLED: 'cancelled',
        ERROR: 'error',
        PAUSE: 'pause',
        RESUME: 'resume'
      },
      VoiceGender: { MALE: 'male', FEMALE: 'female' }
    }
  },
  { name: 'system.cpu', permissions: ['system.cpu'], methods: ['getInfo'] },
  { name: 'system.memory', permissions: ['system.memory'], methods: ['getInfo'] },
  {
    name: 'system.storage',
    permissions: ['system.storage'],
    methods: ['getInfo', 'ejectDevice', 'getAvailableCapacity'],
    events: ['onAttached', 'onDetached'],
    constants: {
      StorageUnitType: { FIXED: 'fixed', REMOVABLE: 'removable', UNKNOWN: 'unknown' },
      EjectDeviceResultCode: { SUCCESS: 'success', IN_USE: 'in_use', NO_SUCH_DEVICE: 'no_such_device', FAILURE: 'failure' }
    }
  },
  {
    name: 'system.display',
    permissions: ['system.display'],
    methods: [
      'getInfo',
      'getDisplayLayout',
      'setDisplayProperties',
      'setDisplayLayout',
      'enableUnifiedDesktop',
      'overscanCalibrationStart',
      'overscanCalibrationAdjust',
      'overscanCalibrationReset',
      'overscanCalibrationComplete',
      'showNativeTouchCalibration',
      'startCustomTouchCalibration',
      'completeCustomTouchCalibration',
      'clearTouchCalibration',
      'setMirrorMode'
    ],
    events: ['onDisplayChanged'],
    constants: {
      LayoutPosition: { TOP: 'top', RIGHT: 'right', BOTTOM: 'bottom', LEFT: 'left' },
      MirrorMode: { OFF: 'off', NORMAL: 'normal', MIXED: 'mixed' },
      ActiveState: { ACTIVE: 'active', INACTIVE: 'inactive' }
    }
  }
]
