import type { NamespaceSpec } from '../namespaces'

const RESOURCE_TYPE = {
  MAIN_FRAME: 'main_frame',
  SUB_FRAME: 'sub_frame',
  STYLESHEET: 'stylesheet',
  SCRIPT: 'script',
  IMAGE: 'image',
  FONT: 'font',
  OBJECT: 'object',
  XMLHTTPREQUEST: 'xmlhttprequest',
  PING: 'ping',
  CSP_REPORT: 'csp_report',
  MEDIA: 'media',
  WEBSOCKET: 'websocket',
  WEBTRANSPORT: 'webtransport',
  WEBBUNDLE: 'webbundle',
  OTHER: 'other'
}

/**
 * declarativeNetRequest and webRequest. Both replace Electron's objects: its native
 * declarativeNetRequest stops matching once the app has any webRequest listener, and its
 * webRequest events never fire. webRequest's events are set up by installWebRequestEvents
 * (custom/network.ts), which validates filters and trims details to each listener's extraInfoSpec.
 */
export const NETWORK_SPECS: NamespaceSpec[] = [
  {
    name: 'declarativeNetRequest',
    permissions: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback'],
    replace: true,
    methods: [
      'updateDynamicRules',
      'getDynamicRules',
      'updateSessionRules',
      'getSessionRules',
      'updateEnabledRulesets',
      'getEnabledRulesets',
      'updateStaticRules',
      'getDisabledRuleIds',
      'getAvailableStaticRuleCount',
      'getMatchedRules',
      'isRegexSupported',
      'setExtensionActionOptions',
      'testMatchOutcome'
    ],
    events: ['onRuleMatchedDebug'],
    constants: {
      DYNAMIC_RULESET_ID: '_dynamic',
      SESSION_RULESET_ID: '_session',
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      RuleActionType: {
        BLOCK: 'block',
        REDIRECT: 'redirect',
        ALLOW: 'allow',
        UPGRADE_SCHEME: 'upgradeScheme',
        MODIFY_HEADERS: 'modifyHeaders',
        ALLOW_ALL_REQUESTS: 'allowAllRequests'
      },
      ResourceType: RESOURCE_TYPE,
      RequestMethod: {
        CONNECT: 'connect',
        DELETE: 'delete',
        GET: 'get',
        HEAD: 'head',
        OPTIONS: 'options',
        PATCH: 'patch',
        POST: 'post',
        PUT: 'put',
        OTHER: 'other'
      },
      DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
      HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
      UnsupportedRegexReason: { SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' },
      RuleConditionKeys: {
        URL_FILTER: 'urlFilter',
        REGEX_FILTER: 'regexFilter',
        IS_URL_FILTER_CASE_SENSITIVE: 'isUrlFilterCaseSensitive',
        INITIATOR_DOMAINS: 'initiatorDomains',
        EXCLUDED_INITIATOR_DOMAINS: 'excludedInitiatorDomains',
        REQUEST_DOMAINS: 'requestDomains',
        EXCLUDED_REQUEST_DOMAINS: 'excludedRequestDomains',
        TOP_DOMAINS: 'topDomains',
        EXCLUDED_TOP_DOMAINS: 'excludedTopDomains',
        DOMAINS: 'domains',
        EXCLUDED_DOMAINS: 'excludedDomains',
        RESOURCE_TYPES: 'resourceTypes',
        EXCLUDED_RESOURCE_TYPES: 'excludedResourceTypes',
        REQUEST_METHODS: 'requestMethods',
        EXCLUDED_REQUEST_METHODS: 'excludedRequestMethods',
        DOMAIN_TYPE: 'domainType',
        TAB_IDS: 'tabIds',
        EXCLUDED_TAB_IDS: 'excludedTabIds',
        RESPONSE_HEADERS: 'responseHeaders',
        EXCLUDED_RESPONSE_HEADERS: 'excludedResponseHeaders'
      }
    }
  },
  {
    name: 'webRequest',
    permissions: ['webRequest'],
    replace: true,
    methods: ['handlerBehaviorChanged'],
    constants: {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      ResourceType: RESOURCE_TYPE,
      IgnoredActionType: {
        REDIRECT: 'redirect',
        REQUEST_HEADERS: 'request_headers',
        RESPONSE_HEADERS: 'response_headers',
        AUTH_CREDENTIALS: 'auth_credentials'
      },
      OnBeforeRequestOptions: { BLOCKING: 'blocking', REQUEST_BODY: 'requestBody', EXTRA_HEADERS: 'extraHeaders' },
      OnBeforeSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', BLOCKING: 'blocking', EXTRA_HEADERS: 'extraHeaders' },
      OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnHeadersReceivedOptions: {
        BLOCKING: 'blocking',
        RESPONSE_HEADERS: 'responseHeaders',
        EXTRA_HEADERS: 'extraHeaders',
        SECURITY_INFO: 'securityInfo',
        SECURITY_INFO_RAW_DER: 'securityInfoRawDer'
      },
      OnAuthRequiredOptions: { RESPONSE_HEADERS: 'responseHeaders', BLOCKING: 'blocking', ASYNC_BLOCKING: 'asyncBlocking', EXTRA_HEADERS: 'extraHeaders' },
      OnResponseStartedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnBeforeRedirectOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnCompletedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnErrorOccurredOptions: { EXTRA_HEADERS: 'extraHeaders' }
    }
  }
]
