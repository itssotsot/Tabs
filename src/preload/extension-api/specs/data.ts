import type { NamespaceSpec } from '../namespaces'

/**
 * downloads, history, bookmarks, topSites, sessions, readingList, search, tabGroups, omnibox,
 * identity, management. storage.sync and native messaging are custom installers (custom/data.ts).
 */
export const DATA_SPECS: NamespaceSpec[] = [
  {
    // Electron doesn't know the permission, so there's no native object.
    name: 'downloads',
    permissions: ['downloads'],
    methods: [
      'download',
      'search',
      'pause',
      'resume',
      'cancel',
      'getFileIcon',
      'open',
      'show',
      'showDefaultFolder',
      'erase',
      'removeFile',
      'acceptDanger',
      'drag',
      'setShelfEnabled',
      'setUiOptions'
    ],
    events: ['onCreated', 'onErased', 'onChanged', { name: 'onDeterminingFilename', response: true }],
    constants: {
      FilenameConflictAction: { UNIQUIFY: 'uniquify', OVERWRITE: 'overwrite', PROMPT: 'prompt' },
      HttpMethod: { GET: 'GET', POST: 'POST' },
      State: { IN_PROGRESS: 'in_progress', INTERRUPTED: 'interrupted', COMPLETE: 'complete' },
      DangerType: {
        FILE: 'file',
        URL: 'url',
        CONTENT: 'content',
        UNCOMMON: 'uncommon',
        HOST: 'host',
        UNWANTED: 'unwanted',
        SAFE: 'safe',
        ACCEPTED: 'accepted',
        ALLOWLISTED_BY_POLICY: 'allowlistedByPolicy',
        ASYNC_SCANNING: 'asyncScanning',
        ASYNC_LOCAL_PASSWORD_SCANNING: 'asyncLocalPasswordScanning',
        PASSWORD_PROTECTED: 'passwordProtected',
        BLOCKED_TOO_LARGE: 'blockedTooLarge',
        SENSITIVE_CONTENT_WARNING: 'sensitiveContentWarning',
        SENSITIVE_CONTENT_BLOCK: 'sensitiveContentBlock',
        DEEP_SCANNED_FAILED: 'deepScannedFailed',
        DEEP_SCANNED_SAFE: 'deepScannedSafe',
        DEEP_SCANNED_OPENED_DANGEROUS: 'deepScannedOpenedDangerous',
        PROMPT_FOR_SCANNING: 'promptForScanning',
        PROMPT_FOR_LOCAL_PASSWORD_SCANNING: 'promptForLocalPasswordScanning',
        ACCOUNT_COMPROMISE: 'accountCompromise',
        BLOCKED_SCAN_FAILED: 'blockedScanFailed'
      },
      InterruptReason: {
        FILE_FAILED: 'FILE_FAILED',
        FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
        FILE_NO_SPACE: 'FILE_NO_SPACE',
        FILE_NAME_TOO_LONG: 'FILE_NAME_TOO_LONG',
        FILE_TOO_LARGE: 'FILE_TOO_LARGE',
        FILE_VIRUS_INFECTED: 'FILE_VIRUS_INFECTED',
        FILE_TRANSIENT_ERROR: 'FILE_TRANSIENT_ERROR',
        FILE_BLOCKED: 'FILE_BLOCKED',
        FILE_SECURITY_CHECK_FAILED: 'FILE_SECURITY_CHECK_FAILED',
        FILE_TOO_SHORT: 'FILE_TOO_SHORT',
        FILE_HASH_MISMATCH: 'FILE_HASH_MISMATCH',
        FILE_SAME_AS_SOURCE: 'FILE_SAME_AS_SOURCE',
        NETWORK_FAILED: 'NETWORK_FAILED',
        NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
        NETWORK_DISCONNECTED: 'NETWORK_DISCONNECTED',
        NETWORK_SERVER_DOWN: 'NETWORK_SERVER_DOWN',
        NETWORK_INVALID_REQUEST: 'NETWORK_INVALID_REQUEST',
        SERVER_FAILED: 'SERVER_FAILED',
        SERVER_NO_RANGE: 'SERVER_NO_RANGE',
        SERVER_BAD_CONTENT: 'SERVER_BAD_CONTENT',
        SERVER_UNAUTHORIZED: 'SERVER_UNAUTHORIZED',
        SERVER_CERT_PROBLEM: 'SERVER_CERT_PROBLEM',
        SERVER_FORBIDDEN: 'SERVER_FORBIDDEN',
        SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
        SERVER_CONTENT_LENGTH_MISMATCH: 'SERVER_CONTENT_LENGTH_MISMATCH',
        SERVER_CROSS_ORIGIN_REDIRECT: 'SERVER_CROSS_ORIGIN_REDIRECT',
        USER_CANCELED: 'USER_CANCELED',
        USER_SHUTDOWN: 'USER_SHUTDOWN',
        CRASH: 'CRASH'
      }
    }
  },
  {
    name: 'history',
    permissions: ['history'],
    methods: ['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll'],
    events: ['onVisited', 'onVisitRemoved'],
    constants: {
      TransitionType: {
        LINK: 'link',
        TYPED: 'typed',
        AUTO_BOOKMARK: 'auto_bookmark',
        AUTO_SUBFRAME: 'auto_subframe',
        MANUAL_SUBFRAME: 'manual_subframe',
        GENERATED: 'generated',
        AUTO_TOPLEVEL: 'auto_toplevel',
        FORM_SUBMIT: 'form_submit',
        RELOAD: 'reload',
        KEYWORD: 'keyword',
        KEYWORD_GENERATED: 'keyword_generated'
      }
    }
  },
  {
    name: 'bookmarks',
    permissions: ['bookmarks'],
    methods: ['get', 'getChildren', 'getRecent', 'getTree', 'getSubTree', 'search', 'create', 'move', 'update', 'remove', 'removeTree'],
    events: ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'],
    constants: {
      MAX_WRITE_OPERATIONS_PER_HOUR: 1_000_000,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000,
      BookmarkTreeNodeUnmodifiable: { MANAGED: 'managed' },
      FolderType: { BOOKMARKS_BAR: 'bookmarks-bar', OTHER: 'other', MOBILE: 'mobile', MANAGED: 'managed' }
    }
  },
  {
    name: 'topSites',
    permissions: ['topSites'],
    methods: ['get']
  },
  {
    name: 'sessions',
    permissions: ['sessions'],
    methods: ['getRecentlyClosed', 'getDevices', 'restore'],
    events: ['onChanged'],
    constants: { MAX_SESSION_RESULTS: 25 }
  },
  {
    name: 'readingList',
    permissions: ['readingList'],
    methods: ['addEntry', 'removeEntry', 'updateEntry', 'query'],
    events: ['onEntryAdded', 'onEntryRemoved', 'onEntryUpdated']
  },
  {
    name: 'search',
    permissions: ['search'],
    methods: ['query'],
    constants: { Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' } }
  },
  {
    name: 'tabGroups',
    permissions: ['tabGroups'],
    methods: ['get', 'query', 'update', 'move'],
    events: ['onCreated', 'onUpdated', 'onMoved', 'onRemoved'],
    constants: {
      TAB_GROUP_ID_NONE: -1,
      Color: {
        GREY: 'grey',
        BLUE: 'blue',
        RED: 'red',
        YELLOW: 'yellow',
        GREEN: 'green',
        PINK: 'pink',
        PURPLE: 'purple',
        CYAN: 'cyan',
        ORANGE: 'orange'
      }
    }
  },
  {
    // onInputChanged's suggest callback is set up by installOmniboxSuggest (custom/data.ts).
    name: 'omnibox',
    manifestKey: 'omnibox',
    methods: ['setDefaultSuggestion'],
    events: ['onInputStarted', { name: 'onInputChanged', response: true }, 'onInputEntered', 'onInputCancelled', 'onDeleteSuggestion'],
    constants: {
      OnInputEnteredDisposition: { CURRENT_TAB: 'currentTab', NEW_FOREGROUND_TAB: 'newForegroundTab', NEW_BACKGROUND_TAB: 'newBackgroundTab' },
      DescriptionStyleType: { URL: 'url', MATCH: 'match', DIM: 'dim' }
    }
  },
  {
    // getRedirectURL returns a string right away, so it's added by installIdentity (custom/data.ts).
    name: 'identity',
    permissions: ['identity'],
    methods: ['launchWebAuthFlow', 'getAuthToken', 'getProfileUserInfo', 'getAccounts', 'removeCachedAuthToken', 'clearAllCachedAuthTokens'],
    events: ['onSignInChanged'],
    constants: { AccountStatus: { SYNC: 'SYNC', ANY: 'ANY' } }
  },
  {
    // Every extension has these three (Electron has getSelf and getPermissionWarningsByManifest already).
    name: 'management',
    methods: ['getSelf', 'uninstallSelf', 'getPermissionWarningsByManifest'],
    keepNative: ['getSelf', 'getPermissionWarningsByManifest'],
    constants: {
      ExtensionType: {
        EXTENSION: 'extension',
        HOSTED_APP: 'hosted_app',
        PACKAGED_APP: 'packaged_app',
        LEGACY_PACKAGED_APP: 'legacy_packaged_app',
        THEME: 'theme',
        LOGIN_SCREEN_EXTENSION: 'login_screen_extension'
      },
      ExtensionInstallType: { ADMIN: 'admin', DEVELOPMENT: 'development', NORMAL: 'normal', SIDELOAD: 'sideload', OTHER: 'other' },
      ExtensionDisabledReason: { UNKNOWN: 'unknown', PERMISSIONS_INCREASE: 'permissions_increase' },
      LaunchType: {
        OPEN_AS_REGULAR_TAB: 'OPEN_AS_REGULAR_TAB',
        OPEN_AS_PINNED_TAB: 'OPEN_AS_PINNED_TAB',
        OPEN_AS_WINDOW: 'OPEN_AS_WINDOW',
        OPEN_FULL_SCREEN: 'OPEN_FULL_SCREEN'
      }
    }
  },
  {
    name: 'management',
    permissions: ['management'],
    methods: [
      'getAll',
      'get',
      'setEnabled',
      'uninstall',
      'getPermissionWarningsById',
      'launchApp',
      'createAppShortcut',
      'setLaunchType',
      'generateAppForLink'
    ],
    events: ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']
  }
]
